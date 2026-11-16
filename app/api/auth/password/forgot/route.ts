import { handle, ok, readJson } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { forgotPasswordSchema } from "@/lib/validation";
import { appendLoginChallengeCookie, cancelPendingLogin, deliverCode, startResetChallenge } from "@/lib/auth/login-challenge";
import { runAfterResponse } from "@/lib/after-response";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

// A reset request is cheap for us but must not become a way to spam a mailbox.
// Two buckets: per client address, and per (HMAC-hashed) email. The email is
// never stored in the clear — see lib/rate-limit.ts.
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_PER_IP = 10;
const FORGOT_MAX_PER_EMAIL = 3;

/**
 * Starts a password reset with an emailed six-digit code. The answer is deliberately identical for an
 * active account, an unknown address and an inactive account: every request gets a pending reset code
 * (its own cookie and timings), so the endpoint cannot be used to enumerate users. Only an active
 * account's code is real and emailed, after the response; any other is a decoy that can never match.
 * Asking again (within the limits) sends a new code. The new password is set with
 * `POST /api/auth/password/reset`.
 */
export async function POST(request: Request) {
  return handle(async () => {
    await enforceRateLimit({
      key: `forgot:ip:${getClientIp(request)}`,
      limit: FORGOT_MAX_PER_IP,
      windowMs: FORGOT_WINDOW_MS,
    });

    const { email } = forgotPasswordSchema.parse(await readJson(request));

    await enforceRateLimit({
      key: `forgot:email:${email}`,
      limit: FORGOT_MAX_PER_EMAIL,
      windowMs: FORGOT_WINDOW_MS,
    });

    await dbConnect();
    const user = await User.findOne({ email }).select("+passwordHash");
    const account = user && user.active ? user : null;
    await recordSecurityEvent({
      type: "password_reset_requested",
      userId: account?._id,
      email,
      request,
    });

    const started = await startResetChallenge(
      account
        ? { _id: account._id, email: account.email, name: account.name, passwordHash: account.passwordHash, tokenVersion: account.tokenVersion, deviceTrustVersion: account.deviceTrustVersion }
        : null,
    );
    if (account) {
      // A provider failure must not turn this into an account-existence oracle, and no provider
      // detail may reach the client. Log a PII-free line only.
      const recipient = { email: account.email, name: account.name };
      runAfterResponse(async () => {
        try {
          await deliverCode(recipient, started.code, "reset");
        } catch (error) {
          // A code nobody received must not stay usable.
          await cancelPendingLogin({ _id: started.tokenId }).catch(() => undefined);
          throw error;
        }
      }, {
        operation: "password_reset",
        onError: () => console.error("[forgot-password] reset code could not be sent"),
      });
    }

    return appendLoginChallengeCookie(ok(started.view), started.rawChallenge, "reset");
  });
}
