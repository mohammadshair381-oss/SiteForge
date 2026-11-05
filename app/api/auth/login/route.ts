import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import { spendPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { isEmailVerified } from "@/lib/auth/guards";
import { issueEmailVerification } from "@/lib/auth/email-verification";
import { runAfterResponse } from "@/lib/after-response";
import { checkRateLimit, enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_IP = 10;
const LOGIN_MAX_PER_EMAIL_AND_IP = 5;
const LOGIN_MAX_PER_EMAIL = 50;
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const RESEND_MAX_PER_EMAIL = 3;

// One answer for a wrong password, an unknown address and an unconfirmed account:
// otherwise registering an address and then logging in would reveal whether it was
// already taken.
const INVALID_CREDENTIALS = "That email and password did not work. If you have just registered, confirm your email first: we have sent you a link.";

export async function POST(request: Request) {
  return handle(async () => {
    // Throttle by IP before doing any expensive work.
    await enforceRateLimit({
      key: `login:ip:${getClientIp(request)}`,
      limit: LOGIN_MAX_PER_IP,
      windowMs: LOGIN_WINDOW_MS,
    });

    const body = loginSchema.parse(await readJson(request));

    // Per (account, source): one source cannot spend the budget of a person who is
    // signing in from somewhere else, which would lock them out.
    await enforceRateLimit({
      key: `login:email-ip:${body.email}:${getClientIp(request)}`,
      limit: LOGIN_MAX_PER_EMAIL_AND_IP,
      windowMs: LOGIN_WINDOW_MS,
    });
    // A wider bucket per account, to slow credential stuffing from rotating IPs.
    await enforceRateLimit({
      key: `login:email:${body.email}`,
      limit: LOGIN_MAX_PER_EMAIL,
      windowMs: LOGIN_WINDOW_MS,
    });

    await dbConnect();

    const user = await User.findOne({ email: body.email }).select("+passwordHash");
    // Failures are recorded (no password, digest of the email only) after the
    // rate limiters, which bounds the number of events one source can create.
    if (!user || !user.active) {
      await spendPasswordCheck(body.password);
      await recordSecurityEvent({
        type: "login_failed",
        reason: user ? "inactive_account" : "unknown_account",
        userId: user?._id,
        email: body.email,
        request,
      });
      throw new HttpError(401, INVALID_CREDENTIALS, "invalid_credentials");
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      await recordSecurityEvent({ type: "login_failed", reason: "wrong_password", userId: user._id, email: body.email, request });
      throw new HttpError(401, INVALID_CREDENTIALS, "invalid_credentials");
    }

    if (!isEmailVerified(user)) {
      // The right password proves who is asking, so a fresh link can go out.
      await recordSecurityEvent({ type: "login_failed", reason: "unverified_account", userId: user._id, email: body.email, request });
      const account = { userId: user._id, to: user.email, name: user.name };
      runAfterResponse(
        async () => {
          if (await checkRateLimit({ key: `verify-resend:login:${body.email}`, limit: RESEND_MAX_PER_EMAIL, windowMs: RESEND_WINDOW_MS })) {
            await issueEmailVerification(account);
          }
        },
        { operation: "login_verification_resend", onError: () => console.error("[login] verification email could not be sent") },
      );
      throw new HttpError(401, INVALID_CREDENTIALS, "invalid_credentials");
    }

    if (user.platformRole === "super_admin") {
      await recordSecurityEvent({ type: "admin_login", userId: user._id, request });
    }

    await createSession({
      userId: user._id.toString(),
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    });

    return ok({ user: user.toJSON() });
  });
}
