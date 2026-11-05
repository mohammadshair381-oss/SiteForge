/**
 * The state a custom domain is in, in the owner's terms (pure).
 *
 * - `pending`: waiting for the TXT record that proves ownership.
 * - `failed`: the last check found a real problem (ownership, DNS or certificate).
 * - `expired`: the verification request ran out before it was proven.
 * - `verified`: ownership is proven. That alone does not make a store reachable.
 * - `active`: DNS points at SiteForge and a valid certificate was confirmed.
 * - `stale`: the ownership proof is too old; it does not serve until renewed.
 * - `revoked`: removed, or replaced by another domain.
 */
export type DomainLifecycleState = "pending" | "failed" | "expired" | "verified" | "active" | "stale" | "revoked";

export interface DomainLifecycleInput {
  status: "pending" | "verified" | "revoked";
  /** Whether the ownership proof is recent enough to trust. */
  ownershipFresh: boolean;
  /** Whether this is the domain the store has chosen (`Business.customDomain`). */
  selected: boolean;
  expiresAt?: Date | null;
  attempts?: number;
  lastError?: string | null;
  activatedAt?: Date | null;
  routingStatus?: string | null;
  certificateStatus?: string | null;
}

/**
 * Whether production may serve a store on this domain. Ownership, plan and the store's
 * own choice are checked separately (`lib/tenant.ts`). A domain verified before activation
 * existed has no `activationRequired`, and keeps serving until a check says otherwise.
 */
export function domainMayServeInProduction(record: { activatedAt?: Date | null; activationRequired?: boolean }): boolean {
  return Boolean(record.activatedAt) || record.activationRequired !== true;
}

export function domainLifecycleState(input: DomainLifecycleInput, now: Date = new Date()): DomainLifecycleState {
  if (input.status === "revoked") return "revoked";
  if (input.status === "pending") {
    if (input.expiresAt && new Date(input.expiresAt).getTime() <= now.getTime()) return "expired";
    return input.lastError && (input.attempts ?? 0) > 0 ? "failed" : "pending";
  }
  if (!input.ownershipFresh) return "stale";
  if (!input.selected) return "verified";
  if (input.activatedAt) return "active";
  return input.routingStatus === "failed" || input.certificateStatus === "failed" ? "failed" : "verified";
}
