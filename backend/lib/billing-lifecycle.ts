import crypto from "node:crypto";
import type { SubscriptionStatus } from "@/lib/constants";

/**
 * Provider-independent SaaS subscription lifecycle, used by the Razorpay adapter
 * (lib/billing-razorpay.ts). A provider adapter
 * (docs/subscription-billing-architecture.md) must:
 *   1. verify the webhook (`verifyTimestampedSignature`, or the provider's own
 *      scheme with an equivalent replay window);
 *   2. re-read the object from the provider API where the provider allows it;
 *   3. map it to a `NormalizedBillingEvent`;
 *   4. call `reduceSubscription` with the CURRENT stored state and plan, and
 *      persist the result with a conditional update + the event id (unique),
 *      in one transaction (as `api/webhooks/payments` does today).
 *
 * The reducer is pure: no I/O, no clock (the caller passes `now`), so every
 * rule below is unit-tested without a provider.
 */

export const BILLING_EVENT_TYPES = [
  "subscription.activated",
  "subscription.renewed",
  "payment.failed",
  "subscription.canceled",
  "subscription.cancel_scheduled",
  "subscription.plan_changed",
  "payment.refunded",
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export interface NormalizedBillingEvent {
  provider: string;
  /** Provider's unique event id (stored; duplicates are ignored). */
  eventId: string;
  type: BillingEventType;
  /** When the provider says the event happened (NOT when it arrived). */
  occurredAt: Date;
  providerSubscriptionId: string;
  /** Plan the provider object refers to (mapped from the provider's price id). */
  planKey?: string;
  periodStart?: Date;
  periodEnd?: Date;
  /** Amount actually charged/refunded, in the currency subunit. */
  amountMinor?: number;
  currency?: string;
}

export interface SubscriptionState {
  status: SubscriptionStatus;
  planKey: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Paid access continues until this time after a failed renewal. */
  graceUntil: Date | null;
  /** occurredAt of the newest applied event (ordering guard). */
  lastEventAt: Date | null;
  /** Recently applied event ids (duplicate guard; the DB unique index is authoritative). */
  appliedEventIds: string[];
}

export interface PlanPrice {
  key: string;
  /** Price per period in the currency subunit. */
  amountMinor: number;
  currency: string;
}

export type ReduceOutcome =
  | { effect: "applied"; state: SubscriptionState }
  | { effect: "ignored"; reason: "duplicate" | "out_of_order" | "no_change"; state: SubscriptionState }
  | { effect: "rejected"; reason: "subscription_mismatch" | "unknown_plan" | "amount_mismatch" | "missing_period"; state: SubscriptionState };

export const DEFAULT_GRACE_DAYS = 3;
const MAX_REMEMBERED_EVENTS = 50;

function remember(state: SubscriptionState, event: NormalizedBillingEvent): SubscriptionState {
  return {
    ...state,
    lastEventAt: event.occurredAt,
    appliedEventIds: [...state.appliedEventIds, event.eventId].slice(-MAX_REMEMBERED_EVENTS),
  };
}

/**
 * Next subscription state for one verified, normalized provider event.
 * `plans` maps plan keys to their CURRENT price (the price the subscriber
 * agreed to must be versioned before price changes are supported).
 */
export function reduceSubscription(
  state: SubscriptionState,
  event: NormalizedBillingEvent,
  plans: ReadonlyMap<string, PlanPrice>,
  options: { now: Date; graceDays?: number },
): ReduceOutcome {
  if (state.appliedEventIds.includes(event.eventId)) return { effect: "ignored", reason: "duplicate", state };
  if (state.providerSubscriptionId && state.providerSubscriptionId !== event.providerSubscriptionId) {
    return { effect: "rejected", reason: "subscription_mismatch", state };
  }
  // Ordering: an event older than the newest applied one must not undo it
  // (e.g. a late "payment.failed" after a successful renewal).
  if (state.lastEventAt && event.occurredAt.getTime() < state.lastEventAt.getTime()) {
    return { effect: "ignored", reason: "out_of_order", state };
  }

  const planKey = event.planKey ?? state.planKey;
  const plan = planKey ? plans.get(planKey) : undefined;
  const base = { ...state, providerSubscriptionId: event.providerSubscriptionId };
  const graceDays = options.graceDays ?? DEFAULT_GRACE_DAYS;

  switch (event.type) {
    case "subscription.activated":
    case "subscription.renewed": {
      if (!plan) return { effect: "rejected", reason: "unknown_plan", state };
      if (event.amountMinor !== plan.amountMinor || (event.currency ?? "").toUpperCase() !== plan.currency.toUpperCase()) {
        return { effect: "rejected", reason: "amount_mismatch", state };
      }
      if (!event.periodEnd || !event.periodStart || event.periodEnd.getTime() <= event.periodStart.getTime()) {
        return { effect: "rejected", reason: "missing_period", state };
      }
      return {
        effect: "applied",
        state: remember(
          {
            ...base,
            status: "active",
            planKey: plan.key,
            currentPeriodStart: event.periodStart,
            currentPeriodEnd: event.periodEnd,
            graceUntil: null,
            cancelAtPeriodEnd: event.type === "subscription.renewed" ? base.cancelAtPeriodEnd : false,
          },
          event,
        ),
      };
    }
    case "payment.failed": {
      if (state.status === "canceled") return { effect: "ignored", reason: "no_change", state };
      return {
        effect: "applied",
        state: remember(
          {
            ...base,
            status: "past_due",
            // Each failed retry reports again; the grace period runs from the first.
            graceUntil: state.status === "past_due" && state.graceUntil ? state.graceUntil : new Date(options.now.getTime() + graceDays * 24 * 60 * 60 * 1000),
          },
          event,
        ),
      };
    }
    case "subscription.cancel_scheduled":
      return { effect: "applied", state: remember({ ...base, cancelAtPeriodEnd: true }, event) };
    case "subscription.canceled":
      return {
        effect: "applied",
        state: remember({ ...base, status: "canceled", cancelAtPeriodEnd: false, graceUntil: null }, event),
      };
    case "subscription.plan_changed": {
      if (!plan || !event.planKey) return { effect: "rejected", reason: "unknown_plan", state };
      return { effect: "applied", state: remember({ ...base, planKey: plan.key }, event) };
    }
    case "payment.refunded":
      // A refund is recorded as a payment fact by the caller; it never grants
      // or extends access. Whether a refund also cancels is a business policy
      // decision, delivered as a separate "subscription.canceled" event.
      return { effect: "applied", state: remember(base, event) };
  }
}

/**
 * Whether the state grants paid access at `now`: active/trialing within the
 * period, or past_due within the grace period. (Wiring the grace period into
 * `lib/billing.ts` is part of the provider integration.)
 */
export function grantsAccess(state: SubscriptionState, now: Date): boolean {
  if (state.status === "active" || state.status === "trialing") {
    return !state.currentPeriodEnd || state.currentPeriodEnd.getTime() > now.getTime();
  }
  if (state.status === "past_due") return Boolean(state.graceUntil && state.graceUntil.getTime() > now.getTime());
  return false;
}

/**
 * Generic timestamped webhook signature with a replay window:
 * HMAC-SHA256(secret, `${timestamp}.${rawBody}`), timestamp in Unix seconds.
 * Rejects stale or future-dated deliveries beyond `toleranceSeconds`.
 */
export function verifyTimestampedSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: "missing" | "malformed" | "outside_window" | "mismatch" } {
  const { rawBody, timestamp, signature, secret } = input;
  if (!timestamp || !signature || !secret) return { ok: false, reason: "missing" };
  if (!/^\d{1,12}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: "malformed" };
  const tolerance = input.toleranceSeconds ?? 300;
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "outside_window" };
  }
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}
