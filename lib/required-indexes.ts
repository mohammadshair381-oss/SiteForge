import { HttpError } from "@/lib/api";
import { NAMESPACE_NOT_FOUND, matchesUniqueIndex, type StoredIndex, type UniqueIndexRule } from "@/lib/core-indexes";
import { dbConnect } from "@/lib/db";
import { BillingAdjustment } from "@/models/BillingAdjustment";
import { BillingEvent } from "@/models/BillingEvent";
import { Business } from "@/models/Business";
import { Cart } from "@/models/Cart";
import { DomainVerification } from "@/models/DomainVerification";
import { Notification } from "@/models/Notification";
import { OrderRefund } from "@/models/OrderRefund";
import { TeamInvitation } from "@/models/TeamInvitation";

/**
 * Features whose safety rests on a unique index stay off until that index exists
 * (server-only). Creating indexes on a persistent database is an approved operator
 * step (docs/database-preparation.md), so nothing here creates one: this only looks, at
 * the database itself. A schema declaring an index says nothing about whether it exists.
 * Automated tests run on throwaway databases with no indexes built, so the check does
 * not apply to them. The indexes every part of the platform needs are in lib/core-indexes.ts.
 */
export type IndexedFeature = "team_invitations" | "subscription_billing" | "custom_domains" | "customer_carts" | "notifications" | "order_refunds";

export const FEATURE_LABELS: Record<IndexedFeature, string> = {
  team_invitations: "Team invitations",
  subscription_billing: "Subscription billing",
  custom_domains: "Custom domains",
  customer_carts: "Carts saved to customer accounts",
  notifications: "Notification centre",
  order_refunds: "Razorpay refunds on store orders",
};

interface RequiredIndex extends UniqueIndexRule {
  model: () => { listIndexes: () => Promise<unknown> };
  name: string;
}

const REQUIRED: Record<IndexedFeature, RequiredIndex[]> = {
  team_invitations: [
    { model: () => TeamInvitation, name: "teaminvitations", key: { tokenHash: 1 } },
    { model: () => TeamInvitation, name: "teaminvitations", key: { business: 1, email: 1 }, partial: { status: "pending" }, partialRequired: true },
  ],
  subscription_billing: [
    { model: () => BillingEvent, name: "billingevents", key: { provider: 1, eventId: 1 } },
    { model: () => BillingAdjustment, name: "billingadjustments", key: { kind: 1, providerId: 1 }, partial: { providerId: { $gt: "" } } },
  ],
  // One cart per customer per store. Without it, a shopper's carts could split in two.
  customer_carts: [{ model: () => Cart, name: "carts", key: { business: 1, customer: 1 }, partial: { customer: { $exists: true } }, partialRequired: true }],
  // Each event is announced once. Without it, the same event could be listed twice.
  notifications: [{ model: () => Notification, name: "notifications", key: { business: 1, dedupeKey: 1 } }],
  custom_domains: [
    { model: () => Business, name: "businesses", key: { customDomain: 1 }, partial: { customDomain: { $gt: "" } } },
    { model: () => DomainVerification, name: "domainverifications", key: { domain: 1 }, partial: { domain: { $gt: "" } } },
  ],
  // One record per refund at Razorpay. A full index would refuse every refund with no provider id yet,
  // so only this filter will do. Without it, a refund could be recorded twice.
  order_refunds: [{ model: () => OrderRefund, name: "orderrefunds", key: { providerRefundId: 1 }, partial: { providerRefundId: { $type: "string" } }, partialRequired: true }],
};

/** "unknown" when the database could not say, which must not read as "missing". */
async function hasUniqueIndex(required: RequiredIndex): Promise<boolean | "unknown"> {
  try {
    const indexes = (await required.model().listIndexes()) as StoredIndex[];
    return indexes.some((index) => matchesUniqueIndex(index, required));
  } catch (error) {
    // The collection does not exist yet, which means no index either.
    return error && typeof error === "object" && (error as { code?: unknown }).code === NAMESPACE_NOT_FOUND ? false : "unknown";
  }
}

const describeIndex = (required: RequiredIndex) => `${required.name} ${JSON.stringify(required.key)}${required.partial ? ` where ${JSON.stringify(required.partial)}` : ""}`;

async function inspectFeature(feature: IndexedFeature) {
  await dbConnect();
  return Promise.all(REQUIRED[feature].map(async (required) => ({ required, found: await hasUniqueIndex(required) })));
}

const READY_CACHE: Partial<Record<IndexedFeature, boolean>> = {};
const NOT_READY_RECHECK_MS = 60_000;
const lastChecked: Partial<Record<IndexedFeature, number>> = {};

export async function missingIndexes(feature: IndexedFeature): Promise<string[]> {
  const results = await inspectFeature(feature);
  return results.filter(({ found }) => found !== true).map(({ required, found }) => (found === "unknown" ? `${describeIndex(required)} (could not be checked)` : describeIndex(required)));
}

/** Once found ready it stays ready for this process; a missing index is looked for again soon. */
export async function isFeatureReady(feature: IndexedFeature): Promise<boolean> {
  if (process.env.NODE_ENV === "test") return true;
  if (READY_CACHE[feature]) return true;
  const checkedAt = lastChecked[feature] ?? 0;
  if (Date.now() - checkedAt < NOT_READY_RECHECK_MS && READY_CACHE[feature] === false) return false;
  const results = await inspectFeature(feature);
  // A database that could not answer proves nothing, so the next request asks again.
  if (results.some(({ found }) => found === "unknown")) return false;
  const ready = results.every(({ found }) => found === true);
  READY_CACHE[feature] = ready;
  lastChecked[feature] = Date.now();
  return ready;
}

export async function assertFeatureReady(feature: IndexedFeature): Promise<void> {
  if (!(await isFeatureReady(feature))) {
    throw new HttpError(503, "This feature is not switched on yet. Please contact support.", "feature_not_ready");
  }
}
