import crypto from "node:crypto";
import type { NextResponse } from "next/server";
import { Types } from "mongoose";
import { env, isProduction } from "../env";
import { LOGIN_CODE_TOKEN_TYPE } from "../constants";
import { sendEmail } from "../email";
import { renderLoginCodeEmail } from "../email-templates";
import { AuthToken } from "../../models/AuthToken";
import { hashActionToken } from "./action-tokens";
import { platformCredentialFingerprint } from "./platform-device";
import { logDevelopmentLoginCode } from "./dev-login-code";

/**
 * Emailed six-digit codes for platform accounts (server-only). Signup and login use email and password
 * only (an owner decision), so the one remaining use is the password reset: "forgot password" starts a
 * pending reset code, and only the right code lets a new password be set (app/api/auth/password/**).
 *
 * - The pending code is a 256-bit random value held only in an httpOnly, SameSite=Strict cookie. The
 *   database keeps its SHA-256 hash (`AuthToken`, type `login_code`, with its `purpose`), so a code is
 *   bound to that browser, that request and that account.
 * - The code comes from `crypto.randomInt` (never Math.random), keeps leading zeros, and is stored only
 *   as an HMAC keyed from SESSION_SECRET over the pending value, the account, the code AND the purpose.
 * - A code works for 5 minutes. A pending code allows 5 guesses in total. Each guess is reserved
 *   atomically BEFORE the comparison, and finishing is a second conditional write, so only one request
 *   can ever use a code. Across pending codes, the account's daily wrong-code budget applies
 *   (lib/auth/login-code-limits.ts, the `reset` budget).
 * - The password fingerprint and the session version are kept: a password change, any sign-out, an
 *   admin's device revocation or a deactivation in the meantime cancels the pending code.
 * - "Forgot password" never reveals whether an address has an account: every request gets an identical
 *   pending code. When there is nothing to send it to, it is bound to an id no account has and its code
 *   can never match (a "decoy"); entering codes against it answers exactly like a wrong code.
 *
 * Codes are never returned to the browser, never logged (apart from the opt-in development aid in
 * lib/auth/dev-login-code.ts) and never put in a URL or a token. The `login` and `signup` purposes
 * remain only so records written while those flows existed still read correctly; nothing creates them.
 */

export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
/** The first code plus 3 resends. */
export const LOGIN_CODE_MAX_SENDS = 4;
export const LOGIN_CHALLENGE_TTL_MS = 20 * 60 * 1000;

export type CodePurpose = "login" | "signup" | "reset";

export const LOGIN_CHALLENGE_COOKIE = "swb_login_challenge";
/** `__Host-` in production: Secure, Path=/, no Domain, so a store's subdomain cannot set it. */
export const LOGIN_CHALLENGE_COOKIE_PRODUCTION = "__Host-swb_login_challenge";
export const RESET_CHALLENGE_COOKIE = "swb_reset_challenge";
export const RESET_CHALLENGE_COOKIE_PRODUCTION = "__Host-swb_reset_challenge";

const CHALLENGE_BYTES = 32;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^\d{6}$/;
const CODE_KEY_INFO = "siteforge:login-code:v1";

export class LoginCodeDeliveryError extends Error {
  constructor() {
    super("The code could not be sent");
    this.name = "LoginCodeDeliveryError";
  }
}

/** Six digits, uniformly random, leading zeros kept. */
export function generateLoginCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

const codeKey = (): Buffer =>
  Buffer.from(crypto.hkdfSync("sha256", Buffer.from(env().SESSION_SECRET, "utf8"), Buffer.alloc(0), Buffer.from(CODE_KEY_INFO, "utf8"), 32));

/**
 * Keyed digest of a code, bound to one pending code, one account and one purpose. `login` keeps the
 * original message, so codes of records written before purposes existed still check.
 */
export function loginCodeDigest(challengeHash: string, userId: string, code: string, purpose: CodePurpose = "login"): string {
  const message = purpose === "login" ? `login-code:${challengeHash}:${userId}:${code}` : `${purpose}-code:${challengeHash}:${userId}:${code}`;
  return crypto.createHmac("sha256", codeKey()).update(message).digest("base64url");
}

/** A value with the shape of a digest or fingerprint that nothing can ever produce (decoys). */
const unguessable = () => crypto.randomBytes(32).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export const isLoginCode = (value: unknown): value is string => typeof value === "string" && CODE_PATTERN.test(value);

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

type CookieKind = "login" | "reset";
const cookieKindOf = (purpose: CodePurpose): CookieKind => (purpose === "reset" ? "reset" : "login");

export const loginChallengeCookieName = (kind: CookieKind = "login") =>
  kind === "reset"
    ? isProduction() ? RESET_CHALLENGE_COOKIE_PRODUCTION : RESET_CHALLENGE_COOKIE
    : isProduction() ? LOGIN_CHALLENGE_COOKIE_PRODUCTION : LOGIN_CHALLENGE_COOKIE;

export function readLoginChallengeCookie(request: Request, kind: CookieKind = "login"): string | null {
  const expected = loginChallengeCookieName(kind);
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === expected) {
      const value = rest.join("=");
      return CHALLENGE_PATTERN.test(value) ? value : null;
    }
  }
  return null;
}

function challengeCookie(kind: CookieKind, value: string, maxAgeSeconds: number): string {
  const secure = isProduction() ? "; Secure" : "";
  return `${loginChallengeCookieName(kind)}=${value}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${maxAgeSeconds}`;
}

export function appendLoginChallengeCookie(response: NextResponse, rawChallenge: string, kind: CookieKind = "login"): NextResponse {
  response.headers.append("Set-Cookie", challengeCookie(kind, rawChallenge, Math.floor(LOGIN_CHALLENGE_TTL_MS / 1000)));
  return response;
}

export function clearLoginChallengeCookie(response: NextResponse, kind: CookieKind = "login"): NextResponse {
  response.headers.append("Set-Cookie", challengeCookie(kind, "", 0));
  return response;
}

// ---------------------------------------------------------------------------
// Pending codes
// ---------------------------------------------------------------------------

export interface LoginAccount {
  _id: Types.ObjectId;
  email: string;
  name?: string | null;
  passwordHash: string;
  tokenVersion: number;
  deviceTrustVersion?: number | null;
}

/** What the browser may know about a pending code: timings only, never the code. */
export interface PendingLoginView {
  codeRequired: true;
  expiresInSeconds: number;
  resendInSeconds: number;
  resendsLeft: number;
  /** Guesses a pending code has in total, across its resends. */
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

/** Emails a code (and, in local development only, prints it). Throws `LoginCodeDeliveryError`. */
export async function deliverCode(account: { email: string; name?: string | null }, code: string, purpose: CodePurpose): Promise<void> {
  const email = renderLoginCodeEmail({ name: account.name, code, expiresInMinutes: LOGIN_CODE_TTL_MS / 60_000, purpose });
  try {
    await sendEmail({ to: account.email, ...email });
  } catch (error) {
    // The one signal an operator gets during an outage. Fixed text and the error's class only:
    // never the address, the code or the provider's message.
    console.error(JSON.stringify({ event: "login_code_email_failed", purpose, category: error instanceof Error ? error.name : "unknown" }));
    throw new LoginCodeDeliveryError();
  }
  logDevelopmentLoginCode(account.email, code, process.env, undefined, purpose);
}

export interface StartedCode {
  rawChallenge: string;
  /** The plaintext code, to deliver. Never return it to a browser or log it. */
  code: string;
  tokenId: Types.ObjectId;
  view: PendingLoginView;
}

/**
 * Creates a pending code. `account` is the real account, or null for a decoy: then the record is
 * bound to `userId` (an id no account has, or one created after the response), and, unless
 * `matchable` is set, its code can never match.
 */
async function createPendingCode(input: {
  purpose: CodePurpose;
  userId: Types.ObjectId;
  credential: string;
  tokenVersion: number;
  matchable: boolean;
  now: Date;
}): Promise<StartedCode> {
  const { purpose, userId, now } = input;
  const rawChallenge = crypto.randomBytes(CHALLENGE_BYTES).toString("base64url");
  const tokenHash = hashActionToken(rawChallenge);
  const code = generateLoginCode();
  const codeExpiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

  // A newer pending code of the same kind replaces the older one.
  await AuthToken.updateMany(
    { user: userId, type: LOGIN_CODE_TOKEN_TYPE, usedAt: null, ...(purpose === "reset" ? { purpose: "reset" } : { purpose: { $ne: "reset" } }) },
    { $set: { usedAt: now } },
  );
  const created = await AuthToken.create({
    user: userId,
    type: LOGIN_CODE_TOKEN_TYPE,
    purpose,
    tokenHash,
    expiresAt: new Date(now.getTime() + LOGIN_CHALLENGE_TTL_MS),
    usedAt: null,
    codeHash: input.matchable ? loginCodeDigest(tokenHash, userId.toString(), code, purpose) : unguessable(),
    codeExpiresAt,
    attempts: 0,
    sends: 1,
    lastSentAt: now,
    credential: input.credential,
    tokenVersion: input.tokenVersion,
  });
  return { rawChallenge, code, tokenId: created._id, view: pendingLoginView({ codeExpiresAt, lastSentAt: now, sends: 1 }, now) };
}

async function retire(tokenId: Types.ObjectId): Promise<void> {
  await AuthToken.updateOne({ _id: tokenId, usedAt: null }, { $set: { usedAt: new Date() } }).catch(() => undefined);
}

/**
 * Password reset, during the request: a real pending code for an active account, or a decoy bound to
 * a fresh id. The caller emails the real one after the response (`deliverCode`).
 */
export function startResetChallenge(account: LoginAccount | null, now = new Date()): Promise<StartedCode> {
  return createPendingCode({
    purpose: "reset",
    userId: account?._id ?? new Types.ObjectId(),
    credential: account ? platformCredentialFingerprint(account.passwordHash, account.deviceTrustVersion) : unguessable(),
    tokenVersion: account?.tokenVersion ?? 0,
    matchable: account !== null,
    now,
  });
}

export interface PendingLogin {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  purpose: CodePurpose;
  tokenHash: string;
  codeHash: string;
  codeExpiresAt: Date;
  attempts: number;
  sends: number;
  lastSentAt: Date;
  credential: string;
  tokenVersion: number;
}

/** The live pending code a browser's cookie names, for one of `purposes`, or null. */
export async function readPendingLogin(rawChallenge: string | null, purposes: readonly CodePurpose[] = ["login", "signup"], now = new Date()): Promise<PendingLogin | null> {
  if (!rawChallenge || !CHALLENGE_PATTERN.test(rawChallenge)) return null;
  const tokenHash = hashActionToken(rawChallenge);
  const found = await AuthToken.findOne({ tokenHash, type: LOGIN_CODE_TOKEN_TYPE, usedAt: null, expiresAt: { $gt: now } })
    .select("+codeHash +credential")
    .lean();
  if (!found || !found.codeHash || !found.codeExpiresAt || !found.lastSentAt || !found.credential) return null;
  const purpose: CodePurpose = found.purpose ?? "login";
  if (!purposes.includes(purpose)) return null;
  return {
    _id: found._id,
    user: found.user,
    purpose,
    tokenHash,
    codeHash: found.codeHash,
    codeExpiresAt: found.codeExpiresAt,
    attempts: found.attempts ?? 0,
    sends: found.sends ?? 1,
    lastSentAt: found.lastSentAt,
    credential: found.credential,
    tokenVersion: found.tokenVersion ?? 0,
  };
}

/**
 * Whether the account is still the one the code was started for: active, same password, no sign-out
 * (`tokenVersion`) and no revoked device trust (`deviceTrustVersion`, part of the fingerprint) since.
 * An unconfirmed address is fine: entering the emailed code is what confirms it.
 */
export function pendingLoginMatchesAccount(
  pending: Pick<PendingLogin, "user" | "credential" | "tokenVersion">,
  account: {
    _id: Types.ObjectId;
    active: boolean;
    passwordHash: string;
    tokenVersion: number;
    deviceTrustVersion?: number | null;
  } | null,
): boolean {
  if (!account || !account.active) return false;
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
 * Checks a code against a pending code and, when it is right, uses it up. Exactly one request can
 * ever succeed for a given pending code; at most `LOGIN_CODE_MAX_ATTEMPTS` comparisons are made per
 * code, even when guesses arrive at the same moment.
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

  const right = isLoginCode(code) && safeEqual(loginCodeDigest(pending.tokenHash, pending.user.toString(), code, pending.purpose), pending.codeHash);
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

/** Cancels a pending code (for example when the account changed meanwhile). */
export async function cancelPendingLogin(pending: Pick<PendingLogin, "_id">): Promise<void> {
  await AuthToken.updateOne({ _id: pending._id, usedAt: null }, { $set: { usedAt: new Date() } });
}

/** Cancels every pending code of an account (after a password reset). */
export async function cancelAllPendingCodes(userId: Types.ObjectId, now = new Date()): Promise<void> {
  await AuthToken.updateMany({ user: userId, type: LOGIN_CODE_TOKEN_TYPE, usedAt: null }, { $set: { usedAt: now } });
}

export type ResendResult =
  | { ok: true; view: PendingLoginView }
  | { ok: false; reason: "cooldown" | "send_limit" | "attempts_exhausted"; retryAfterMs: number };

/**
 * Replaces the code of a pending code and emails the new one (to `account`; null for a decoy, which
 * goes through exactly the same steps and sends nothing). The previous code stops working in the same
 * write. The guesses already made are KEPT. Concurrent resends: only the first matching write wins.
 */
export async function resendLoginCode(
  pending: PendingLogin,
  account: { email: string; name?: string | null } | null,
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
      // `attempts` is deliberately not touched. A decoy's new code can never match either.
      $set: { codeHash: account ? loginCodeDigest(pending.tokenHash, pending.user.toString(), code, pending.purpose) : unguessable(), codeExpiresAt, lastSentAt: now },
      $inc: { sends: 1 },
    },
    { new: true },
  ).lean();
  if (!updated) {
    const current = await AuthToken.findOne({ _id: pending._id }).select("attempts").lean();
    if ((current?.attempts ?? 0) >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false, reason: "attempts_exhausted", retryAfterMs: 0 };
    return { ok: false, reason: "cooldown", retryAfterMs: LOGIN_CODE_RESEND_COOLDOWN_MS };
  }

  if (account) await deliverCode(account, code, pending.purpose);
  return {
    ok: true,
    view: pendingLoginView({ codeExpiresAt, lastSentAt: now, sends: updated.sends ?? pending.sends + 1, attempts: updated.attempts ?? pending.attempts }, now),
  };
}
