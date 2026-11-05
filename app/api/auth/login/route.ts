import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { loginSchema } from "@/lib/validation";
import { spendPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { isEmailVerified } from "@/lib/auth/guards";
import { issueEmailVerification } from "@/lib/auth/email-verification";
import { appendPlatformDeviceCookie, newPlatformDeviceId, platformCredentialFingerprint, readPlatformDeviceCookie, signPlatformDevice, verifyPlatformDevice } from "@/lib/auth/platform-device";
import { runAfterResponse } from "@/lib/after-response";
import { rateLimitSourceKey } from "@/lib/client-address";
import { checkRateLimit, consumeRateLimit, enforceRateLimit, getClientIp, rateLimitedError, releaseRateLimit } from "@/lib/rate-limit";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_PER_SOURCE = 10;
const LOGIN_MAX_FAILURES_PER_EMAIL_AND_SOURCE = 5;
const LOGIN_MAX_FAILURES_PER_EMAIL = 50;
const LOGIN_DEVICE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES_PER_DEVICE = 5;
const RESEND_WINDOW_MS = 15 * 60 * 1000;
const RESEND_MAX_PER_EMAIL = 3;

// One answer for a wrong password, an unknown address and an unconfirmed account:
// otherwise registering an address and then logging in would reveal whether it was
// already taken.
const INVALID_CREDENTIALS = "That email and password did not work. If you have just registered, confirm your email first: we have sent you a link.";

/**
 * Reserves one failed sign-in BEFORE the password check (atomic, so guesses at the same moment cannot
 * overshoot), and hands back how to return it after a full success. So only failures count, and an
 * account with no such address spends and answers exactly the same.
 *
 * - A known device of this account uses only its own budget. People guessing from elsewhere cannot
 *   touch it, so they cannot lock the owner out of a browser the owner has already used.
 * - Anything else uses (account, source), then the account-wide budget, which is what bounds guessing
 *   spread over many addresses. A source that is already blocked never spends the account-wide budget.
 */
async function reserveLoginAttempt(source: string, email: string, deviceId: string | undefined): Promise<() => Promise<void>> {
  if (deviceId) {
    const perDevice = await consumeRateLimit({ key: `login:fail:device:${deviceId}`, limit: LOGIN_MAX_FAILURES_PER_DEVICE, windowMs: LOGIN_DEVICE_WINDOW_MS });
    if (!perDevice.allowed) throw rateLimitedError(perDevice.retryAfterMs);
    return () => releaseRateLimit(perDevice.bucketKey);
  }
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

    // A marker only chooses a failure budget. It never replaces the password check below.
    const device = await verifyPlatformDevice(readPlatformDeviceCookie(request), {
      email: body.email,
      currentCredential: async () => {
        const account = await User.findOne({ email: body.email }).select("+passwordHash");
        return account?.active ? platformCredentialFingerprint(account.passwordHash) : null;
      },
    });
    const returnAttempt = await reserveLoginAttempt(source, body.email, device?.deviceId);

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
      // Stays counted as a failure. Giving it back would make this answer, which must look like a
      // wrong password, the only one that never reaches a limit.
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

    // Not a failure. Returning it is best-effort: losing it must not stop a correct sign-in.
    await returnAttempt().catch(() => console.warn("[login] a rate-limit unit could not be returned"));

    if (user.platformRole === "super_admin") {
      await recordSecurityEvent({ type: "admin_login", userId: user._id, request });
    }

    await createSession({
      userId: user._id.toString(),
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    });

    // Refreshes (or creates) this browser's marker, bound to the password just verified.
    const deviceToken = await signPlatformDevice({
      deviceId: device?.deviceId ?? newPlatformDeviceId(),
      email: body.email,
      credential: platformCredentialFingerprint(user.passwordHash),
    });
    return appendPlatformDeviceCookie(ok({ user: user.toJSON() }), deviceToken);
  });
}
