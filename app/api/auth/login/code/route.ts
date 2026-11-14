import { handle, ok, readJson, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { loginCodeSchema } from "@/lib/validation";
import { createSession } from "@/lib/auth/session";
import { appendPlatformDeviceCookie, platformCredentialFingerprint, signPlatformDevice } from "@/lib/auth/platform-device";
import {
  cancelPendingLogin,
  checkLoginCode,
  clearLoginChallengeCookie,
  pendingLoginMatchesAccount,
  readLoginChallengeCookie,
  readPendingLogin,
} from "@/lib/auth/login-challenge";
import {
  LOGIN_CODE_EXPIRED,
  LOGIN_CODE_LOCKED,
  LOGIN_CODE_VERIFY_PER_SOURCE,
  LOGIN_CODE_WINDOW_MS,
  LOGIN_EXPIRED,
  reserveAccountCodeGuess,
} from "@/lib/auth/login-code-limits";
import { rateLimitSourceKey } from "@/lib/client-address";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/security-events";
import { User } from "@/models/User";

/**
 * Finishes a new-device sign-in (lib/auth/login-challenge.ts). The pending sign-in comes only from
 * its httpOnly cookie, never from the body, so a code can only finish the sign-in it was sent for,
 * in the browser that entered the password. Only here, after a right code, are the session and the
 * known-device marker created. The answers can name the problem (wrong, expired, too many tries):
 * only someone who already entered the right password holds the cookie.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const source = rateLimitSourceKey(getClientIp(request));
    await enforceRateLimit({ key: `login-code:verify:source:${source}`, limit: LOGIN_CODE_VERIFY_PER_SOURCE, windowMs: LOGIN_CODE_WINDOW_MS });

    const { code } = loginCodeSchema.parse(await readJson(request));
    await dbConnect();

    const pending = await readPendingLogin(readLoginChallengeCookie(request));
    if (!pending) throw new HttpError(400, LOGIN_EXPIRED, "login_expired");

    // The account must still be the one whose password was checked (same password, same device-trust
    // generation, no sign-out, still active and confirmed). Checked before any guess is compared. A
    // change after this read leaves the session and marker below already outdated, so it cannot help.
    const user = await User.findById(pending.user).select("+passwordHash");
    if (!user || !pendingLoginMatchesAccount(pending, user)) {
      await cancelPendingLogin(pending).catch(() => undefined);
      await recordSecurityEvent({ type: "login_code_failed", reason: "account_changed", userId: pending.user, email: user?.email, request });
      throw new HttpError(400, LOGIN_EXPIRED, "login_expired");
    }

    // The account's daily wrong-code budget, across all its pending sign-ins (429 when used up).
    const returnGuess = await reserveAccountCodeGuess(user._id.toString());
    const result = await checkLoginCode(pending, code);
    if (result.ok || !result.counted) {
      // Only a wrong code that was really compared keeps its unit.
      await returnGuess().catch(() => console.warn("[login-code] a rate-limit unit could not be returned"));
    }

    if (!result.ok) {
      const failure = { type: "login_code_failed" as const, userId: user._id, email: user.email, request };
      switch (result.reason) {
        case "wrong_code": {
          if (result.counted) await recordSecurityEvent({ ...failure, reason: "wrong_code" });
          const left = result.attemptsRemaining;
          const message = `That code is not right. You have ${left} ${left === 1 ? "try" : "tries"} left.`;
          throw new HttpError(400, message, "code_invalid", undefined, { code: message });
        }
        case "expired_code":
          await recordSecurityEvent({ ...failure, reason: "expired_code" });
          throw new HttpError(400, LOGIN_CODE_EXPIRED, "code_expired");
        case "too_many_attempts":
          await recordSecurityEvent({ ...failure, reason: "too_many_attempts" });
          throw new HttpError(429, LOGIN_CODE_LOCKED, "code_attempts_exceeded");
        default:
          throw new HttpError(400, LOGIN_EXPIRED, "login_expired");
      }
    }

    if (user.platformRole === "super_admin") {
      await recordSecurityEvent({ type: "admin_login", userId: user._id, request });
    }

    await createSession({
      userId: user._id.toString(),
      platformRole: user.platformRole,
      tokenVersion: user.tokenVersion,
    });

    // This browser is now a known device of the account, through the existing marker only.
    const deviceToken = await signPlatformDevice({
      deviceId: pending.deviceId,
      email: user.email,
      credential: platformCredentialFingerprint(user.passwordHash, user.deviceTrustVersion),
    });
    return clearLoginChallengeCookie(appendPlatformDeviceCookie(ok({ user: user.toJSON() }), deviceToken));
  });
}
