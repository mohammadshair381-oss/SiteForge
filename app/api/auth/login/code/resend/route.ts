import { handle, ok, HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import {
  cancelPendingLogin,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_SENDS,
  LOGIN_CODE_RESEND_COOLDOWN_MS,
  LoginCodeDeliveryError,
  pendingLoginMatchesAccount,
  readLoginChallengeCookie,
  readPendingLogin,
  resendLoginCode,
} from "@/lib/auth/login-challenge";
import {
  assertAccountCodeBudget,
  LOGIN_CODE_LOCKED,
  LOGIN_CODE_NOT_SENT,
  LOGIN_CODE_RESEND_PER_SOURCE,
  LOGIN_CODE_SEND_WINDOW_MS,
  LOGIN_CODE_SENDS_PER_ACCOUNT,
  LOGIN_CODE_WINDOW_MS,
  LOGIN_EXPIRED,
} from "@/lib/auth/login-code-limits";
import { rateLimitSourceKey } from "@/lib/client-address";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { User } from "@/models/User";

const SEND_LIMIT = "You have asked for the most codes for this sign-in. Log in again to start over.";

function cooldownError(retryAfterMs: number): HttpError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new HttpError(429, `Wait ${seconds} second${seconds === 1 ? "" : "s"} before asking for another code.`, "resend_cooldown", { "Retry-After": String(seconds) });
}

/**
 * Emails a new code for the pending sign-in in this browser's cookie. The previous code stops
 * working at once. At most once a minute, 3 times per sign-in, and within the account's limit on
 * emailed codes. The body is ignored: nothing in it can choose the account or the sign-in.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const source = rateLimitSourceKey(getClientIp(request));
    await enforceRateLimit({ key: `login-code:resend:source:${source}`, limit: LOGIN_CODE_RESEND_PER_SOURCE, windowMs: LOGIN_CODE_WINDOW_MS });
    await dbConnect();

    const pending = await readPendingLogin(readLoginChallengeCookie(request));
    if (!pending) throw new HttpError(400, LOGIN_EXPIRED, "login_expired");

    // Refused requests do not spend the account's limit. A resend keeps the guesses already made, so
    // a pending sign-in that used all 5 gets no new code: logging in again starts a new one, and the
    // account's daily wrong-code budget bounds those.
    if (pending.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw new HttpError(429, LOGIN_CODE_LOCKED, "code_attempts_exceeded");
    if (pending.sends >= LOGIN_CODE_MAX_SENDS) throw new HttpError(429, SEND_LIMIT, "resend_limit");
    const waitMs = pending.lastSentAt.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS - Date.now();
    if (waitMs > 0) throw cooldownError(waitMs);

    const user = await User.findById(pending.user).select("+passwordHash");
    if (!user || !pendingLoginMatchesAccount(pending, user)) {
      await cancelPendingLogin(pending).catch(() => undefined);
      throw new HttpError(400, LOGIN_EXPIRED, "login_expired");
    }

    await assertAccountCodeBudget(user._id.toString());
    await enforceRateLimit({ key: `login-code:send:${user._id.toString()}`, limit: LOGIN_CODE_SENDS_PER_ACCOUNT, windowMs: LOGIN_CODE_SEND_WINDOW_MS });

    let result;
    try {
      result = await resendLoginCode(pending, { email: user.email, name: user.name });
    } catch (error) {
      if (error instanceof LoginCodeDeliveryError) throw new HttpError(503, LOGIN_CODE_NOT_SENT, "code_not_sent");
      throw error;
    }
    if (!result.ok) {
      if (result.reason === "attempts_exhausted") throw new HttpError(429, LOGIN_CODE_LOCKED, "code_attempts_exceeded");
      if (result.reason === "send_limit") throw new HttpError(429, SEND_LIMIT, "resend_limit");
      throw cooldownError(result.retryAfterMs);
    }
    return ok(result.view);
  });
}
