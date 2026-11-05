import type { FilterQuery } from "mongoose";
import {
  DomainVerification,
  type DomainVerificationDoc,
} from "@/models/DomainVerification";

/**
 * Non-destructive normalization of DomainVerification records written before
 * the `status` lifecycle field existed. The selection criteria mirror
 * `domainStatusOf` exactly, so the migration only persists what the runtime
 * already infers. Only `status`, `expiresAt` and `revokedAt` are written;
 * nothing is deleted and no index is touched.
 *
 * Both filters require `status` to be absent/null, so the migration is
 * idempotent (a migrated record no longer matches) and never touches records
 * created by the new lifecycle code or legacy pending records.
 *
 * This module has no side effects on import. `scripts/domain-migration.ts` is
 * the operator entry point (dry-run by default).
 */

/** Legacy verified: DNS proven and not superseded by a later removal. */
export const LEGACY_VERIFIED_FILTER: FilterQuery<DomainVerificationDoc> = {
  status: null,
  verifiedAt: { $ne: null },
  $expr: { $not: { $gt: ["$usedAt", "$verifiedAt"] } },
};

/** Legacy removed: the old DELETE stamped `usedAt` after `verifiedAt`. */
export const LEGACY_REVOKED_FILTER: FilterQuery<DomainVerificationDoc> = {
  status: null,
  verifiedAt: { $ne: null },
  $expr: { $gt: ["$usedAt", "$verifiedAt"] },
};

export interface LegacyDomainMigrationPlan {
  /** Verified records to mark `verified` and shield from the TTL monitor. */
  verified: number;
  /** Legacy-verified records whose `expiresAt` is already in the past (TTL will remove them if not migrated). */
  verifiedExpiredAtRisk: number;
  /** Removed records to mark `revoked`. */
  revoked: number;
}

/** Read-only: counts what `applyLegacyDomainMigration` would change. */
export async function planLegacyDomainMigration(
  now = new Date(),
): Promise<LegacyDomainMigrationPlan> {
  const [verified, verifiedExpiredAtRisk, revoked] = await Promise.all([
    DomainVerification.countDocuments(LEGACY_VERIFIED_FILTER),
    DomainVerification.countDocuments({
      ...LEGACY_VERIFIED_FILTER,
      expiresAt: { $lte: now },
    }),
    DomainVerification.countDocuments(LEGACY_REVOKED_FILTER),
  ]);
  return { verified, verifiedExpiredAtRisk, revoked };
}

/** Writes the normalization. Only call after an operator has approved it. */
export async function applyLegacyDomainMigration(
  now = new Date(),
): Promise<{ verified: number; revoked: number }> {
  const verified = await DomainVerification.updateMany(
    LEGACY_VERIFIED_FILTER,
    // `ownershipCheckedAt: now` starts a bounded (DOMAIN_OWNERSHIP_MAX_AGE_MS)
    // grandfather window; without it old proofs would be stale immediately.
    { $set: { status: "verified", expiresAt: null, ownershipCheckedAt: now } },
    { timestamps: false },
  );
  const revoked = await DomainVerification.updateMany(
    LEGACY_REVOKED_FILTER,
    { $set: { status: "revoked", revokedAt: now, expiresAt: null } },
    { timestamps: false },
  );
  return { verified: verified.modifiedCount, revoked: revoked.modifiedCount };
}
