import crypto from "node:crypto";
import type { NextResponse } from "next/server";
import type { Types } from "mongoose";
import { env, isProduction } from "../env";
import { LOGIN_CODE_TOKEN_TYPE } from "../constants";
import { sendEmail } from "../email";
import { renderLoginCodeEmail } from "../email-templates";
import { AuthToken } from "../../models/AuthToken";
import { hashActionToken } from "./action-tokens";
import { platformCredentialFingerprint } from "./platform-device";
import { logDevelopmentLoginCode } from "./dev-login-code";

/**
 * New-device sign-in codes for platform accounts (server-only).
 *
 * When the password is right but the browser carries no valid known-device marker for this
 * account (lib/auth/platform-device.ts), the login route does NOT sign in. It starts a pending
 * sign-in here and emails a six-digit code; only a correct code, entered from the same browser,
 * creates the session and the marker. Every platform account follows the same rule, whatever
 * its platform or business role. Storefront customers never pass through here.
 *
 * - The pending sign-in is a 256-bit random value held only in an httpOnly, SameSite=Strict
 *   cookie. The database keeps its SHA-256 hash (`AuthToken.tokenHash`, type `login_code`), so the
 *   code is bound to that browser, that sign-in, that account and its device id.
 * - The code comes from `crypto.randomInt` (never Math.random), keeps leading zeros, and is stored
 *   only as an HMAC keyed from SESSION_SECRET over the pending sign-in, the account and the code.
 *   A six-digit value would be trivial to reverse from a plain hash.
 * - A code works for 5 minutes. A pending sign-in allows 5 guesses in total. Each guess is
 *   reserved atomically BEFORE the comparison, so concurrent guesses cannot exceed 5, and finishing
 *   the sign-in is a second conditional write, so only one request can ever use a code. Across
 *   pending sign-ins, the account's daily wrong-code budget applies (lib/auth/login-code-limits.ts).
 * - A resend replaces the code (the old one stops working at once) but keeps the guesses already
 *   made, at most once a minute and 3 times per sign-in. The sign-in itself lasts 20 minutes.
 * - The password fingerprint (which includes the account's trusted-device generation) and the
 *   session version seen at the password check are kept: a password change, any sign-out, an
 *   admin's device revocation or a deactivation in the meantime cancels the pending sign-in.
 *
 * Codes are never returned to the browser, never logged (apart from the opt-in development aid in
 * lib/auth/dev-login-code.ts) and never put in a URL or a token.
 */

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
/** The first code plus 3 resends. */
export const LOGIN_CODE_MAX_SENDS = 4;
export const LOGIN_CHALLENGE_TTL_MS = 20 * 60 * 1000;

export const LOGIN_CHALLENGE_COOKIE = "swb_login_challenge";
/** `__Host-` in production: Secure, Path=/, no Domain, so a store's subdomain cannot set it. */
export const LOGIN_CHALLENGE_COOKIE_PRODUCTION = "__Host-swb_login_challenge";

const CHALLENGE_BYTES = 32;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^\d{6}$/;
const CODE_KEY_INFO = "siteforge:login-code:v1";

export class LoginCodeDeliveryError extends Error {
  constructor() {
    super("The sign-in code could not be sent");
    this.name = "LoginCodeDeliveryError";
  }
}

/** Six digits, uniformly random, leading zeros kept. */
export function generateLoginCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const codeKey = (): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", Buffer.from(env().SESSION_SECRET, "utf8"), Buffer.alloc(0), Buffer.from(CODE_KEY_INFO, "utf8"), 32));

/** Keyed digest of a code, bound to one pending sign-in and one account. */
export function loginCodeDigest(challengeHash: string, userId: string, code: string): string {
  return crypto.createHmac("sha256", codeKey()).update(`login-code:${challengeHash}:${userId}:${code}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export const isLoginCode = (value: unknown): value is string => typeof value === "string" && CODE_PATTERN.test(value);

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export const loginChallengeCookieName = () => (isProduction() ? LOGIN_CHALLENGE_COOKIE_PRODUCTION : LOGIN_CHALLENGE_COOKIE);

export function readLoginChallengeCookie(request: Request): string | null {
  const expected = loginChallengeCookieName();
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === expected) {
      const value = rest.join("=");
      return CHALLENGE_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

function challengeCookie(value: string, maxAgeSeconds: number): string {
  const secure = isProduction() ? "; Secure" : "";
  return `${loginChallengeCookieName()}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
}

export function appendLoginChallengeCookie(response: NextResponse, rawChallenge: string): NextResponse {
  response.headers.append("Set-Cookie", challengeCookie(rawChallenge, Math.floor(LOGIN_CHALLENGE_TTL_MS / 1000)));
  return response;
}

export function clearLoginChallengeCookie(response: NextResponse): NextResponse {
  response.headers.append("Set-Cookie", challengeCookie("", 0));
  return response;
}

// ---------------------------------------------------------------------------
// Pending sign-ins
// ---------------------------------------------------------------------------

export interface LoginAccount {
  _id: Types.ObjectId;
  email: string;
  name?: string | null;
  passwordHash: string;
  tokenVersion: number;
  deviceTrustVersion?: number | null;
}

/** What the browser may know about a pending sign-in: timings only, never the code. */
export interface PendingLoginView {
  codeRequired: true;
  expiresInSeconds: number;
  resendInSeconds: number;
  resendsLeft: number;
  /** Guesses a pending sign-in has in total, across its resends. */
  attemptsAllowed: number;
  attemptsLeft: number;
}

interface CodeTimings {
  codeExpiresAt: Date;
  lastSentAt: Date;
  sends: number;
  attempts?: number;
}

export function pendingLoginView(timings: CodeTimings, now = new Date()): PendingLoginView {
  const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
  return {
    codeRequired: true,
    expiresInSeconds: seconds(timings.codeExpiresAt.getTime() - now.getTime()),
    resendInSeconds: timings.sends >= LOGIN_CODE_MAX_SENDS ? 0 : seconds(timings.lastSentAt.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS - now.getTime()),
    resendsLeft: Math.max(0, LOGIN_CODE_MAX_SENDS - timings.sends),
    attemptsAllowed: LOGIN_CODE_MAX_ATTEMPTS,
    attemptsLeft: Math.max(0, LOGIN_CODE_MAX_ATTEMPTS - (timings.attempts ?? 0)),
  };
}

async function deliverCode(account: { email: string; name?: string | null }, code: string): Promise<void> {
  const email = renderLoginCodeEmail({ name: account.name, code, expiresInMinutes: LOGIN_CODE_TTL_MS / 60_000 });
  try {
    await sendEmail({ to: account.email, ...email });
  } catch {
    throw new LoginCodeDeliveryError();
  }
  logDevelopmentLoginCode(account.email, code);
}

/**
 * Starts a pending sign-in for an account whose password was JUST verified on a browser without a
 * valid marker, and emails its first code. Any earlier pending sign-in of the account stops working.
 * If the email cannot be sent, the new sign-in is cancelled too and `LoginCodeDeliveryError` is thrown.
 */
export async function startLoginChallenge(
  account: LoginAccount,
  deviceId: string,
  now = new Date(),
): Promise<{ rawChallenge: string; view: PendingLoginView }> {
  const rawChallenge = crypto.randomBytes(CHALLENGE_BYTES).toString("base64url");
  const tokenHash = hashActionToken(rawChallenge);
  const code = generateLoginCode();
  const codeExpiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

  await AuthToken.updateMany({ user: account._id, type: LOGIN_CODE_TOKEN_TYPE, usedAt: null }, { $set: { usedAt: now } });
  const created = await AuthToken.create({
    user: account._id,
    type: LOGIN_CODE_TOKEN_TYPE,
    tokenHash,
    expiresAt: new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS),
    usedAt: null,
    codeHash: loginCodeDigest(tokenHash, account._id.toString(), code),
    codeExpiresAt,
    attempts: 0,
    sends: 1,
    lastSentAt: now,
    deviceId,
    credential: platformCredentialFingerprint(account.passwordHash, account.deviceTrustVersion),
    tokenVersion: account.tokenVersion,
  });

  try {
    await deliverCode(account, code);
  } catch (error) {
    await AuthToken.updateOne({ _id: created._id, usedAt: null }, { $set: { usedAt: new Date() } }).catch(() => undefined);
    throw error;
  }
  return { rawChallenge, view: pendingLoginView({ codeExpiresAt, lastSentAt: now, sends: 1 }, now) };
}

export interface PendingLogin {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  codeHash: string;
  codeExpiresAt: Date;
  attempts: number;
  sends: number;
  lastSentAt: Date;
  deviceId: string;
  credential: string;
  tokenVersion: number;
}

/** The live pending sign-in a browser's cookie names, or null. */
export async function readPendingLogin(rawChallenge: string | null, now = new Date()): Promise<PendingLogin | null> {
  if (!rawChallenge || !CHALLENGE_PATTERN.test(rawChallenge)) return null;
  const tokenHash = hashActionToken(rawChallenge);
  const found = await AuthToken.findOne({ tokenHash, type: LOGIN_CODE_TOKEN_TYPE, usedAt: null, expiresAt: { $gt: now } })
    .select("+codeHash +credential")
    .lean();
  if (!found || !found.codeHash || !found.codeExpiresAt || !found.lastSentAt || !found.deviceId || !found.credential) return null;
  return {
    _id: found._id,
    user: found.user,
    tokenHash,
    codeHash: found.codeHash,
    codeExpiresAt: found.codeExpiresAt,
    attempts: found.attempts ?? 0,
    sends: found.sends ?? 1,
    lastSentAt: found.lastSentAt,
    deviceId: found.deviceId,
    credential: found.credential,
    tokenVersion: found.tokenVersion ?? 0,
  };
}

/**
 * Whether the account is still the one whose password was checked: active, address confirmed,
 * same password, no sign-out (`tokenVersion`) and no revoked device trust (`deviceTrustVersion`,
 * part of the fingerprint) since. Anything else cancels the pending sign-in.
 */
export function pendingLoginMatchesAccount(
  pending: Pick<PendingLogin, "user" | "credential" | "tokenVersion">,
  account: {
    _id: Types.ObjectId;
    active: boolean;
    emailVerifiedAt?: Date | null;
    passwordHash: string;
    tokenVersion: number;
    deviceTrustVersion?: number | null;
  } | null,
): boolean {
  if (!account || !account.active || account.emailVerifiedAt === null) return false;
  if (!account._id.equals(pending.user)) return false;
  if (account.tokenVersion !== pending.tokenVersion) return false;
  return safeEqual(platformCredentialFingerprint(account.passwordHash, account.deviceTrustVersion), pending.credential);
}

/**
 * `counted`: a wrong code was really compared and used one of the 5 guesses. Only then does the
 * account's daily wrong-code budget keep its unit (lib/auth/login-code-limits.ts).
 */
export type LoginCodeCheck =
  | { ok: true; pending: PendingLogin }
  | { ok: false; reason: "no_challenge" | "expired_code" | "too_many_attempts"; counted: boolean }
  | { ok: false; reason: "wrong_code"; attemptsRemaining: number; counted: boolean; pending: PendingLogin };

/**
 * Checks a code against a pending sign-in and, when it is right, uses the sign-in up. Exactly one
 * request can ever succeed for a given sign-in; at most `LOGIN_CODE_MAX_ATTEMPTS` comparisons are
 * made per code, even when guesses arrive at the same moment.
 */
export async function checkLoginCode(pending: PendingLogin, code: unknown, now = new Date()): Promise<LoginCodeCheck> {
  if (pending.codeExpiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired_code", counted: false };
  if (pending.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts", counted: false };

  // Reserve the guess first. `codeHash` in the filter: a resend in between makes this guess about
  // a code that no longer exists, so it is not counted against the new one.
  const reserved = await AuthToken.findOneAndUpdate(
    { _id: pending._id, usedAt: null, codeHash: pending.codeHash, codeExpiresAt: { $gt: now }, attempts: { $lt: LOGIN_CODE_MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true },
  ).lean();
  if (!reserved) {
    const current = await AuthToken.findOne({ _id: pending._id }).select("+codeHash").lean();
    if (!current || current.usedAt || current.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "no_challenge", counted: false };
    if ((current.attempts ?? 0) >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts", counted: false };
    // A resend replaced the code meanwhile: this guess was about a code that no longer exists.
    if (current.codeHash !== pending.codeHash) {
      return { ok: false, reason: "wrong_code", attemptsRemaining: LOGIN_CODE_MAX_ATTEMPTS - (current.attempts ?? 0), counted: false, pending };
    }
    return { ok: false, reason: "expired_code", counted: false };
  }

  const right = isLoginCode(code) && safeEqual(loginCodeDigest(pending.tokenHash, pending.user.toString(), code), pending.codeHash);
  if (!right) {
    const remaining = Math.max(0, LOGIN_CODE_MAX_ATTEMPTS - (reserved.attempts ?? LOGIN_CODE_MAX_ATTEMPTS));
    return remaining === 0
      ? { ok: false, reason: "too_many_attempts", counted: true }
      : { ok: false, reason: "wrong_code", attemptsRemaining: remaining, counted: true, pending };
  }

  const used = await AuthToken.findOneAndUpdate({ _id: pending._id, usedAt: null, codeHash: pending.codeHash }, { $set: { usedAt: now } });
  if (!used) return { ok: false, reason: "no_challenge", counted: false };
  return { ok: true, pending };
}

/** Cancels a pending sign-in (for example when the account changed meanwhile). */
export async function cancelPendingLogin(pending: Pick<PendingLogin, "_id">): Promise<void> {
  await AuthToken.updateOne({ _id: pending._id, usedAt: null }, { $set: { usedAt: new Date() } });
}

export type ResendResult =
  | { ok: true; view: PendingLoginView }
  | { ok: false; reason: "cooldown" | "send_limit" | "attempts_exhausted"; retryAfterMs: number };

/**
 * Replaces the code of a pending sign-in and emails the new one. The previous code stops working
 * in the same write. The guesses already made are KEPT: a pending sign-in has 5 guesses in total,
 * whatever its resends, and one that used them up gets no new code (log in again). Concurrent
 * resends: only the first matching write wins, the others see the cooldown.
 */
export async function resendLoginCode(
  pending: PendingLogin,
  account: { email: string; name?: string | null },
  now = new Date(),
): Promise<ResendResult> {
  if (pending.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "attempts_exhausted", retryAfterMs: 0 };
  if (pending.sends >= LOGIN_CODE_MAX_SENDS) return { ok: false, reason: "send_limit", retryAfterMs: 0 };
  const readyAt = pending.lastSentAt.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS;
  if (readyAt > now.getTime()) return { ok: false, reason: "cooldown", retryAfterMs: readyAt - now.getTime() };

  const code = generateLoginCode();
  const codeExpiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);
  const updated = await AuthToken.findOneAndUpdate(
    {
      _id: pending._id,
      usedAt: null,
      expiresAt: { $gt: now },
      sends: pending.sends,
      lastSentAt: pending.lastSentAt,
      attempts: { $lt: LOGIN_CODE_MAX_ATTEMPTS },
    },
    {
      // `attempts` is deliberately not touched.
      $set: { codeHash: loginCodeDigest(pending.tokenHash, pending.user.toString(), code), codeExpiresAt, lastSentAt: now },
      $inc: { sends: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) {
    const current = await AuthToken.findOne({ _id: pending._id }).select("attempts").lean();
    if ((current?.attempts ?? 0) >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "attempts_exhausted", retryAfterMs: 0 };
    return { ok: false, reason: "cooldown", retryAfterMs: LOGIN_CODE_RESEND_COOLDOWN_MS };
  }

  await deliverCode(account, code);
  return {
    ok: true,
    view: pendingLoginView({ codeExpiresAt, lastSentAt: now, sends: updated.sends ?? pending.sends + 1, attempts: updated.attempts ?? pending.attempts }, now),
  };
}
