import { Schema, model, models, type Model, type Types } from "mongoose";
import crypto from "node:crypto";

/**
 * DomainVerification tracks custom-domain ownership verification for a
 * business. A custom domain becomes active on a storefront only after the
 * business owner proves DNS control by creating a TXT record containing a
 * server-issued verification token.
 *
 * Design:
 * - The raw verification token is 256 random bits (base64url). Only its
 *   SHA-256 hash is stored; the raw value is delivered once to the business
 *   owner via the dashboard/API response and is never logged or persisted.
 * - A single record per domain is kept for the lifetime of the domain: a
 *   re-request refreshes the same document instead of inserting a second one,
 *   so the existing unique indexes stay valid.
 * - Verification is atomic: `findOneAndUpdate` moves the record from `pending`
 *   to `verified`, so two concurrent callers can never both activate.
 * - A single business has at most one *active* custom domain, authoritative on
 *   `Business.customDomain`. Verifying a second domain revokes the previous
 *   one (`status: "revoked"`).
 * - `expiresAt` only applies to pending requests. It is set to `null` once a
 *   record is verified or revoked, and the TTL index ignores non-date values,
 *   so a verified domain is never deleted when its original token expires.
 *   The TTL index is eventual cleanup only; pending validity is always checked
 *   explicitly against `expiresAt`.
 */

export const DOMAIN_VERIFICATION_STATUSES = ["pending", "verified", "revoked"] as const;

export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

export interface DomainVerificationDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  domain: string; // normalized lowercase domain
  tokenHash: string; // SHA-256 of the raw verification token
  /**
   * Lifecycle status. Optional in the type because records written before this
   * field existed do not have it; read them through `domainStatusOf`.
   */
  status?: DomainVerificationStatus;
  /** Pending-token expiry. `null` for verified/revoked records (never expired). */
  expiresAt: Date | null;
  /** Legacy marker: token consumed by the pre-lifecycle implementation. */
  usedAt: Date | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  /**
   * When DNS control was last *proven* (initial verification or a renewal).
   * Ownership freshness is measured from this; legacy records without it fall
   * back to `verifiedAt`. See `isDomainOwnershipFresh`.
   */
  ownershipCheckedAt?: Date | null;
  /** Pending renewal token (SHA-256 hash) for an already-verified domain. */
  renewalTokenHash?: string | null;
  renewalExpiresAt?: Date | null;
  /** Number of verification attempts that reached the DNS check. */
  attempts: number;
  lastAttemptAt: Date | null;
  /** Machine-readable reason for the most recent failed attempt. */
  lastError: string | null;
  /** Whether DNS points at SiteForge: `unchecked`, `ok` or `failed`. */
  routingStatus?: string | null;
  routingCheckedAt?: Date | null;
  routingError?: string | null;
  /** `not_started`, `not_configured`, `pending`, `issued` or `failed`. */
  certificateStatus?: string | null;
  certificateRef?: string | null;
  certificateCheckedAt?: Date | null;
  certificateExpiresAt?: Date | null;
  certificateError?: string | null;
  /**
   * Set only once DNS and a certificate were both confirmed
   * (`lib/domains/activation.ts`). In production a domain does not serve without it.
   */
  activatedAt?: Date | null;
  /**
   * True once a domain must be activated before it serves in production. ABSENT means it
   * was verified before these checks existed, and it keeps working as it did (like
   * `User.emailVerifiedAt`), so it has no schema default.
   */
  activationRequired?: boolean;
  /** The last time each check really succeeded, whatever has happened since. */
  lastDnsOkAt?: Date | null;
  lastCertificateOkAt?: Date | null;
  lastHealthCheckAt?: Date | null;
  /** When a definite DNS or certificate failure began. Cleared by a good check. */
  failingSince?: Date | null;
  /** Checks in a row a lookup or provider could not answer. Says nothing about the domain. */
  temporaryFailureCount?: number;
  lastTemporaryFailureAt?: Date | null;
  /** `not_applicable`, `not_configured`, `external`, `not_due`, `due`, `in_progress`, `renewed` or `failed`. */
  renewalStatus?: string | null;
  renewalLastAttemptAt?: Date | null;
  renewalLastSuccessAt?: Date | null;
  renewalFailureCount?: number;
  renewalLastError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const domainVerificationSchema = new Schema<DomainVerificationDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    tokenHash: { type: String, required: true },
    status: {
      type: String,
      enum: DOMAIN_VERIFICATION_STATUSES,
      default: "pending",
    },
    // Optional: verified/revoked records store null so the TTL index ignores
    // them. A schema default of null is intentional (the TTL monitor does not
    // delete documents whose indexed field is not a date).
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    // No schema default: absent means "legacy, fall back to verifiedAt".
    ownershipCheckedAt: { type: Date },
    renewalTokenHash: { type: String, default: null },
    // Deliberately NOT indexed for TTL: a renewal window must never delete
    // the (verified) record.
    renewalExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    routingStatus: { type: String, default: "unchecked" },
    routingCheckedAt: { type: Date, default: null },
    routingError: { type: String, default: null },
    certificateStatus: { type: String, default: "not_started" },
    certificateRef: { type: String, default: null },
    certificateCheckedAt: { type: Date, default: null },
    certificateExpiresAt: { type: Date, default: null },
    certificateError: { type: String, default: null },
    activatedAt: { type: Date, default: null },
    // No default: absent is what marks a domain verified before activation existed.
    activationRequired: { type: Boolean },
    lastDnsOkAt: { type: Date, default: null },
    lastCertificateOkAt: { type: Date, default: null },
    lastHealthCheckAt: { type: Date, default: null },
    failingSince: { type: Date, default: null },
    temporaryFailureCount: { type: Number, default: 0, min: 0 },
    lastTemporaryFailureAt: { type: Date, default: null },
    renewalStatus: { type: String, default: "not_applicable" },
    renewalLastAttemptAt: { type: Date, default: null },
    renewalLastSuccessAt: { type: Date, default: null },
    renewalFailureCount: { type: Number, default: 0, min: 0 },
    renewalLastError: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);

// One record per domain across all businesses. Re-requests reuse this
// document; a revoked record may be taken over atomically by another business.
domainVerificationSchema.index(
  { domain: 1 },
  {
    name: "domain_verification_1",
    unique: true,
    partialFilterExpression: { domain: { $gt: "" } },
  },
);

// One record per business+domain combo.
domainVerificationSchema.index({ business: 1, domain: 1 }, { unique: true });

// TTL cleanup of pending verification records. Unchanged from the original
// index definition: because verified/revoked records store `expiresAt: null`,
// the TTL monitor ignores them and they survive the token's original expiry.
domainVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Resolves the effective lifecycle status of a record, including legacy
 * documents written before the `status` field existed.
 *
 * Legacy rules (the old implementation only wrote `usedAt`/`verifiedAt`):
 * - `verifiedAt` set and not superseded by a later `usedAt` => verified
 *   (the old code consumed the token *before* the DNS check, so a successful
 *   legacy record always has `usedAt <= verifiedAt`).
 * - `usedAt` later than `verifiedAt` => the record was removed => revoked.
 * - only `usedAt` set => consumed without verification => revoked.
 * - neither => pending.
 */
export function domainStatusOf(record: {
  status?: string | null;
  verifiedAt?: Date | null;
  usedAt?: Date | null;
}): DomainVerificationStatus {
  if (
    record.status === "pending" ||
    record.status === "verified" ||
    record.status === "revoked"
  ) {
    return record.status;
  }

  if (record.verifiedAt) {
    if (record.usedAt && record.usedAt.getTime() > record.verifiedAt.getTime()) {
      return "revoked";
    }
    return "verified";
  }

  if (record.usedAt) return "revoked";
  return "pending";
}

/**
 * How long a DNS ownership proof is trusted for routing. After this the domain
 * stays `verified` (nothing is deleted) but stops serving until the owner
 * renews the proof. There is no background monitoring: this bound is the only
 * protection against a domain changing hands after verification.
 */
export const DOMAIN_OWNERSHIP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** The dashboard warns owners this long before the proof expires. */
export const DOMAIN_OWNERSHIP_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

/** When the current ownership proof stops being trusted, or null if never proven. */
export function domainOwnershipExpiry(record: {
  ownershipCheckedAt?: Date | null;
  verifiedAt?: Date | null;
}): Date | null {
  const anchor = record.ownershipCheckedAt ?? record.verifiedAt ?? null;
  if (!anchor) return null;
  return new Date(anchor.getTime() + DOMAIN_OWNERSHIP_MAX_AGE_MS);
}

/** Fail-closed freshness check: no proof timestamp means not fresh. */
export function isDomainOwnershipFresh(
  record: { ownershipCheckedAt?: Date | null; verifiedAt?: Date | null },
  now: Date = new Date(),
): boolean {
  const expiry = domainOwnershipExpiry(record);
  return !!expiry && expiry.getTime() > now.getTime();
}

/** A domain starts again from here whenever its ownership or its use by a store changes. */
export const DOMAIN_ACTIVATION_CLEARED = {
  routingStatus: "unchecked",
  routingCheckedAt: null,
  routingError: null,
  certificateStatus: "not_started",
  certificateRef: null,
  certificateCheckedAt: null,
  certificateExpiresAt: null,
  certificateError: null,
  activatedAt: null,
  activationRequired: true,
  lastDnsOkAt: null,
  lastCertificateOkAt: null,
  lastHealthCheckAt: null,
  failingSince: null,
  temporaryFailureCount: 0,
  lastTemporaryFailureAt: null,
  renewalStatus: "not_applicable",
  renewalLastAttemptAt: null,
  renewalLastSuccessAt: null,
  renewalFailureCount: 0,
  renewalLastError: null,
} as const;

/**
 * Generates a URL-safe verification token with 256 bits of entropy.
 */
export function generateDomainVerificationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest of a raw verification token. */
export function hashDomainVerificationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Compares a submitted raw token against a stored token hash in constant time.
 * Never logs the raw token or the hash.
 */
export function domainVerificationTokenMatches(
  rawToken: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!rawToken || !storedHash) return false;
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false;

  const candidate = Buffer.from(
    hashDomainVerificationToken(rawToken),
    "hex",
  );
  const expected = Buffer.from(storedHash, "hex");
  if (candidate.length !== expected.length) return false;

  return crypto.timingSafeEqual(candidate, expected);
}

export const DomainVerification: Model<DomainVerificationDoc> =
  (models.DomainVerification as Model<DomainVerificationDoc>) ||
  model<DomainVerificationDoc>("DomainVerification", domainVerificationSchema);
