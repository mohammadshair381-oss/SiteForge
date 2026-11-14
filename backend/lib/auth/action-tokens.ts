import crypto from "node:crypto";
import { Types } from "mongoose";
import { AUTH_TOKEN_TYPES, type ActionTokenType } from "../constants";
import { AuthToken } from "../../models/AuthToken";

/**
 * Secure, single-use action tokens for password reset and email verification.
 *
 * Design:
 * - The raw token is 256 random bits, URL-safe (base64url) so it can travel in
 *   an email link without further encoding.
 * - Only a SHA-256 hash is stored. The hash is unsalted on purpose: the raw
 *   token is already high-entropy, so there is nothing to brute-force (unlike a
 *   user password).
 * - Consumption is a single atomic `findOneAndUpdate`, so two concurrent
 *   requests can never both consume the same token.
 * - Every failure mode (unknown, expired, wrong type, already used) returns the
 *   same `{ ok: false, reason: "invalid" }` result to avoid leaking which check
 *   failed.
 *
 * Raw tokens and token-bearing URLs must never be logged.
 */

const TOKEN_BYTES = 32; // 256 bits
const MIN_TTL_MS = 1;
const MAX_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Generated tokens are 43 base64url characters; this rejects obviously
// malformed input early (before any database round trip) without rejecting any
// legitimately generated token.
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

export class ActionTokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ActionTokenError";
    this.code = code;
  }
}

export function isActionTokenType(value: unknown): value is ActionTokenType {
  return (
    typeof value === "string" &&
    (AUTH_TOKEN_TYPES as readonly string[]).includes(value)
  );
}

/** Generates a URL-safe token with 256 bits of entropy. */
export function generateActionToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 hex digest of a raw token. Deterministic and irreversible. */
export function hashActionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function assertValidTtl(ttlMs: number): void {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS) {
    throw new ActionTokenError(
      "invalid_ttl",
      "ttlMs must be a finite number of milliseconds greater than zero",
    );
  }
  if (ttlMs > MAX_TTL_MS) {
    throw new ActionTokenError(
      "invalid_ttl",
      "ttlMs exceeds the maximum allowed token lifetime",
    );
  }
}

function toObjectId(userId: Types.ObjectId | string): Types.ObjectId {
  if (userId instanceof Types.ObjectId) return userId;
  if (typeof userId === "string" && Types.ObjectId.isValid(userId)) {
    return new Types.ObjectId(userId);
  }
  throw new ActionTokenError("invalid_user", "userId must be a valid ObjectId");
}

export interface CreatedActionToken {
  /** Raw token: deliver it to the user and never persist, log or serialize it. */
  rawToken: string;
  type: ActionTokenType;
  expiresAt: Date;
  /** Safe identifier of the stored record (never the raw token). */
  tokenId: Types.ObjectId;
}

/**
 * Creates a single-use token. Any outstanding unconsumed token of the same
 * (user, type) is invalidated first, so only the newest link works.
 *
 * Concurrency note: the invalidate-then-insert pair is deliberately not in a
 * transaction. Two simultaneous issuances for the same (user, type) are not
 * serialized, but that is not a security problem: each raw token is still
 * single-use and bound to its own hash, and at most one consumption can win.
 */
export async function createActionToken(
  userId: Types.ObjectId | string,
  type: ActionTokenType,
  ttlMs: number,
): Promise<CreatedActionToken> {
  if (!isActionTokenType(type)) {
    throw new ActionTokenError("invalid_type", "Unsupported action token type");
  }
  assertValidTtl(ttlMs);
  const user = toObjectId(userId);

  const rawToken = generateActionToken();
  const tokenHash = hashActionToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlMs);

  await AuthToken.updateMany(
    { user, type, usedAt: null },
    { $set: { usedAt: new Date() } },
  );

  const created = await AuthToken.create({ user, type, tokenHash, expiresAt });

  return { rawToken, type, expiresAt, tokenId: created._id };
}

export interface ConsumedActionToken {
  id: Types.ObjectId;
  user: Types.ObjectId;
  type: ActionTokenType;
  expiresAt: Date;
  usedAt: Date;
}

export type ConsumeActionTokenResult =
  | { ok: true; token: ConsumedActionToken }
  | { ok: false; reason: "invalid" };

/**
 * Atomically consumes a token of the expected type. The filter and the
 * `usedAt` update happen in one `findOneAndUpdate`, so exactly one of any
 * number of concurrent callers can succeed.
 */
/** The user a live token belongs to, without using it up. */
export async function peekActionTokenUser(rawToken: string, type: ActionTokenType): Promise<Types.ObjectId | null> {
  const found = await AuthToken.findOne({ tokenHash: hashActionToken(rawToken), type, usedAt: null, expiresAt: { $gt: new Date() } }).select("user").lean();
  return found ? (found.user as Types.ObjectId) : null;
}

/** Retires every unused token of this type for a user, such as when their password changes. */
export async function retireActionTokens(userId: Types.ObjectId | string, type: ActionTokenType): Promise<void> {
  await AuthToken.updateMany({ user: toObjectId(userId), type, usedAt: null }, { $set: { usedAt: new Date() } });
}

export async function consumeActionToken(
  rawToken: unknown,
  type: ActionTokenType,
): Promise<ConsumeActionTokenResult> {
  if (!isActionTokenType(type)) {
    throw new ActionTokenError("invalid_type", "Unsupported action token type");
  }
  if (typeof rawToken !== "string" || !RAW_TOKEN_PATTERN.test(rawToken)) {
    return { ok: false, reason: "invalid" };
  }

  const now = new Date();
  const consumed = await AuthToken.findOneAndUpdate(
    {
      tokenHash: hashActionToken(rawToken),
      type,
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { new: true },
  );

  if (!consumed) {
    return { ok: false, reason: "invalid" };
  }

  return {
    ok: true,
    token: {
      id: consumed._id,
      user: consumed.user,
      // The filter matched `type`, so this is never a `login_code` record.
      type,
      expiresAt: consumed.expiresAt,
      usedAt: now,
    },
  };
}
