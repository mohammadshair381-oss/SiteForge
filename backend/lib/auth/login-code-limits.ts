import { HttpError } from "../api";
import { consumeRateLimit, releaseRateLimit } from "../rate-limit";

/**
 * Limits and answers shared by the platform login and its new-device code routes
 * (app/api/auth/login/**). Per-code limits live in lib/auth/login-challenge.ts.
 */

/** Codes emailed to one account (first codes and resends together). */
export const LOGIN_CODE_SENDS_PER_ACCOUNT = 5;
export const LOGIN_CODE_SEND_WINDOW_MS = 15 * 60 * 1000;

/** Code checks and resend requests from one source (IPv4 address or IPv6 /64). */
export const LOGIN_CODE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_CODE_VERIFY_PER_SOURCE = 30;
export const LOGIN_CODE_RESEND_PER_SOURCE = 10;

/**
 * Wrong codes one account may have per day, across ALL its pending sign-ins (each has 5 guesses,
 * and logging in again starts a new one). A fixed window (UTC days), shared across instances.
 */
export const LOGIN_CODE_FAILURES_PER_ACCOUNT = 10;
export const LOGIN_CODE_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LOGIN_CODE_NOT_SENT = "We could not send your sign-in code. Please try again in a few minutes.";
export const LOGIN_EXPIRED = "This sign-in has expired. Log in again to get a new code.";
export const LOGIN_CODE_EXPIRED = "This code has expired. Send a new code to continue.";
export const LOGIN_CODE_LOCKED = "Too many wrong codes. Log in again to get a new code.";
export const LOGIN_CODE_ACCOUNT_LOCKED =
  "Too many wrong sign-in codes for this account. Try again later, or log in from a device you have used before.";

const failureBudget = (userId: string) => ({
  key: `login-code:fail:account:${userId}`,
  limit: LOGIN_CODE_FAILURES_PER_ACCOUNT,
  windowMs: LOGIN_CODE_FAILURE_WINDOW_MS,
});

function accountLocked(retryAfterMs: number): HttpError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new HttpError(429, LOGIN_CODE_ACCOUNT_LOCKED, "login_code_locked", { "Retry-After": String(seconds) });
}

/**
 * Reserves one wrong-code unit for the account BEFORE a code is compared (atomic, so guesses at the
 * same moment cannot overshoot) and hands back how to return it. The caller returns it unless a wrong
 * code was really compared. Throws `429 login_code_locked` when the day's budget is used up.
 * Only reachable with a pending sign-in, that is after the right password: it reveals nothing more.
 */
export async function reserveAccountCodeGuess(userId: string): Promise<() => Promise<void>> {
  const result = await consumeRateLimit(failureBudget(userId));
  if (!result.allowed) throw accountLocked(result.retryAfterMs);
  return () => releaseRateLimit(result.bucketKey);
}

/**
 * Refuses (429) to email a code an account could not use, because its budget is used up. Spends
 * nothing: the unit taken to look is given straight back. Call it only after the password check.
 */
export async function assertAccountCodeBudget(userId: string): Promise<void> {
  const result = await consumeRateLimit(failureBudget(userId));
  await releaseRateLimit(result.bucketKey);
  if (!result.allowed) throw accountLocked(result.retryAfterMs);
}
