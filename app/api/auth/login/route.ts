import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import { spendPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { rateLimitSourceKey } from "@/lib/client-address";
import { consumeRateLimit, enforceRateLimit, getClientIp, rateLimitedError, releaseRateLimit } from "@/lib/rate-limit";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_SOURCE = 10;
const LOGIN_MAX_FAILURES_PER_EMAIL_AND_SOURCE = 5;
const LOGIN_MAX_FAILURES_PER_EMAIL = 50;

// One answer for a wrong password and an unknown or inactive address, so it cannot reveal an account.
const INVALID_CREDENTIALS = "That email and password did not work.";

/**
 * Reserves one failed sign-in BEFORE the password check (atomic, so guesses at the same moment cannot
 * overshoot), and hands back how to return it after the right password. So only failures count, and
 * an address with no account spends and answers exactly the same. (account, source) first, then the
 * account-wide budget, which bounds guessing spread over many addresses; a source that is already
 * blocked never spends the account-wide budget.
 */
async function reserveLoginAttempt(source: string, email: string): Promise<() => Promise<void>> {
  const perSource = await consumeRateLimit({ key: `login:fail:email-source:${email}:${source}`, limit: LOGIN_MAX_FAILURES_PER_EMAIL_AND_SOURCE, windowMs: LOGIN_WINDOW_MS });
  if (!perSource.allowed) throw rateLimitedError(perSource.retryAfterMs);
  const perAccount = await consumeRateLimit({ key: `login:fail:email:${email}`, limit: LOGIN_MAX_FAILURES_PER_EMAIL, windowMs: LOGIN_WINDOW_MS });
  if (!perAccount.allowed) {
    await releaseRateLimit(perSource.bucketKey);
    throw rateLimitedError(perAccount.retryAfterMs);
  }
  return async () => {
    await Promise.all([releaseRateLimit(perSource.bucketKey), releaseRateLimit(perAccount.bucketKey)]);
  };
}

/**
 * Platform login with email and password. The right password signs in directly: there is no emailed
 * code (an owner decision; see docs/security-monitoring.md for what that means). The password limits
 * below still apply, and the answer is the same for a wrong password and an unknown or inactive
 * address.
 */
export async function POST(request: Request) {
  return handle(async () => {
    // One IPv4 address, or one IPv6 /64, so rotating addresses inside a /64 gives no new budget.
    const source = rateLimitSourceKey(getClientIp(request));
    // Throttle by source before doing any expensive work. Every attempt counts here.
    await enforceRateLimit({
      key: `login:source:${source}`,
      limit: LOGIN_MAX_PER_SOURCE,
      windowMs: LOGIN_WINDOW_MS,
    });

    const body = loginSchema.parse(await readJson(request));

    await dbConnect();
    const returnAttempt = await reserveLoginAttempt(source, body.email);

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

    // Not a failure. Returning it is best-effort: losing it must not stop a correct sign-in.
    await returnAttempt().catch(() => console.warn("[login] a rate-limit unit could not be returned"));

    // Addresses are no longer confirmed by email, so an account left unconfirmed by the earlier
    // code-based signup is treated like every other account from now on.
    if (user.emailVerifiedAt === null) {
      await User.updateOne({ _id: user._id, emailVerifiedAt: null }, { $unset: { emailVerifiedAt: "" } });
      user.emailVerifiedAt = undefined;
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
