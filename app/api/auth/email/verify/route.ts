import { recordSecurityEvent } from "@/lib/security-events";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyEmailSchema } from "@/lib/validation";
import { consumeActionToken, peekActionTokenUser } from "@/lib/auth/action-tokens";
import { spendPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { User } from "@/models/User";
import { AuthToken } from "@/models/AuthToken";

// Verification is a public endpoint (the link may be opened while signed out).
// A generous per-IP cap stops token-probing spam without affecting real users.
const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX_PER_IP = 20;

// Every failure mode returns this same response so a caller cannot tell an
// unknown token from an expired, reused or wrong-type one.
const INVALID_TOKEN_MESSAGE = "This link has expired or the password is not right. Check your password, or log in to get a new link.";

export async function POST(request: Request) {
  return handle(async () => {
    await enforceRateLimit({
      key: `verify-email:ip:${getClientIp(request)}`,
      limit: VERIFY_MAX_PER_IP,
      windowMs: VERIFY_WINDOW_MS,
    });

    const { token, password } = verifyEmailSchema.parse(await readJson(request));
    await dbConnect();

    // The link alone is not enough: someone may have registered another person's
    // address, and that person's click must not hand the account over. A wrong
    // password leaves the link usable.
    const tokenUser = await peekActionTokenUser(token, "email_verification");
    const candidate = tokenUser ? await User.findById(tokenUser).select("+passwordHash active") : null;
    if (candidate?.passwordHash) {
      if (!(await verifyPassword(password, candidate.passwordHash))) {
        await recordSecurityEvent({ type: "email_verification_failed", reason: "wrong_password", userId: candidate._id, request });
        throw new HttpError(400, INVALID_TOKEN_MESSAGE, "invalid_token");
      }
    } else {
      await spendPasswordCheck(password);
    }

    // Atomic single-use consumption: exactly one concurrent request can win.
    const consumed = await consumeActionToken(token, "email_verification");
    if (!consumed.ok) {
      await recordSecurityEvent({ type: "email_verification_failed", reason: "invalid_token", request });
      throw new HttpError(400, INVALID_TOKEN_MESSAGE, "invalid_token");
    }

    // Only ever verify the token's own user, and only while the account exists
    // and is active. The conditional update makes a concurrent deactivation
    // safe: if the account is no longer active, nothing is written.
    const now = new Date();
    const user = await User.findOneAndUpdate(
      { _id: consumed.token.user, active: true },
      { $set: { emailVerifiedAt: now } },
      { new: true },
    );
    if (!user) {
      await recordSecurityEvent({ type: "email_verification_failed", reason: "inactive_account", userId: consumed.token.user, request });
      throw new HttpError(400, INVALID_TOKEN_MESSAGE, "invalid_token");
    }

    // Any other outstanding verification tokens are now unnecessary.
    await AuthToken.updateMany(
      { user: user._id, type: "email_verification", usedAt: null },
      { $set: { usedAt: now } },
    );

    // The password was just checked, so the owner goes straight to the dashboard.
    await createSession({ userId: user._id.toString(), platformRole: user.platformRole, tokenVersion: user.tokenVersion });

    return ok({ verified: true });
  });
}
