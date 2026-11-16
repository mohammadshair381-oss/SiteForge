import { HttpError } from "../api";
import { recordSecurityEvent } from "../security-events";
import { User, type UserDoc } from "../../models/User";
import type { HydratedDocument } from "mongoose";
import {
  cancelPendingLogin,
  checkLoginCode,
  pendingLoginMatchesAccount,
  readLoginChallengeCookie,
  readPendingLogin,
  type CodePurpose,
  type PendingLogin,
} from "./login-challenge";
import { LOGIN_CODE_EXPIRED, LOGIN_CODE_LOCKED, LOGIN_EXPIRED, reserveAccountCodeGuess } from "./login-code-limits";

/**
 * Checks a submitted six-digit code against the pending code in this browser's cookie (server-only),
 * the one step shared by finishing a login or signup and resetting a password. Only a right code for
 * a live account returns; everything else throws the answer to give.
 *
 * - The pending code comes only from its httpOnly cookie, never from the body.
 * - The account must still be the one the code was started for, checked before any guess is compared.
 * - A decoy (signup or reset for an address with nothing to send to) has no account: it is compared
 *   exactly like a real one, its code can never match, and it answers exactly like a wrong code.
 * - The daily wrong-code budget is reserved before comparing, keyed by the pending code's account id
 *   (a decoy's id belongs to no account, so a stranger can never use up a real account's budget).
 */
export async function verifySubmittedCode(
  request: Request,
  code: string,
  options: { cookie: "login" | "reset"; purposes: readonly CodePurpose[] },
): Promise<{ user: HydratedDocument<UserDoc>; pending: PendingLogin }> {
  const reset = options.cookie === "reset";
  const expired = () => new HttpError(400, reset ? RESET_EXPIRED : LOGIN_EXPIRED, "login_expired");

  const pending = await readPendingLogin(readLoginChallengeCookie(request, options.cookie), options.purposes);
  if (!pending) throw expired();

  const user = await User.findById(pending.user).select("+passwordHash");
  const failureType = reset ? ("password_reset_failed" as const) : ("login_code_failed" as const);
  if (user && !pendingLoginMatchesAccount(pending, user)) {
    await cancelPendingLogin(pending).catch(() => undefined);
    await recordSecurityEvent({ type: failureType, reason: "account_changed", userId: user._id, email: user.email, request });
    throw expired();
  }

  const returnGuess = await reserveAccountCodeGuess(pending.user.toString(), reset ? "reset" : "login");
  let result = await checkLoginCode(pending, code);
  // A decoy's code can never match; should a guess ever do so, it still answers as a wrong code.
  if (result.ok && !user) result = { ok: false, reason: "wrong_code", attemptsRemaining: 0, counted: true, pending };
  if (result.ok || !result.counted) {
    // Only a wrong code that was really compared keeps its unit.
    await returnGuess().catch(() => console.warn("[auth-code] a rate-limit unit could not be returned"));
  }

  if (result.ok && user) return { user, pending };
  if (result.ok) throw expired();

  const failure = { type: failureType, userId: user?._id ?? pending.user, email: user?.email, request };
  switch (result.reason) {
    case "wrong_code": {
      if (result.counted) await recordSecurityEvent({ ...failure, reason: "wrong_code" });
      const left = result.attemptsRemaining;
      if (left <= 0) throw new HttpError(429, reset ? RESET_CODE_LOCKED : LOGIN_CODE_LOCKED, "code_attempts_exceeded");
      const message = `That code is not right. You have ${left} ${left === 1 ? "try" : "tries"} left.`;
      throw new HttpError(400, message, "code_invalid", undefined, { code: message });
    }
    case "expired_code":
      await recordSecurityEvent({ ...failure, reason: "expired_code" });
      throw new HttpError(400, LOGIN_CODE_EXPIRED, "code_expired");
    case "too_many_attempts":
      await recordSecurityEvent({ ...failure, reason: "too_many_attempts" });
      throw new HttpError(429, reset ? RESET_CODE_LOCKED : LOGIN_CODE_LOCKED, "code_attempts_exceeded");
    default:
      throw expired();
  }
}

export const RESET_EXPIRED = "This password reset has expired. Ask for a new code to continue.";
export const RESET_CODE_LOCKED = "Too many wrong codes. Ask for a new code to continue.";
