import mongoose, { Types, type ClientSession } from "mongoose";
import { generateActionToken, hashActionToken } from "./action-tokens";
import { Customer } from "@/models/Customer";
import {
  CustomerActionToken,
  type CustomerTokenType,
} from "@/models/CustomerActionToken";

/**
 * Customer action tokens (server-only). Reuses only the pure crypto helpers
 * from `lib/auth/action-tokens.ts` (256-bit base64url token, SHA-256 hash);
 * storage is the separate `CustomerActionToken` model, always scoped to one
 * business AND one customer. Raw tokens are returned once to the caller (for
 * the emailed link) and never logged or persisted.
 */

export const CUSTOMER_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
export const CUSTOMER_RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

function objectId(value: Types.ObjectId | string): Types.ObjectId {
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(value);
}

/**
 * Issues a fresh token for an ACTIVE customer of this business, invalidating
 * every unused token of the same type (a newer email supersedes an older one).
 * Returns null when no such customer exists.
 *
 * Concurrency: invalidate + insert run in one transaction that first writes
 * the customer document. Concurrent issuers for the same customer therefore
 * conflict on that write; the driver retries the loser, which then sees and
 * invalidates the winner's token. At most one token of a type stays usable,
 * without needing a partial unique index.
 */
export async function issueCustomerToken(options: {
  businessId: Types.ObjectId | string;
  customerId: Types.ObjectId | string;
  type: CustomerTokenType;
  ttlMs: number;
}): Promise<{ rawToken: string; expiresAt: Date } | null> {
  const business = objectId(options.businessId);
  const customer = objectId(options.customerId);
  const rawToken = generateActionToken();
  const tokenHash = hashActionToken(rawToken);
  let issued: { rawToken: string; expiresAt: Date } | null = null;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      issued = null;
      const now = new Date();
      // Serialization point: concurrent issuers write the same document.
      const lock = await Customer.updateOne(
        { _id: customer, business, active: true },
        { $set: { updatedAt: now } },
        { session, timestamps: false },
      );
      if (lock.matchedCount !== 1) return;
      await CustomerActionToken.updateMany(
        { business, customer, type: options.type, usedAt: null },
        { $set: { usedAt: now } },
        { session },
      );
      const expiresAt = new Date(now.getTime() + options.ttlMs);
      await CustomerActionToken.create(
        [{ business, customer, type: options.type, tokenHash, expiresAt }],
        { session },
      );
      issued = { rawToken, expiresAt };
    });
  } finally {
    await session.endSession();
  }
  return issued;
}

function tokenFilter(businessId: Types.ObjectId | string, rawToken: string, type: CustomerTokenType, now: Date) {
  return {
    tokenHash: hashActionToken(rawToken),
    business: objectId(businessId),
    type,
    usedAt: null,
    expiresAt: { $gt: now },
  };
}

function isWellFormed(rawToken: unknown): rawToken is string {
  return typeof rawToken === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(rawToken);
}

/**
 * Looks up a still-usable token WITHOUT consuming it (used to check a second
 * factor, e.g. the account password, before spending the token).
 */
export async function findUsableCustomerToken(options: {
  businessId: Types.ObjectId | string;
  rawToken: string;
  type: CustomerTokenType;
  now?: Date;
}): Promise<{ customerId: Types.ObjectId } | null> {
  if (!isWellFormed(options.rawToken)) return null;
  const found = await CustomerActionToken.findOne(
    tokenFilter(options.businessId, options.rawToken, options.type, options.now ?? new Date()),
  )
    .select("customer")
    .lean();
  return found ? { customerId: found.customer } : null;
}

/**
 * Atomically consumes a token for THIS business and type. Returns the customer
 * id on success, or null for unknown, malformed, expired, already-used, wrong
 * type and other-business tokens (indistinguishable to callers).
 */
export async function consumeCustomerToken(options: {
  businessId: Types.ObjectId | string;
  rawToken: string;
  type: CustomerTokenType;
  session?: ClientSession;
  now?: Date;
}): Promise<{ customerId: Types.ObjectId } | null> {
  if (!isWellFormed(options.rawToken)) return null;
  const now = options.now ?? new Date();
  const consumed = await CustomerActionToken.findOneAndUpdate(
    tokenFilter(options.businessId, options.rawToken, options.type, now),
    { $set: { usedAt: now } },
    { new: true, session: options.session },
  )
    .select("customer")
    .lean();
  return consumed ? { customerId: consumed.customer } : null;
}
