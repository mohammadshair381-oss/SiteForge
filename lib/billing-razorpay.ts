import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { DEFAULT_GRACE_DAYS, reduceSubscription, type BillingEventType, type NormalizedBillingEvent, type SubscriptionState } from "@/lib/billing-lifecycle";
import { dbConnect } from "@/lib/db";
import { notifySubscription } from "@/lib/notification-events";
import {
  RazorpayApiError,
  cancelRazorpayScheduledChanges,
  cancelRazorpaySubscription,
  createRazorpayPlan,
  createRazorpaySubscription,
  fetchDispute,
  fetchRazorpayPayment,
  fetchRefund,
  fetchRazorpaySubscription,
  isTrustedPaymentLinkUrl,
  keyIdMatchesMode,
  listRazorpaySubscriptionInvoices,
  toMinorUnits,
  updateRazorpaySubscription,
  type FetchLike,
  type RazorpayCredentials,
  type RazorpaySubscription,
} from "@/lib/payments/razorpay";
import { assertFeatureReady, isFeatureReady } from "@/lib/required-indexes";
import { BillingAdjustment } from "@/models/BillingAdjustment";
import { BillingEvent } from "@/models/BillingEvent";
import { Payment } from "@/models/Payment";
import { Plan, type PlanDoc, type ProviderPlan } from "@/models/Plan";
import { Subscription, type SubscriptionDoc } from "@/models/Subscription";

/**
 * SaaS subscription billing through Razorpay Subscriptions (server-only).
 *
 * This is SiteForge charging store owners, on SiteForge's OWN Razorpay account and
 * keys. It shares nothing with the storefront checkout (lib/payments/order-payments.ts),
 * where each store uses its own account; a webhook for one is never read by the other.
 *
 * Razorpay is the source of truth for money, and access changes only from what it
 * reports: a signed webhook is only a prompt to re-read the subscription from the API,
 * which also makes the order webhooks arrive in irrelevant. The state then goes through
 * the pure reducer in lib/billing-lifecycle.ts, and is saved with the event id and any
 * payment in one transaction. A browser redirect or message never changes anything.
 *
 * Implemented against Razorpay's documentation and tested with a mocked Razorpay only.
 * See docs/subscription-billing-architecture.md for what still needs checking for real.
 */

export type BillingMode = "test" | "live";

export interface BillingConfig {
  credentials: RazorpayCredentials;
  webhookSecret: string;
  mode: BillingMode;
}

/** Null unless Razorpay is selected and every value is valid. Live keys also need their own approval. */
export function billingConfig(): BillingConfig | null {
  if (process.env.PAYMENT_PROVIDER !== "razorpay") return null;
  const keyId = process.env.RAZORPAY_BILLING_KEY_ID?.trim() ?? "";
  const keySecret = process.env.RAZORPAY_BILLING_KEY_SECRET?.trim() ?? "";
  const webhookSecret = process.env.RAZORPAY_BILLING_WEBHOOK_SECRET?.trim() ?? "";
  if (!keyId || !keySecret || !webhookSecret) return null;
  const mode: BillingMode | null = keyIdMatchesMode(keyId, "test") ? "test" : keyIdMatchesMode(keyId, "live") ? "live" : null;
  if (!mode) return null;
  if (mode === "live" && process.env.BILLING_LIVE_ALLOWED !== "true") return null;
  return { credentials: { keyId, keySecret }, webhookSecret, mode };
}

function requireConfig(): BillingConfig {
  const config = billingConfig();
  if (!config) throw new HttpError(503, "Online billing is not available yet. Please try again later.", "billing_not_configured");
  return config;
}

export function billingGraceDays(): number {
  const value = Number(process.env.BILLING_GRACE_DAYS);
  return Number.isInteger(value) && value >= 0 && value <= 30 ? value : DEFAULT_GRACE_DAYS;
}

/** Razorpay needs an end; a store reaching it subscribes again. */
const TOTAL_CYCLES: Record<PlanDoc["interval"], number> = { month: 60, year: 10 };
const CHECKOUT_REUSE_MS = 24 * 60 * 60 * 1000;
const CHECKOUT_EXPIRES_S = 7 * 24 * 60 * 60;

const providerFailure = (message: string) => new HttpError(502, message, "billing_provider_error");
const asMajor = (minor: number) => Math.round(minor) / 100;
const asDate = (seconds: number | null | undefined) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null);

function currentMapping(plan: Pick<PlanDoc, "price" | "currency" | "interval" | "providerPlans">, mode: BillingMode): ProviderPlan | null {
  const amountMinor = toMinorUnits(plan.price);
  return (
    (plan.providerPlans ?? []).find(
      (entry) => entry.provider === "razorpay" && entry.mode === mode && entry.amountMinor === amountMinor && entry.currency === plan.currency.toUpperCase() && entry.interval === plan.interval,
    ) ?? null
  );
}

/** A Razorpay plan's price cannot change, so a new price gets a new one; older subscribers keep theirs. */
export async function ensureProviderPlan(planKey: string, fetchImpl?: FetchLike): Promise<{ plan: PlanDoc; mapping: ProviderPlan; created: boolean }> {
  const config = requireConfig();
  await dbConnect();
  const plan = await Plan.findOne({ key: planKey }).lean<PlanDoc & { _id: unknown }>();
  if (!plan) throw new HttpError(404, "Plan not found", "not_found");
  const amountMinor = toMinorUnits(plan.price);
  if (!amountMinor) throw new HttpError(409, "Free plans are not billed through Razorpay.", "plan_not_billable");
  const existing = currentMapping(plan, config.mode);
  if (existing) return { plan, mapping: existing, created: false };

  let remote;
  try {
    remote = await createRazorpayPlan(
      config.credentials,
      { period: plan.interval === "year" ? "yearly" : "monthly", interval: 1, name: plan.name, amountMinor, currency: plan.currency.toUpperCase(), description: plan.description, notes: { siteforge_plan: plan.key } },
      fetchImpl,
    );
  } catch (error) {
    if (error instanceof RazorpayApiError) throw providerFailure("Razorpay did not accept this plan. Check its currency and price.");
    throw error;
  }
  const mapping: ProviderPlan = { provider: "razorpay", mode: config.mode, planId: remote.id, amountMinor, currency: plan.currency.toUpperCase(), interval: plan.interval, createdAt: new Date() };
  await Plan.updateOne({ key: planKey }, { $push: { providerPlans: mapping } });
  return { plan, mapping, created: true };
}

type StoredSubscription = SubscriptionDoc & { _id: mongoose.Types.ObjectId };

async function loadSubscription(businessId: string) {
  return Subscription.findOne({ business: businessId }).sort({ createdAt: -1 }).lean<StoredSubscription>();
}

const isProviderManaged = (subscription: StoredSubscription | null): boolean =>
  Boolean(subscription?.providerSubscriptionId && subscription.provider === "razorpay" && (subscription.status === "active" || subscription.status === "past_due"));

export type CheckoutResult = { kind: "checkout"; url: string } | { kind: "scheduled"; effectiveAt: Date | null };

/**
 * Starts a paid plan: a hosted Razorpay page for someone new, or a change at the end of
 * the current cycle for someone already subscribed. Nothing about access changes here;
 * that waits for Razorpay to report the result.
 */
export async function startPaidPlan(input: { businessId: string; planKey: string; fetchImpl?: FetchLike }): Promise<CheckoutResult> {
  const config = requireConfig();
  await assertFeatureReady("subscription_billing");
  await dbConnect();
  const plan = await Plan.findOne({ key: input.planKey, active: true }).lean<PlanDoc & { _id: mongoose.Types.ObjectId }>();
  if (!plan) throw new HttpError(404, "Plan not found", "not_found");
  const mapping = currentMapping(plan, config.mode);
  if (!mapping) throw new HttpError(409, "This plan is not ready for online payment yet. Please contact support.", "plan_not_mapped");

  const current = await loadSubscription(input.businessId);
  if (current && isProviderManaged(current)) {
    if (current.cancelAtPeriodEnd) throw new HttpError(409, "This subscription is ending. You can choose a new plan once it has ended.", "subscription_ending");
    // Razorpay documents that eMandate subscriptions cannot be updated. For other
    // methods, including UPI AutoPay, it is Razorpay's answer below that decides.
    if (current.providerPaymentMethod === "emandate") {
      throw new HttpError(409, "This subscription pays by bank mandate, which Razorpay does not allow to change plan. Cancel it at the end of the period, then choose the new plan.", "plan_change_unsupported");
    }
    try {
      await updateRazorpaySubscription(config.credentials, current.providerSubscriptionId as string, { planId: mapping.planId, scheduleChangeAt: "cycle_end" }, input.fetchImpl);
    } catch (error) {
      if (error instanceof RazorpayApiError) throw new HttpError(409, "Razorpay did not accept this plan change. This can depend on how the subscription pays. Cancel it at the end of the period, then choose the new plan.", "plan_change_refused");
      throw error;
    }
    // A cancellation that arrived meanwhile wins: a subscription that is ending moves to no paid plan.
    await Subscription.updateOne({ _id: current._id, cancelAtPeriodEnd: { $ne: true } }, { $set: { pendingPlan: plan._id, scheduledChangeAt: current.currentPeriodEnd } });
    return { kind: "scheduled", effectiveAt: current.currentPeriodEnd };
  }

  // A second click returns the same page rather than starting a second subscription.
  const pending = current?.pendingCheckout;
  if (pending?.shortUrl && pending.planId === mapping.planId && Date.now() - new Date(pending.createdAt).getTime() < CHECKOUT_REUSE_MS && isTrustedPaymentLinkUrl(pending.shortUrl)) {
    return { kind: "checkout", url: pending.shortUrl };
  }

  let remote: RazorpaySubscription;
  try {
    remote = await createRazorpaySubscription(
      config.credentials,
      { planId: mapping.planId, totalCount: TOTAL_CYCLES[plan.interval], expireBy: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_S, notes: { siteforge_business: input.businessId, siteforge_plan: plan.key } },
      input.fetchImpl,
    );
  } catch (error) {
    if (error instanceof RazorpayApiError) throw providerFailure("Razorpay could not start this payment. Please try again shortly.");
    throw error;
  }
  if (!isTrustedPaymentLinkUrl(remote.short_url)) throw providerFailure("Razorpay did not return a payment page.");

  const pendingCheckout = { providerSubscriptionId: remote.id, planId: mapping.planId, plan: plan._id, amountMinor: mapping.amountMinor, currency: mapping.currency, mode: config.mode, shortUrl: remote.short_url, createdAt: new Date() };
  await Subscription.findOneAndUpdate(
    { business: input.businessId },
    { $set: { pendingCheckout }, $setOnInsert: { business: input.businessId, plan: plan._id, status: "incomplete", provider: "manual" } },
    { upsert: true, sort: { createdAt: -1 } },
  );
  return { kind: "checkout", url: remote.short_url };
}

/** Ends the subscription when the paid period ends. Razorpay moves it to cancelled then. */
export async function cancelAtCycleEnd(input: { businessId: string; fetchImpl?: FetchLike }): Promise<void> {
  const config = requireConfig();
  await dbConnect();
  const current = await loadSubscription(input.businessId);
  if (!current || !isProviderManaged(current)) throw new HttpError(409, "There is no active subscription to cancel.", "nothing_to_cancel");
  try {
    await cancelRazorpaySubscription(config.credentials, current.providerSubscriptionId as string, { atCycleEnd: true }, input.fetchImpl);
  } catch (error) {
    if (error instanceof RazorpayApiError) throw new HttpError(409, "Razorpay could not schedule this cancellation. It may already be in its last billing period.", "cancel_refused");
    throw error;
  }
  // A paid plan change waiting for the next cycle has no next cycle to happen in, so it goes.
  await Subscription.updateOne({ _id: current._id }, { $set: { cancelAtPeriodEnd: true, pendingPlan: null, scheduledChangeAt: null } });
}

/** Moving to a free plan: the paid one runs to the end of its period, then the store moves over. */
export async function scheduleMoveToFreePlan(input: { businessId: string; freePlanId: unknown; fetchImpl?: FetchLike }): Promise<void> {
  await cancelAtCycleEnd(input);
  const current = await loadSubscription(input.businessId);
  if (current) await Subscription.updateOne({ _id: current._id }, { $set: { pendingPlan: input.freePlanId } });
}

/** Withdraws a plan change that has not happened yet. The current plan simply carries on. */
export async function cancelScheduledPlanChange(input: { businessId: string; fetchImpl?: FetchLike }): Promise<void> {
  const config = requireConfig();
  await dbConnect();
  const current = await loadSubscription(input.businessId);
  if (!current?.pendingPlan || !isProviderManaged(current)) throw new HttpError(409, "There is no plan change waiting.", "nothing_to_cancel");
  if (current.cancelAtPeriodEnd) throw new HttpError(409, "This subscription is ending, and a cancellation cannot be undone.", "cannot_resume");
  try {
    await cancelRazorpayScheduledChanges(config.credentials, current.providerSubscriptionId as string, input.fetchImpl);
  } catch (error) {
    if (error instanceof RazorpayApiError) throw new HttpError(409, "Razorpay could not withdraw this change. It may already have happened.", "cancel_change_refused");
    throw error;
  }
  await Subscription.updateOne({ _id: current._id }, { $set: { pendingPlan: null, scheduledChangeAt: null } });
}

/** Abandons a payment page that was never completed. */
export async function abandonCheckout(input: { businessId: string; fetchImpl?: FetchLike }): Promise<void> {
  const config = requireConfig();
  await dbConnect();
  const current = await loadSubscription(input.businessId);
  const pendingId = current?.pendingCheckout?.providerSubscriptionId;
  if (!current || !pendingId) return;
  await cancelRazorpaySubscription(config.credentials, pendingId, { atCycleEnd: false }, input.fetchImpl).catch(() => undefined);
  await Subscription.updateOne({ _id: current._id }, { $set: { pendingCheckout: null } });
}

export interface InvoiceView {
  id: string;
  number: string | null;
  paymentId: string | null;
  status: string;
  amount: number;
  currency: string;
  billingStart: string | null;
  billingEnd: string | null;
  paidAt: string | null;
  url: string | null;
}

/** From Razorpay, never stored. Only its own hosted links are passed on. */
export async function listInvoices(input: { businessId: string; fetchImpl?: FetchLike }): Promise<InvoiceView[]> {
  const config = billingConfig();
  await dbConnect();
  const current = await loadSubscription(input.businessId);
  if (!config || !current?.providerSubscriptionId) return [];
  const items = await listRazorpaySubscriptionInvoices(config.credentials, current.providerSubscriptionId, input.fetchImpl);
  return items.map((invoice) => ({
    id: invoice.id,
    number: invoice.invoice_number ?? null,
    paymentId: invoice.payment_id ?? null,
    status: invoice.status,
    amount: asMajor(invoice.amount),
    currency: invoice.currency,
    billingStart: asDate(invoice.billing_start)?.toISOString() ?? null,
    billingEnd: asDate(invoice.billing_end)?.toISOString() ?? null,
    paidAt: asDate(invoice.paid_at)?.toISOString() ?? null,
    url: isTrustedPaymentLinkUrl(invoice.short_url) ? invoice.short_url : null,
  }));
}

/**
 * The oldest unpaid invoice's page at Razorpay, for after a failed renewal. Razorpay
 * documents that an older unpaid invoice can be charged manually, but not that every
 * such link stays payable, so the page says it may not work.
 */
export async function paymentRecoveryUrl(input: { businessId: string; fetchImpl?: FetchLike }): Promise<string | null> {
  const invoices = await listInvoices(input);
  const unpaid = [...invoices].reverse().find((invoice) => invoice.status !== "paid" && invoice.status !== "cancelled" && invoice.url);
  return unpaid?.url ?? null;
}

function toState(subscription: StoredSubscription, planKey: string | null): SubscriptionState {
  return {
    status: subscription.status,
    planKey,
    providerSubscriptionId: subscription.providerSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    graceUntil: subscription.graceUntil ?? null,
    lastEventAt: subscription.lastEventAt ?? null,
    appliedEventIds: [],
  };
}

export type SyncOutcome = "applied" | "ignored" | "rejected" | "duplicate" | "unknown_subscription";

/**
 * Brings one subscription in line with what Razorpay reports now. `eventId` makes it
 * once-only per webhook; a sync the owner asks for has none. `paymentId` is a payment
 * named by the webhook, which is re-read before anything is recorded.
 */
export async function syncProviderSubscription(input: {
  providerSubscriptionId: string;
  eventId?: string;
  eventType?: string;
  paymentId?: string | null;
  now?: Date;
  fetchImpl?: FetchLike;
}): Promise<SyncOutcome> {
  const config = requireConfig();
  const now = input.now ?? new Date();
  await dbConnect();

  const known = await Subscription.findOne({ $or: [{ providerSubscriptionId: input.providerSubscriptionId }, { "pendingCheckout.providerSubscriptionId": input.providerSubscriptionId }] }).lean<StoredSubscription>();
  if (!known) return "unknown_subscription";
  if (input.eventId && (await BillingEvent.exists({ provider: "razorpay", eventId: input.eventId }))) return "duplicate";

  const remote = await fetchRazorpaySubscription(config.credentials, input.providerSubscriptionId, input.fetchImpl);
  const payment = input.paymentId ? await fetchRazorpayPayment(config.credentials, input.paymentId, input.fetchImpl) : null;
  if (payment && payment.currency && payment.id !== input.paymentId) throw providerFailure("Razorpay returned a different payment.");

  // Which of our plans does Razorpay's plan id mean? An id we never created grants nothing.
  const planDoc = await Plan.findOne({ "providerPlans.planId": remote.plan_id }).lean<PlanDoc & { _id: mongoose.Types.ObjectId }>();
  const mapping = planDoc?.providerPlans?.find((entry) => entry.planId === remote.plan_id) ?? null;

  let outcome: SyncOutcome = "ignored";
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      outcome = "ignored";
      if (input.eventId) {
        if (await BillingEvent.exists({ provider: "razorpay", eventId: input.eventId }).session(session)) {
          outcome = "duplicate";
          return;
        }
      }
      const fresh = await Subscription.findOne({ _id: known._id }).session(session).lean<StoredSubscription>();
      if (!fresh) throw providerFailure("The subscription disappeared.");
      const currentPlan = await Plan.findById(fresh.plan).select("key").session(session).lean<{ key: string }>();
      const isPendingCheckout = fresh.pendingCheckout?.providerSubscriptionId === input.providerSubscriptionId;
      // Only one Razorpay subscription drives a store at a time.
      const state = toState(fresh, currentPlan?.key ?? null);
      if (isPendingCheckout) state.providerSubscriptionId = null;

      const event = eventFromRemote(remote, input.eventId ?? `sync:${now.getTime()}`, now, mapping, planDoc?.key ?? null, payment?.amount ?? null, fresh.providerSubscriptionId === remote.id);
      // A slower read than something already applied says nothing new. The reducer
      // refuses it too; this keeps the fields around the state from going backwards.
      const stale = Boolean(fresh.lastEventAt && new Date(fresh.lastEventAt).getTime() > now.getTime());
      const set: Record<string, unknown> = stale
        ? {}
        : {
            providerStatus: remote.status,
            providerPaymentMethod: remote.payment_method ?? fresh.providerPaymentMethod ?? null,
            scheduledChangeAt: remote.has_scheduled_changes ? asDate(remote.change_scheduled_at) ?? fresh.scheduledChangeAt ?? null : remote.has_scheduled_changes === false ? null : fresh.scheduledChangeAt ?? null,
          };
      if (input.eventId) set.lastWebhookAt = now;
      // A paid plan change that Razorpay no longer has scheduled was withdrawn there.
      if (!stale && remote.has_scheduled_changes === false && fresh.pendingPlan && !fresh.cancelAtPeriodEnd && remote.status === "active") set.pendingPlan = null;

      if (event === "drop_checkout") {
        // Never paid: the page expired or was cancelled. Whatever plan they have stays.
        if (isPendingCheckout) set.pendingCheckout = null;
      } else if (event && (!isPendingCheckout || event.type === "subscription.activated")) {
        const plans = new Map(mapping && planDoc ? [[planDoc.key, { key: planDoc.key, amountMinor: mapping.amountMinor, currency: mapping.currency }]] : []);
        const reduced = reduceSubscription(state, event, plans, { now, graceDays: billingGraceDays() });
        outcome = reduced.effect;
        if (reduced.effect === "applied") {
          const next = reduced.state;
          Object.assign(set, {
            status: next.status,
            provider: "razorpay",
            providerSubscriptionId: next.providerSubscriptionId,
            currentPeriodStart: next.currentPeriodStart,
            currentPeriodEnd: next.currentPeriodEnd,
            cancelAtPeriodEnd: next.cancelAtPeriodEnd,
            graceUntil: next.graceUntil,
            lastEventAt: next.lastEventAt,
          });
          if (planDoc && event.type !== "payment.failed" && event.type !== "subscription.canceled") {
            set.plan = planDoc._id;
            if (String(fresh.pendingPlan) === String(planDoc._id)) set.pendingPlan = null;
          }
          if (isPendingCheckout && event.type === "subscription.activated") Object.assign(set, { pendingCheckout: null, pendingPlan: null });
          if (event.type === "subscription.canceled" && fresh.pendingPlan) {
            // Only a free plan can follow a cancellation: nothing would ever charge for a paid one, and a
            // plan with no period end never expires (lib/billing.ts). So the price is read here, as it is
            // now, inside this transaction. A paid plan is dropped, and the store keeps the plan and period
            // it paid for, as canceled, which grants no access.
            const pending = await Plan.findById(fresh.pendingPlan).select("price").session(session).lean<{ price: number }>();
            if (pending?.price === 0) {
              // The move to a free plan the owner chose takes effect now. With no Razorpay subscription
              // left on the record, a repeated or later event for the old one finds nothing to change.
              Object.assign(set, { plan: fresh.pendingPlan, pendingPlan: null, scheduledChangeAt: null, status: "active", provider: "manual", providerSubscriptionId: null, currentPeriodEnd: null, graceUntil: null });
            } else {
              Object.assign(set, { pendingPlan: null, scheduledChangeAt: null });
            }
          }
        }
      }
      if (Object.keys(set).length > 0) await Subscription.updateOne({ _id: fresh._id }, { $set: set }, { session });

      if (payment && (outcome === "applied" || event === null || event === "drop_checkout" || outcome === "ignored")) {
        await recordProviderPayment({ session, subscription: fresh, payment, plan: planDoc, now });
      }
      if (input.eventId) {
        await BillingEvent.create([{ provider: "razorpay", eventId: input.eventId, type: input.eventType ?? "", business: fresh.business, providerSubscriptionId: input.providerSubscriptionId, outcome, remoteStatus: remote.status }], { session });
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === 11000) return "duplicate";
    throw error;
  } finally {
    await session.endSession();
  }
  if (outcome === "applied") notifySubscription(String(known.business));
  return outcome;
}

/** What Razorpay's current status means for access. `drop_checkout` is an unpaid page that ended. */
function eventFromRemote(
  remote: RazorpaySubscription,
  eventId: string,
  now: Date,
  mapping: ProviderPlan | null,
  planKey: string | null,
  chargedMinor: number | null,
  alreadyLinked: boolean,
): NormalizedBillingEvent | "drop_checkout" | null {
  const base = { provider: "razorpay", eventId, occurredAt: now, providerSubscriptionId: remote.id };
  const failed = (type: BillingEventType): NormalizedBillingEvent => ({ ...base, type });
  switch (remote.status) {
    case "active":
      return {
        ...base,
        // Reported the same way for a first activation and a renewal; the reducer needs
        // both to come with a known plan, the agreed price and a valid period. Only a
        // first activation clears `cancelAtPeriodEnd`, so a later read keeps a cancellation.
        type: alreadyLinked ? "subscription.renewed" : "subscription.activated",
        planKey: planKey ?? undefined,
        periodStart: asDate(remote.current_start) ?? undefined,
        periodEnd: asDate(remote.current_end) ?? undefined,
        // An amount from a real charge wins; otherwise the price of the plan Razorpay names.
        amountMinor: chargedMinor ?? mapping?.amountMinor,
        currency: mapping?.currency,
      };
    case "pending":
    case "halted":
    case "paused":
      return failed("payment.failed");
    case "cancelled":
    case "completed":
      return (remote.paid_count ?? 0) > 0 ? failed("subscription.canceled") : "drop_checkout";
    case "expired":
      return "drop_checkout";
    default:
      // created / authenticated: the customer has not been charged yet.
      return null;
  }
}

async function recordProviderPayment(input: {
  session: mongoose.ClientSession;
  subscription: StoredSubscription;
  payment: { id: string; amount: number; currency: string; status: string; created_at?: number };
  plan: (PlanDoc & { _id: unknown }) | null;
  now: Date;
}): Promise<void> {
  const succeeded = input.payment.status === "captured";
  const failed = input.payment.status === "failed";
  if (!succeeded && !failed) return;
  const status = succeeded ? "succeeded" : "failed";
  await Payment.updateOne(
    // One record per payment and outcome: an attempt can fail and be retried under a new id.
    { providerEventId: `razorpay:${input.payment.id}:${status}` },
    {
      $setOnInsert: {
        business: input.subscription.business,
        subscription: input.subscription._id,
        amount: asMajor(input.payment.amount),
        currency: input.payment.currency.toUpperCase(),
        status,
        provider: "razorpay",
        providerPaymentId: input.payment.id,
        description: `${input.plan?.name ?? "Plan"} subscription ${succeeded ? "payment" : "payment attempt"}`,
        paidAt: succeeded ? asDate(input.payment.created_at) ?? input.now : null,
        paymentDomain: "subscription",
      },
    },
    { upsert: true, session: input.session },
  );
}

// ---------------------------------------------------------------------------
// Reconciliation: comparing stores with what Razorpay reports
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  outcome: SyncOutcome | "not_configured" | "no_subscription" | "failed";
  /** A code only: never a body, key or customer detail. */
  error: string | null;
  at: Date;
}

/**
 * Compares one store with Razorpay. Safe to repeat: it applies the same reads a webhook
 * would, under the same stale-read protection, and records when it ran and how it went.
 */
export async function reconcileBusinessSubscription(input: { businessId: string; fetchImpl?: FetchLike }): Promise<ReconcileResult> {
  const at = new Date();
  if (!billingConfig() || !(await isFeatureReady("subscription_billing"))) return { outcome: "not_configured", error: null, at };
  await dbConnect();
  const current = await loadSubscription(input.businessId);
  const remoteIds = [...new Set([current?.providerSubscriptionId, current?.pendingCheckout?.providerSubscriptionId].filter((id): id is string => Boolean(id)))];
  if (!current || remoteIds.length === 0) return { outcome: "no_subscription", error: null, at };

  let outcome: ReconcileResult["outcome"] = "ignored";
  let error: string | null = null;
  try {
    for (const providerSubscriptionId of remoteIds) outcome = await syncProviderSubscription({ providerSubscriptionId, fetchImpl: input.fetchImpl });
    await refreshOpenAdjustments(input.businessId, input.fetchImpl);
  } catch (caught) {
    outcome = "failed";
    error = caught instanceof RazorpayApiError ? caught.providerCode ?? `http_${caught.status}` : "unexpected";
    if (!(caught instanceof RazorpayApiError)) console.error("[billing-reconcile] a store could not be compared");
  }
  await Subscription.updateOne({ _id: current._id }, { $set: { lastReconciledAt: at, lastReconcileOutcome: outcome, lastReconcileError: error } });
  return { outcome, error, at };
}

const RECONCILE_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const RECONCILE_BATCH = 50;
const RECONCILE_TIME_BUDGET_MS = 4 * 60 * 1000;

/**
 * The stores compared least recently, for a scheduler (lib/scheduled-jobs.ts stops two runs
 * overlapping). Never more than 50 in a run, whatever is asked. A store that fails is counted
 * and the rest carry on. Counts only.
 */
export async function reconcileDueSubscriptions(input: { limit?: number; minGapMs?: number; timeBudgetMs?: number; fetchImpl?: FetchLike }) {
  await dbConnect();
  const startedAt = Date.now();
  const timeBudgetMs = input.timeBudgetMs ?? RECONCILE_TIME_BUDGET_MS;
  const cutoff = new Date(startedAt - (input.minGapMs ?? RECONCILE_MIN_GAP_MS));
  const due = await Subscription.find({
    $and: [
      { $or: [{ provider: "razorpay", providerSubscriptionId: { $gt: "" } }, { "pendingCheckout.providerSubscriptionId": { $gt: "" } }] },
      { $or: [{ lastReconciledAt: null }, { lastReconciledAt: { $lt: cutoff } }] },
    ],
  })
    .sort({ lastReconciledAt: 1 })
    .limit(Math.min(input.limit ?? RECONCILE_BATCH, RECONCILE_BATCH))
    .select("business")
    .lean();
  const counts = { checked: 0, changed: 0, failed: 0, skipped: 0, stoppedEarly: false };
  for (const row of due) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      counts.stoppedEarly = true;
      break;
    }
    try {
      const result = await reconcileBusinessSubscription({ businessId: String(row.business), fetchImpl: input.fetchImpl });
      counts.checked += 1;
      if (result.outcome === "applied") counts.changed += 1;
      if (result.outcome === "failed") counts.failed += 1;
    } catch {
      counts.failed += 1;
      console.error("[billing-reconcile] a store could not be compared");
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Refunds and disputes on subscription payments
// ---------------------------------------------------------------------------

const OPEN_DISPUTE_STATUSES = ["open", "under_review"];

export type AdjustmentOutcome = "applied" | "duplicate" | "unknown_payment";

/**
 * Records a refund or dispute that Razorpay reports on a subscription payment. Both are
 * made in Razorpay's dashboard, so SiteForge only reflects them, and whichever way they
 * go, access does not change: that is a separate decision. Payments not recorded as
 * subscription payments are ignored, so a store's order refund can never land here.
 */
export async function syncBillingAdjustment(input: {
  kind: "refund" | "dispute";
  providerId: string;
  eventId?: string;
  eventType?: string;
  fetchImpl?: FetchLike;
}): Promise<AdjustmentOutcome> {
  const config = requireConfig();
  await dbConnect();
  if (input.eventId && (await BillingEvent.exists({ provider: "razorpay", eventId: input.eventId }))) return "duplicate";

  const remote =
    input.kind === "refund"
      ? await fetchRefund(config.credentials, input.providerId, input.fetchImpl)
      : await fetchDispute(config.credentials, input.providerId, input.fetchImpl);
  const payment = await Payment.findOne({ provider: "razorpay", providerPaymentId: remote.payment_id, paymentDomain: "subscription" }).lean();
  if (!payment) return "unknown_payment";

  const dispute = input.kind === "dispute" ? (remote as { reason_code?: string | null; respond_by?: number | null }) : null;
  let outcome: AdjustmentOutcome = "applied";
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      outcome = "applied";
      if (input.eventId && (await BillingEvent.exists({ provider: "razorpay", eventId: input.eventId }).session(session))) {
        outcome = "duplicate";
        return;
      }
      await BillingAdjustment.findOneAndUpdate(
        { kind: input.kind, providerId: input.providerId },
        {
          $set: { amountMinor: remote.amount, currency: remote.currency.toUpperCase(), status: remote.status, reasonCode: dispute?.reason_code ?? "", respondBy: asDate(dispute?.respond_by), lastSyncedAt: new Date() },
          $setOnInsert: { business: payment.business, subscription: payment.subscription ?? null, payment: payment._id, providerPaymentId: remote.payment_id, kind: input.kind, providerId: input.providerId },
        },
        { upsert: true, session },
      );
      if (input.kind === "refund") {
        // Worked out from the records, so hearing about a refund twice cannot count it twice.
        const processed = await BillingAdjustment.find({ payment: payment._id, kind: "refund", status: "processed" }).session(session).select("amountMinor").lean();
        const refundedMinor = processed.reduce((sum, item) => sum + item.amountMinor, 0);
        const paidMinor = Math.round(payment.amount * 100);
        await Payment.updateOne({ _id: payment._id }, { $set: { refundedAmount: asMajor(refundedMinor), status: refundedMinor >= paidMinor && refundedMinor > 0 ? "refunded" : payment.status } }, { session });
      }
      if (input.eventId) {
        await BillingEvent.create([{ provider: "razorpay", eventId: input.eventId, type: input.eventType ?? "", business: payment.business, providerSubscriptionId: input.providerId, outcome: "applied", remoteStatus: remote.status }], { session });
      }
    });
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === 11000) return "duplicate";
    throw error;
  } finally {
    await session.endSession();
  }
  return outcome;
}

/** Refunds and disputes still in progress can move without a webhook reaching us. */
async function refreshOpenAdjustments(businessId: string, fetchImpl?: FetchLike): Promise<void> {
  const open = await BillingAdjustment.find({ business: businessId, $or: [{ kind: "refund", status: "pending" }, { kind: "dispute", status: { $in: OPEN_DISPUTE_STATUSES } }] }).limit(20).select("kind providerId").lean();
  for (const item of open) await syncBillingAdjustment({ kind: item.kind, providerId: item.providerId, fetchImpl });
}

