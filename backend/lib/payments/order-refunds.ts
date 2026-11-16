import crypto from "node:crypto";
import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { round2 } from "@/lib/checkout-pricing";
import { dbConnect } from "@/lib/db";
import { recordMovements, restoreStock } from "@/lib/inventory";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyRefund } from "@/lib/notification-events";
import { paymentAccountForRefunds } from "@/lib/payments/order-payments";
import { decryptCredential } from "@/lib/payments/credentials-crypto";
import { assertPaymentKeyUsable } from "@/lib/payments/key-check";
import { RazorpayApiError, createRefund, fetchRefund, toMinorUnits, type FetchLike, type RazorpayRefund } from "@/lib/payments/razorpay";
import { assertFeatureReady } from "@/lib/required-indexes";
import { Order, type OrderDoc } from "@/models/Order";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";
import { OrderRefund, type OrderRefundDoc, type OrderRefundLateReport } from "@/models/OrderRefund";

/**
 * Refunds of storefront orders (server-only). Callers authorise first.
 *
 * The amount is reserved on the order in a transaction BEFORE the provider is
 * called (`refundHoldTotal`), so two concurrent requests cannot refund more than
 * was paid. Money is recorded as refunded (`refundedTotal`) only when the provider
 * says so, re-read from its API with this business's own key. Every write that
 * settles a refund is conditional, so duplicate webhooks and a webhook racing the
 * API response apply it once. A lost response leaves the refund pending, and
 * retrying uses the same idempotency key, so the customer is never refunded twice.
 *
 * One provider refund is one record. A Razorpay refund is only started or recorded
 * once the unique `orderrefunds` index exists (`order_refunds`, lib/required-indexes.ts):
 * without it the feature answers 503 rather than risk a duplicate. Manual refunds have
 * no provider id, so they do not depend on it.
 */
const EPSILON = 0.005;
/** Answers that say the request may still have an effect, or simply came too soon: timeout, conflict, too early, too many. */
const NOT_A_REFUSAL = new Set([408, 409, 425, 429]);
/** Razorpay's answer for "this will never work" as opposed to "try again later". */
const isDefiniteFailure = (error: RazorpayApiError) => error.status >= 400 && error.status < 500 && !NOT_A_REFUSAL.has(error.status);
const stillInProgress = () => new HttpError(502, "Razorpay has not confirmed what happened to this refund, so it stays in progress and its amount stays held. Check it again shortly.", "refund_outcome_unknown");

export interface RefundRequest {
  businessId: string;
  orderId: string;
  /** Major units; absent = everything not yet refunded. */
  amount?: number;
  method: "razorpay" | "manual";
  reason?: string;
  restock?: boolean;
  actorId: unknown;
  now?: Date;
  fetchImpl?: FetchLike;
}

const refundable = (order: Pick<OrderDoc, "total" | "refundedTotal" | "refundHoldTotal">) =>
  round2(Number(order.total ?? 0) - Number(order.refundedTotal ?? 0) - Number(order.refundHoldTotal ?? 0));

function assertRefundableOrder(order: OrderDoc | null): asserts order is OrderDoc {
  if (!order) throw new HttpError(404, "Order not found", "not_found");
  if (order.status === "refunded") throw new HttpError(409, "This order is already fully refunded.", "already_refunded");
  if (order.status !== "paid") throw new HttpError(409, "Only paid orders can be refunded.", "not_paid");
}

/**
 * Settles a refund: pending -> processed exactly once, moving the money from held
 * to refunded, closing the order when nothing is left and restocking if asked.
 * Runs in one transaction with the status claim. Returns false if already settled.
 */
async function settleRefund(refundId: unknown, now: Date): Promise<boolean> {
  const session = await mongoose.startSession();
  let settled = false;
  let settledOrder: { id: string; businessId: string; full: boolean } | null = null;
  try {
    await session.withTransaction(async () => {
      settled = false;
      settledOrder = null;
      const refund = await OrderRefund.findOneAndUpdate(
        { _id: refundId, status: "pending" },
        { $set: { status: "processed", processedAt: now, failureCode: null } },
        { session, new: true },
      ).lean<OrderRefundDoc>();
      if (!refund) return;
      const order = await Order.findOne({ _id: refund.order, business: refund.business }).session(session).lean<OrderDoc>();
      if (!order) throw new Error("Refund points to a missing order");

      const refundedTotal = round2(Number(order.refundedTotal ?? 0) + refund.amount);
      const refundHoldTotal = Math.max(0, round2(Number(order.refundHoldTotal ?? 0) - refund.amount));
      const full = refundedTotal >= Number(order.total ?? 0) - EPSILON;
      const restock = refund.restock && full && order.inventoryState === "consumed";

      await Order.updateOne(
        { _id: order._id, business: refund.business },
        {
          $set: {
            refundedTotal,
            refundHoldTotal,
            ...(full ? { status: "refunded", refundedAt: now } : {}),
            ...(restock ? { inventoryState: "released", inventoryReleasedAt: now } : {}),
          },
        },
        { session },
      );
      if (restock) {
        const changes = await restoreStock(
          (order.items ?? []).map((item) => ({ product: item.product, variant: item.variant ?? null, quantity: item.quantity })),
          refund.business,
          session,
        );
        await recordMovements(refund.business, changes, { reason: "order_refunded", order: order._id, actor: refund.createdBy ?? undefined }, session);
      }
      settled = true;
      settledOrder = { id: String(order._id), businessId: String(refund.business), full };
    });
  } finally {
    await session.endSession();
  }
  const done = settledOrder as { id: string; businessId: string; full: boolean } | null;
  if (settled && done) {
    queueOrderEmail("refunded", done.businessId, done.id);
    notifyRefund(done.businessId, refundId);
  }
  return settled;
}

/** Gives a failed refund's held amount back. Conditional, so it applies once. */
async function failRefund(refundId: unknown, code: string | null): Promise<void> {
  const session = await mongoose.startSession();
  let failedFor: string | null = null;
  try {
    await session.withTransaction(async () => {
      failedFor = null;
      const refund = await OrderRefund.findOneAndUpdate(
        { _id: refundId, status: "pending" },
        { $set: { status: "failed", failureCode: code ? code.slice(0, 80) : null } },
        { session, new: true },
      ).lean<OrderRefundDoc>();
      if (!refund) return;
      const order = await Order.findOne({ _id: refund.order, business: refund.business }).select("refundHoldTotal").session(session).lean<OrderDoc>();
      await Order.updateOne(
        { _id: refund.order, business: refund.business },
        { $set: { refundHoldTotal: Math.max(0, round2(Number(order?.refundHoldTotal ?? 0) - refund.amount)) } },
        { session },
      );
      failedFor = String(refund.business);
    });
  } finally {
    await session.endSession();
  }
  if (failedFor) notifyRefund(failedFor, refundId);
}

function matchesRefund(remote: RazorpayRefund, refund: Pick<OrderRefundDoc, "amountMinor" | "currency" | "providerPaymentId">): boolean {
  return remote.amount === refund.amountMinor && String(remote.currency).toUpperCase() === refund.currency && remote.payment_id === refund.providerPaymentId;
}

/**
 * What happened when a Razorpay refund was applied to one local refund. Only `attached` and
 * `already_attached` mean this record now holds that Razorpay refund id: callers must never treat
 * anything else as success.
 * - `attached`: this call wrote the id onto the record.
 * - `already_attached`: the record already held this same id.
 * - `claim_lost`: the record changed meanwhile (another Razorpay refund, or no longer waiting).
 * - `duplicate_conflict`: another record already holds this Razorpay refund id (the unique index).
 * - `mismatch`: the refund does not match what the record asked for.
 * - `late_report`: the owner had released the record, so it went to `handleLateProviderReport`.
 */
type ApplyResult =
  | { kind: "attached" | "already_attached" | "claim_lost" | "duplicate_conflict" | "mismatch" }
  | { kind: "late_report"; late: "applied" | "needs_review" };

async function applyRemoteRefund(refund: OrderRefundDoc, remote: RazorpayRefund, now: Date): Promise<ApplyResult> {
  if (!matchesRefund(remote, refund)) {
    console.warn("[payments] refund does not match the recorded request", { operation: "refund" });
    return { kind: "mismatch" };
  }
  let kind: "attached" | "already_attached" = "already_attached";
  if (refund.providerRefundId && refund.providerRefundId !== remote.id) {
    console.warn("[payments] a refund holds a different Razorpay refund", { operation: "refund" });
    return { kind: "claim_lost" };
  }
  if (!refund.providerRefundId) {
    try {
      // Only a refund still waiting takes Razorpay's id. One the owner released meanwhile
      // (`recoverStuckRefund`) must not: its hold is gone, so it can no longer settle.
      const claimed = await OrderRefund.updateOne({ _id: refund._id, business: refund.business, status: "pending", providerRefundId: null }, { $set: { providerRefundId: remote.id } });
      if (claimed.matchedCount === 0) {
        const current = await OrderRefund.findOne({ _id: refund._id, business: refund.business }).lean<OrderRefundDoc>();
        if (current?.providerRefundId !== remote.id) {
          // Released by the owner meanwhile: what Razorpay says now is recorded beside the release.
          if (current?.recovery) return { kind: "late_report", late: await handleLateProviderReport(current, remote, now) };
          console.warn("[payments] a Razorpay answer arrived for a refund that is no longer waiting", { operation: "refund" });
          return { kind: "claim_lost" };
        }
        // Another answer for this same refund got here first: settling below is conditional, so it applies once.
      } else {
        kind = "attached";
      }
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Another record already holds this provider refund, so it must not be settled here as well.
      // This one stays pending and held until Razorpay's answer for it arrives.
      console.warn("[payments] provider refund is already recorded on another refund", { operation: "refund" });
      return { kind: "duplicate_conflict" };
    }
  }
  if (remote.status === "processed") await settleRefund(refund._id, now);
  else if (remote.status === "failed") await failRefund(refund._id, "provider_failed");
  return { kind };
}

/**
 * `first` is true only for the send straight after the hold was made, when nothing can have reached
 * Razorpay yet. Any later send may be repeating one whose answer was lost, so the refund may already
 * exist there: then only Razorpay's own report of the refund can give the hold back (`applyRemoteRefund`),
 * never the lack of an account or an error on the repeat.
 */
async function sendToProvider(refund: OrderRefundDoc, now: Date, attempt: { first: boolean }, fetchImpl?: FetchLike): Promise<void> {
  const account = await paymentAccountForRefunds(refund.business, refund.mode);
  if (!account) {
    if (attempt.first) await failRefund(refund._id, "account_unavailable");
    throw new HttpError(
      409,
      attempt.first
        ? "Online refunds are not available: reconnect the Razorpay account this payment was taken with."
        : "Reconnect the Razorpay account this payment was taken with to check this refund. It stays in progress, and its amount stays held.",
      "refund_account_unavailable",
    );
  }
  try {
    const remote = await createRefund(
      { keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) },
      refund.providerPaymentId as string,
      { amountMinor: refund.amountMinor, idempotencyKey: refund.idempotencyKey, orderReference: String(refund.order) },
      fetchImpl,
    );
    await applyRemoteRefund(refund, remote, now);
  } catch (error) {
    if (!(error instanceof RazorpayApiError)) throw error;
    console.warn("[payments] refund request failed", { status: error.status, code: error.providerCode });
    if (attempt.first && isDefiniteFailure(error)) {
      await failRefund(refund._id, error.providerCode);
      throw new HttpError(422, "Razorpay refused this refund. Check your Razorpay account balance and the payment's status, then try again.", "refund_refused");
    }
    // The outcome is unknown, including a refusal of a repeat, which may only mean the first
    // request worked: the refund stays pending and held, and a later report from Razorpay settles it.
    throw stillInProgress();
  }
}

/** Reserves the amount, then refunds through Razorpay or records a manual refund. */
export async function createOrderRefund(input: RefundRequest): Promise<OrderRefundDoc> {
  const now = input.now ?? new Date();
  await dbConnect();
  // Checked before anything is held or sent, so nothing reaches Razorpay without the protection.
  if (input.method === "razorpay") {
    await assertFeatureReady("order_refunds");
    // A wrong or unverifiable payment key answers 503 here: no hold, no refund record, no request.
    await assertPaymentKeyUsable();
  }
  const businessObjectId = new mongoose.Types.ObjectId(input.businessId);
  const orderObjectId = new mongoose.Types.ObjectId(input.orderId);

  // The payment a Razorpay refund goes back to.
  let payment: OrderPaymentDoc | null = null;
  if (input.method === "razorpay") {
    payment = await OrderPayment.findOne({ business: businessObjectId, order: orderObjectId, status: "paid", orderOutcome: "applied" }).sort({ paidAt: -1 }).lean<OrderPaymentDoc>();
    if (!payment?.providerPaymentId) {
      throw new HttpError(409, "This order has no confirmed Razorpay payment to refund.", "no_online_payment");
    }
  }

  let created: OrderRefundDoc | null = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      created = null;
      const order = await Order.findOne({ _id: orderObjectId, business: businessObjectId }).session(session).lean<OrderDoc>();
      assertRefundableOrder(order);
      const available = refundable(order);
      if (available < 0.01) throw new HttpError(409, "Everything paid on this order is already refunded or being refunded.", "nothing_to_refund");
      const amount = input.amount === undefined ? available : round2(input.amount);
      if (!(amount > 0) || amount > available + EPSILON) {
        throw new HttpError(422, `You can refund up to ${available.toFixed(2)} on this order.`, "refund_amount_invalid");
      }
      const amountMinor = toMinorUnits(amount);
      if (amountMinor === null) throw new HttpError(422, "Enter an amount with at most two decimals.", "refund_amount_invalid");
      // A return of the goods is only clear when the whole order comes back.
      const restock = input.restock === true;
      if (restock && amount < available - EPSILON) {
        throw new HttpError(422, "Items are returned to stock only with a refund of the full remaining amount. For a partial return, adjust stock in Inventory.", "restock_needs_full_refund");
      }
      const [doc] = await OrderRefund.create(
        [
          {
            business: businessObjectId,
            order: orderObjectId,
            provider: input.method,
            mode: payment?.mode ?? null,
            providerPaymentId: payment?.providerPaymentId ?? null,
            idempotencyKey: crypto.randomUUID(),
            amount,
            amountMinor,
            currency: (order.currency ?? "").toUpperCase() || "INR",
            status: "pending",
            reason: (input.reason ?? "").trim().slice(0, 200),
            restock,
            createdBy: input.actorId,
          },
        ],
        { session },
      );
      await Order.updateOne(
        { _id: orderObjectId, business: businessObjectId },
        { $set: { refundHoldTotal: round2(Number(order.refundHoldTotal ?? 0) + amount) } },
        { session },
      );
      created = doc.toObject() as OrderRefundDoc;
    });
  } finally {
    await session.endSession();
  }
  const refund = created as unknown as OrderRefundDoc;

  if (input.method === "manual") await settleRefund(refund._id, now);
  else await sendToProvider(refund, now, { first: true }, input.fetchImpl);
  return (await OrderRefund.findById(refund._id).lean<OrderRefundDoc>()) as OrderRefundDoc;
}

/** Asks Razorpay about a pending refund again (safe to repeat, and never gives the hold back by itself). */
export async function refreshOrderRefund(input: { businessId: string; refundId: string; now?: Date; fetchImpl?: FetchLike }): Promise<OrderRefundDoc> {
  await dbConnect();
  const now = input.now ?? new Date();
  if (!mongoose.isValidObjectId(input.refundId)) throw new HttpError(404, "Refund not found", "not_found");
  const refund = await OrderRefund.findOne({ _id: input.refundId, business: input.businessId }).lean<OrderRefundDoc>();
  if (!refund) throw new HttpError(404, "Refund not found", "not_found");
  if (refund.status === "pending" && refund.provider === "razorpay") {
    // Before any request: a wrong key leaves the refund exactly as it is (pending, amount held).
    await assertPaymentKeyUsable();
    if (refund.providerRefundId) {
      const account = await paymentAccountForRefunds(refund.business, refund.mode);
      if (!account) throw new HttpError(409, "Reconnect the Razorpay account this payment was taken with.", "refund_account_unavailable");
      try {
        const remote = await fetchRefund({ keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) }, refund.providerRefundId, input.fetchImpl);
        await applyRemoteRefund(refund, remote, now);
      } catch (error) {
        if (!(error instanceof RazorpayApiError)) throw error;
        throw new HttpError(502, "Razorpay did not answer. Try again shortly.", "payment_provider_error");
      }
    } else {
      // The first answer was lost: the same key returns the same refund.
      await sendToProvider(refund, now, { first: false }, input.fetchImpl);
    }
  }
  return (await OrderRefund.findById(refund._id).lean<OrderRefundDoc>()) as OrderRefundDoc;
}

/**
 * From a signed webhook: re-reads the refund with this business's key and applies
 * it. A refund started in Razorpay's own dashboard is recorded too, once it is
 * proven to belong to a payment of this same business and fits what is left.
 */
export async function syncRefundFromProvider(input: { businessId: string; providerRefundId: string; now?: Date; fetchImpl?: FetchLike }): Promise<{ outcome: "unknown" | "applied" | "ignored" | "needs_review" }> {
  const now = input.now ?? new Date();
  await dbConnect();
  const business = new mongoose.Types.ObjectId(input.businessId);
  const known = await OrderRefund.findOne({ business, providerRefundId: input.providerRefundId }).lean<OrderRefundDoc>();
  const account = await paymentAccountForRefunds(business, known?.mode ?? null);
  if (!account) return { outcome: "unknown" };
  await assertPaymentKeyUsable();
  const remote = await fetchRefund({ keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) }, input.providerRefundId, input.fetchImpl);

  // 1. By Razorpay's own refund id: a record that holds it.
  if (known) {
    await applyRemoteRefund(known, remote, now);
    // A record created from a late report carries its report with it; if that write was ever lost, it is put back.
    await repairLateReport(known, remote, now);
    // The record holds this id, which is what resolving checks again.
    await resolveRefundReviewIfAttached(business, known.order, remote.id, now);
    return { outcome: "applied" };
  }
  // 1b. By Razorpay's own refund id: a released refund an earlier report bound to it.
  const bound = await OrderRefund.find({ business, recovery: { $ne: null }, "lateProviderReport.providerRefundId": remote.id }).limit(2).lean<OrderRefundDoc[]>();
  if (bound.length > 1) {
    await recordRefundReview(business, bound[0].order, remote, "ambiguous_match", bound.map((refund) => refund._id), now);
    return { outcome: "needs_review" };
  }
  if (bound.length === 1) {
    const outcome = await handleLateProviderReport(bound[0], remote, now);
    if (outcome === "applied") await resolveRefundReviewIfAttached(business, bound[0].order, remote.id, now);
    return { outcome };
  }

  const payment = await OrderPayment.findOne({ business, providerPaymentId: remote.payment_id, status: "paid" }).lean<OrderPaymentDoc>();
  if (!payment || String(remote.currency).toUpperCase() !== payment.currency) return { outcome: "unknown" };

  // 2. No id matches: our own requests it could be, by order, payment and amount. A refund still waiting
  // (its answer was lost) and a released one no report has bound yet are counted TOGETHER, and only exactly
  // one is ever used. Released refunds already bound to another Razorpay refund are not candidates.
  const scope = { business, order: payment.order, provider: "razorpay" as const, providerRefundId: null, providerPaymentId: remote.payment_id, amountMinor: remote.amount };
  const [waiting, released] = await Promise.all([
    OrderRefund.find({ ...scope, status: "pending", recovery: null }).limit(2).lean<OrderRefundDoc[]>(),
    OrderRefund.find({ ...scope, recovery: { $ne: null }, lateProviderReport: null }).limit(2).lean<OrderRefundDoc[]>(),
  ]);
  const candidates = [...waiting, ...released];
  if (candidates.length > 1) {
    // Never the oldest, the newest or the first found: nothing is attached, and the owner decides.
    await recordRefundReview(business, payment.order, remote, "ambiguous_match", candidates.map((refund) => refund._id), now);
    return { outcome: "needs_review" };
  }
  if (waiting.length === 1) {
    const result = await applyRemoteRefund(waiting[0], remote, now);
    if (result.kind === "attached" || result.kind === "already_attached") {
      await resolveRefundReviewIfAttached(business, payment.order, remote.id, now);
      return { outcome: "applied" };
    }
    if (result.kind === "late_report") {
      if (result.late === "applied") await resolveRefundReviewIfAttached(business, payment.order, remote.id, now);
      return { outcome: result.late };
    }
    // Not attached: another delivery took that refund, or another record already holds this Razorpay refund.
    // Never reported as success, and no record is made up for it: the owner reviews it.
    await recordRefundReview(business, payment.order, remote, result.kind === "duplicate_conflict" ? "duplicate_conflict" : "claim_lost", [waiting[0]._id], now);
    return { outcome: "needs_review" };
  }
  if (released.length === 1) {
    const outcome = await handleLateProviderReport(released[0], remote, now);
    if (outcome === "applied") await resolveRefundReviewIfAttached(business, payment.order, remote.id, now);
    return { outcome };
  }

  // 3. None of ours: a refund started in Razorpay's own dashboard, recorded as a refund of its own.
  if (remote.status !== "processed") return { outcome: "ignored" };
  const result = await recordProviderRefund(business, payment, remote, now, "Started in Razorpay");
  if (result.outcome === "applied") {
    await resolveRefundReviewIfAttached(business, payment.order, remote.id, now);
    return { outcome: "applied" };
  }
  // Razorpay says the money went back, but it could not be recorded: kept on the order for the owner, never
  // dropped, and never turned into a made-up record to balance the totals. No local refund was a candidate.
  if (result.unrecorded) {
    await recordRefundReview(business, payment.order, remote, result.unrecorded, [], now);
    return { outcome: "needs_review" };
  }
  return { outcome: result.outcome };
}

type RefundReviewReason = "ambiguous_match" | "released_refund_bound_elsewhere" | "claim_lost" | "duplicate_conflict" | "does_not_fit_order";

/** Resolved entries beyond this many may be removed. Unresolved ones never are, however many there are. */
const REFUND_REVIEWS_KEPT = 20;

/**
 * Whether this Razorpay refund is attached to a local refund of this order: a record holds its id, or a released
 * refund's report is bound to it and settled (`recorded`, or confirmed `provider_failed`). An unresolved report
 * (`needs_review`) is not an attachment.
 */
async function isProviderRefundAttached(business: mongoose.Types.ObjectId, orderId: unknown, providerRefundId: string): Promise<boolean> {
  const attached = await OrderRefund.exists({
    business,
    order: orderId,
    $or: [
      { providerRefundId },
      { recovery: { $ne: null }, "lateProviderReport.providerRefundId": providerRefundId, "lateProviderReport.outcome": { $in: ["recorded", "provider_failed"] } },
    ],
  });
  return Boolean(attached);
}

/**
 * A Razorpay refund that could not be attached to exactly one record: kept on its order for the owner, with
 * what is known about it and the records it could have been. Nothing is decided and no refund is changed.
 *
 * - One entry per Razorpay refund id. Reported again, its open entry is updated: last seen only moves forward
 *   and first seen only backward, so an older or slower delivery never hides the latest observation.
 * - A resolved entry is never reopened, and nothing is recorded for a refund that is now attached.
 * - Two deliveries adding the same new entry: the one that loses updates the entry the other added.
 * - Never removed to stay within a size: only resolved entries are, and only when there are more than
 *   `REFUND_REVIEWS_KEPT`. If every entry is unresolved, all are kept and the new one is added too.
 */
async function recordRefundReview(business: mongoose.Types.ObjectId, orderId: unknown, remote: RazorpayRefund, reason: RefundReviewReason, candidates: unknown[], now: Date): Promise<void> {
  // Already attached to a refund of this order, or held by any refund record of this store: no misleading
  // review is made. An open one left from earlier is closed by the same confirmed check.
  const heldInStore = await OrderRefund.exists({ business, providerRefundId: remote.id });
  if (heldInStore || (await isProviderRefundAttached(business, orderId, remote.id))) {
    await resolveRefundReviewIfAttached(business, orderId, remote.id, now);
    return;
  }
  const updateOpen = () =>
    Order.updateOne(
      { _id: orderId, business, refundReviews: { $elemMatch: { providerRefundId: remote.id, resolvedAt: null } } },
      {
        $set: { "refundReviews.$.providerStatus": remote.status, "refundReviews.$.reason": reason, "refundReviews.$.candidateRefunds": candidates },
        $max: { "refundReviews.$.lastSeenAt": now },
        $min: { "refundReviews.$.firstSeenAt": now },
      },
    );
  if ((await updateOpen()).matchedCount === 0) {
    // A resolved entry for this refund stays resolved: resolving needed a confirmed attachment, which is never undone.
    const resolvedAlready = await Order.exists({ _id: orderId, business, refundReviews: { $elemMatch: { providerRefundId: remote.id, resolvedAt: { $ne: null } } } });
    if (resolvedAlready) return;
    await pruneResolvedRefundReviews(business, orderId);
    const pushed = await Order.updateOne(
      { _id: orderId, business, "refundReviews.providerRefundId": { $ne: remote.id } },
      { $push: { refundReviews: { providerRefundId: remote.id, providerPaymentId: remote.payment_id, amountMinor: remote.amount, currency: String(remote.currency).toUpperCase(), providerStatus: remote.status, reason, candidateRefunds: candidates, firstSeenAt: now, lastSeenAt: now, resolvedAt: null } } },
    );
    // Another delivery added it first: this observation goes into that entry instead of being lost.
    if (pushed.matchedCount === 0) await updateOpen();
  }
  // Another delivery may have attached this Razorpay refund after the check above, and found no entry to close
  // then. Checked again now: closed only if a refund of this order really holds it, otherwise left open.
  await resolveRefundReviewIfAttached(business, orderId, remote.id, now);
  console.warn("[payments] a Razorpay refund could not be attached to exactly one refund, and needs the owner's review", { operation: "refund", reason });
}

/** Makes room by removing the oldest RESOLVED entries only. Never an unresolved one. */
async function pruneResolvedRefundReviews(business: mongoose.Types.ObjectId, orderId: unknown): Promise<void> {
  const order = await Order.findOne({ _id: orderId, business }).select("+refundReviews").lean<OrderDoc>();
  const reviews = order?.refundReviews ?? [];
  if (reviews.length < REFUND_REVIEWS_KEPT) return;
  const resolved = reviews.filter((review) => review.resolvedAt).sort((a, b) => new Date(a.resolvedAt as Date).getTime() - new Date(b.resolvedAt as Date).getTime());
  const removable = resolved.slice(0, reviews.length - REFUND_REVIEWS_KEPT + 1).map((review) => review.providerRefundId);
  if (removable.length === 0) {
    console.warn("[payments] an order holds many unresolved refund reviews; all are kept", { operation: "refund", count: reviews.length });
    return;
  }
  await Order.updateOne({ _id: orderId, business }, { $pull: { refundReviews: { providerRefundId: { $in: removable }, resolvedAt: { $ne: null } } } });
}

/**
 * Closes the review of this Razorpay refund, once, and only when it is confirmed attached to a local refund of
 * this order (`isProviderRefundAttached`, read again here). The entry and its details are kept.
 */
async function resolveRefundReviewIfAttached(business: mongoose.Types.ObjectId, orderId: unknown, providerRefundId: string, now: Date): Promise<void> {
  if (!(await isProviderRefundAttached(business, orderId, providerRefundId))) return;
  await Order.updateOne(
    { _id: orderId, business, refundReviews: { $elemMatch: { providerRefundId, resolvedAt: null } } },
    { $set: { "refundReviews.$.resolvedAt": now } },
  );
}

type LateReportBody = Pick<OrderRefundLateReport, "outcome" | "recordedAs" | "issue">;

/**
 * Writes Razorpay's report on a released refund. The first report binds the refund to that Razorpay refund
 * id: a report for any other id is refused here, so another refund with the same amount can never replace it.
 * For the same id, a newer state replaces the report, and the one it replaces is kept in
 * `lateProviderReportHistory`. `recorded` is final. A report that says nothing new is not written, so a
 * retry neither changes nor announces anything. Conditional on the report it replaces, and given the
 * session when the refund it records is written in the same transaction.
 */
async function writeLateReport(
  released: Pick<OrderRefundDoc, "_id" | "business">,
  current: OrderRefundLateReport | null,
  remote: RazorpayRefund,
  body: LateReportBody,
  now: Date,
  session?: mongoose.ClientSession,
): Promise<boolean> {
  if (current && current.providerRefundId !== remote.id) return false;
  if (current?.outcome === "recorded") return false;
  if (current && current.outcome === body.outcome && current.providerStatus === remote.status && current.issue === body.issue && String(current.recordedAs ?? "") === String(body.recordedAs ?? "")) return false;
  const next: OrderRefundLateReport = { at: now, providerRefundId: remote.id, providerStatus: remote.status, ...body };
  const result = current
    ? await OrderRefund.updateOne(
        { _id: released._id, business: released.business, recovery: { $ne: null }, "lateProviderReport.providerRefundId": remote.id, "lateProviderReport.outcome": current.outcome, "lateProviderReport.at": current.at },
        { $set: { lateProviderReport: next }, $push: { lateProviderReportHistory: { $each: [current], $slice: -10 } } },
        { session },
      )
    : await OrderRefund.updateOne({ _id: released._id, business: released.business, recovery: { $ne: null }, lateProviderReport: null }, { $set: { lateProviderReport: next } }, { session });
  return result.modifiedCount > 0;
}

/**
 * A record created from a late report (`confirmsRecoveryOf`) and its released refund's report are written in one
 * transaction (`recordProviderRefund`). Older records, or any whose report is missing for another reason, get it
 * back here when Razorpay reports the refund again. Only for the same Razorpay refund id, and never over `recorded`.
 */
async function repairLateReport(record: OrderRefundDoc, remote: RazorpayRefund, now: Date): Promise<void> {
  if (!record.confirmsRecoveryOf || record.providerRefundId !== remote.id) return;
  const released = await OrderRefund.findOne({ _id: record.confirmsRecoveryOf, business: record.business, recovery: { $ne: null } }).select("business recovery lateProviderReport").lean<OrderRefundDoc>();
  if (!released) return;
  const current = released.lateProviderReport ?? null;
  if (current && (current.outcome === "recorded" || current.providerRefundId !== remote.id)) return;
  if (await writeLateReport(released, current, remote, { outcome: "recorded", recordedAs: record._id, issue: null }, now)) {
    notifyRefund(String(record.business), released._id);
  }
}

/**
 * Razorpay reports on a refund whose hold its owner had released. Nothing here starts a refund, holds an
 * amount or releases one. What Razorpay says is written beside the release (`lateProviderReport`), and
 * `recovery` itself is never changed:
 * - processed: the money did go back. It is recorded as its own refund (`confirmsRecoveryOf`) if it fits
 *   what is left on the order, through the same transaction as any refund Razorpay reports. If it cannot be
 *   matched to the payment or does not fit, nothing is decided and it is marked for the owner to review.
 * - failed: Razorpay confirms what the owner said.
 * - still pending: Razorpay has the refund but has not finished it. Nothing is decided; it is marked for
 *   review, and its final answer is handled when it comes.
 */
async function handleLateProviderReport(released: OrderRefundDoc, remote: RazorpayRefund, now: Date): Promise<"applied" | "needs_review"> {
  const current = released.lateProviderReport ?? null;
  // Bound to another Razorpay refund already: this one is not attached to it, and the owner is asked.
  if (current && current.providerRefundId !== remote.id) {
    await recordRefundReview(released.business, released.order, remote, "released_refund_bound_elsewhere", [released._id], now);
    return "needs_review";
  }
  if (current?.outcome === "recorded") return "applied";

  let changed = false;
  let outcome: "applied" | "needs_review" = "applied";
  if (remote.status === "processed") {
    const payment = await OrderPayment.findOne({ business: released.business, providerPaymentId: remote.payment_id, status: "paid" }).lean<OrderPaymentDoc>();
    if (!payment || String(remote.currency).toUpperCase() !== payment.currency) {
      changed = await writeLateReport(released, current, remote, { outcome: "needs_review", recordedAs: null, issue: "payment_not_found" }, now);
      outcome = "needs_review";
    } else {
      // The new record and this refund's report are written in one transaction there.
      const result = await recordProviderRefund(released.business, payment, remote, now, "Confirmed by Razorpay after the owner released its hold", released._id);
      if (result.boundElsewhere) {
        await recordRefundReview(released.business, released.order, remote, "released_refund_bound_elsewhere", [released._id], now);
        return "needs_review";
      }
      // Refused by the unique index with no record of this store holding it: no report could be written beside
      // the release, so it is kept on the order instead. (One that does not fit is already kept in the report.)
      if (result.unrecorded === "duplicate_conflict") {
        await recordRefundReview(released.business, released.order, remote, "duplicate_conflict", [released._id], now);
        return "needs_review";
      }
      changed = result.lateReportChanged;
      if (result.outcome !== "applied") outcome = "needs_review";
    }
  } else if (remote.status === "failed") {
    // Razorpay confirms what the owner found. A later `processed` for this same refund still replaces it.
    changed = await writeLateReport(released, current, remote, { outcome: "provider_failed", recordedAs: null, issue: null }, now);
  } else {
    changed = await writeLateReport(released, current, remote, { outcome: "needs_review", recordedAs: null, issue: "provider_still_processing" }, now);
    outcome = "needs_review";
  }
  if (outcome === "needs_review") console.warn("[payments] Razorpay reported on a released refund, and it needs the owner's review", { operation: "refund" });
  if (changed) notifyRefund(String(released.business), released._id);
  return outcome;
}

/**
 * Records a refund Razorpay processed that no waiting record stands for, and settles it. Re-checked
 * inside a transaction, so one provider refund is one record however many times it is reported.
 */
async function recordProviderRefund(
  business: mongoose.Types.ObjectId,
  payment: OrderPaymentDoc,
  remote: RazorpayRefund,
  now: Date,
  reason: string,
  confirmsRecoveryOf: mongoose.Types.ObjectId | null = null,
): Promise<{
  outcome: "applied" | "ignored";
  refundId: unknown;
  lateReportChanged: boolean;
  boundElsewhere: boolean;
  /**
   * Why a processed refund was NOT recorded, so the caller keeps it for review instead of dropping it:
   * it does not fit the order (more than is left, or the order can no longer be refunded), or the unique index
   * refused it but no record of this store holds it. Null when recorded, or when bound elsewhere.
   */
  unrecorded: "does_not_fit_order" | "duplicate_conflict" | null;
}> {
  // This creates a record. Without the index that guarantees one record per provider
  // refund, the answer is 503 and Razorpay delivers it again later.
  await assertFeatureReady("order_refunds");
  const amount = round2(remote.amount / 100);
  let createdId: unknown = null;
  let existing = null as OrderRefundDoc | null;
  let fits = true;
  let lateReportChanged = false;
  let boundElsewhere = false;
  type ReleasedFacts = Pick<OrderRefundDoc, "_id" | "business" | "recovery" | "lateProviderReport">;
  const session = await mongoose.startSession();
  try {
    // Concurrent deliveries both write this order, so MongoDB retries the later one from the start,
    // and it then finds the record the earlier one committed. Everything is read again on each try.
    await session.withTransaction(async () => {
      createdId = null;
      existing = null;
      fits = true;
      lateReportChanged = false;
      boundElsewhere = false;
      // The released refund this would confirm, read in this same transaction: the new record and that refund's
      // report are written together or not at all, so neither can be left without the other.
      let released: ReleasedFacts | null = null;
      if (confirmsRecoveryOf) {
        released = await OrderRefund.findOne({ _id: confirmsRecoveryOf, business }).select("business recovery lateProviderReport").session(session).lean<ReleasedFacts>();
        const bound = released?.lateProviderReport;
        if (!released?.recovery || (bound && bound.providerRefundId !== remote.id)) {
          boundElsewhere = true;
          return;
        }
      }
      const report = (body: LateReportBody) => (released ? writeLateReport(released, released.lateProviderReport ?? null, remote, body, now, session) : Promise.resolve(false));

      existing = await OrderRefund.findOne({ business, providerRefundId: remote.id }).session(session).lean<OrderRefundDoc>();
      if (existing) {
        lateReportChanged = await report({ outcome: "recorded", recordedAs: existing._id, issue: null });
        return;
      }
      const fresh = await Order.findOne({ _id: payment.order, business }).select("status total refundedTotal refundHoldTotal").session(session).lean<OrderDoc>();
      if (!fresh || (fresh.status !== "paid" && fresh.status !== "refunded") || amount > refundable(fresh) + EPSILON) {
        fits = false;
        // Not recorded, and not decided: the owner reviews it.
        lateReportChanged = await report({ outcome: "needs_review", recordedAs: null, issue: "does_not_fit_order" });
        return;
      }
      const [doc] = await OrderRefund.create(
        [{ business, order: payment.order, provider: "razorpay", mode: payment.mode, providerPaymentId: remote.payment_id, providerRefundId: remote.id, idempotencyKey: crypto.randomUUID(), amount, amountMinor: remote.amount, currency: payment.currency, status: "pending", reason, createdBy: null, confirmsRecoveryOf }],
        { session },
      );
      await Order.updateOne({ _id: payment.order, business }, { $set: { refundHoldTotal: round2(Number(fresh.refundHoldTotal ?? 0) + amount) } }, { session });
      createdId = doc._id;
      lateReportChanged = await report({ outcome: "recorded", recordedAs: doc._id, issue: null });
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // The unique index stopped a duplicate: read what the other delivery recorded.
    createdId = null;
    existing = await OrderRefund.findOne({ business, providerRefundId: remote.id }).lean<OrderRefundDoc>();
    if (!existing) {
      // Held by no record of this store: never dropped, the caller keeps it for review.
      console.warn("[payments] provider refund is recorded elsewhere", { operation: "sync_refund" });
      return { outcome: "ignored", refundId: null, lateReportChanged: false, boundElsewhere: false, unrecorded: "duplicate_conflict" };
    }
    // Link the release to what the other delivery recorded: one conditional write, for the same Razorpay refund only.
    if (confirmsRecoveryOf) {
      const released = await OrderRefund.findOne({ _id: confirmsRecoveryOf, business, recovery: { $ne: null } }).select("business recovery lateProviderReport").lean<ReleasedFacts>();
      if (released) lateReportChanged = await writeLateReport(released, released.lateProviderReport ?? null, remote, { outcome: "recorded", recordedAs: existing._id, issue: null }, now);
    }
  } finally {
    await session.endSession();
  }
  if (boundElsewhere) return { outcome: "ignored", refundId: null, lateReportChanged: false, boundElsewhere: true, unrecorded: null };
  if (!fits) {
    console.warn("[payments] provider refund could not be applied to its order", { operation: "sync_refund" });
    return { outcome: "ignored", refundId: null, lateReportChanged, boundElsewhere: false, unrecorded: "does_not_fit_order" };
  }
  // Settling is conditional on the record being pending, so finishing an earlier delivery's work is safe.
  const recorded = existing as OrderRefundDoc | null;
  if (recorded) await applyRemoteRefund(recorded, remote, now);
  else await settleRefund(createdId, now);
  return { outcome: "applied", refundId: recorded ? recorded._id : createdId, lateReportChanged, boundElsewhere: false, unrecorded: null };
}

// ---------------------------------------------------------------------------
// Recovering a stuck refund (owner only)
// ---------------------------------------------------------------------------

/** How long a refund must have waited before its owner may release it by hand. */
export const REFUND_RECOVERY_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const OWNER_RECOVERED_FAILURE_CODE = "owner_confirmed_not_refunded";
export const REFUND_RECOVERY_REASON_MIN = 5;
export const REFUND_RECOVERY_REASON_MAX = 500;

type RecoveryFacts = Pick<OrderRefundDoc, "status" | "provider" | "providerRefundId" | "createdAt"> & { recovery?: OrderRefundDoc["recovery"] };

/**
 * Only a Razorpay refund still in progress, that Razorpay never gave an id, after a full day. With an id,
 * Razorpay's API can say what happened, so its answer decides ("Check with Razorpay"), never an owner.
 * The wait leaves time for a slow answer or a webhook, and the request itself to have long finished.
 */
export function refundRecoveryState(refund: RecoveryFacts, now: Date = new Date()): { recoverable: boolean; recoverableFrom: Date | null } {
  if (refund.status !== "pending" || refund.provider !== "razorpay" || refund.providerRefundId || refund.recovery) return { recoverable: false, recoverableFrom: null };
  const from = new Date(new Date(refund.createdAt).getTime() + REFUND_RECOVERY_MIN_AGE_MS);
  return { recoverable: from.getTime() <= now.getTime(), recoverableFrom: from };
}

function refusalFor(refund: RecoveryFacts, now: Date): HttpError | null {
  if (refund.recovery) return new HttpError(409, "This refund's hold has already been released.", "refund_already_recovered");
  if (refund.status === "processed") return new HttpError(409, "Razorpay has already confirmed this refund, so there is no hold to release.", "refund_already_settled");
  if (refund.status !== "pending") return new HttpError(409, "This refund is no longer in progress, so there is no hold to release.", "refund_not_in_progress");
  if (refund.provider !== "razorpay") return new HttpError(409, "Only a Razorpay refund can be released this way.", "refund_not_recoverable");
  if (refund.providerRefundId) {
    return new HttpError(409, "Razorpay has a reference for this refund, so its answer decides what happened. Use Check with Razorpay, after reconnecting the Razorpay account if needed.", "refund_known_to_razorpay");
  }
  const { recoverable } = refundRecoveryState(refund, now);
  if (!recoverable) return new HttpError(409, "This refund started less than a day ago. Check with Razorpay first: you can release its hold once a day has passed.", "refund_too_recent");
  return null;
}

export const REVIEW_BLOCKS_RECOVERY_MESSAGE =
  "Razorpay has reported a refund of this amount on this payment that is still waiting for review, so this hold cannot be released. It may be this refund. Check the refund in Razorpay's dashboard and contact support to have the report reviewed.";

/**
 * An unresolved Razorpay report on this order for the same payment and amount as this refund. Releasing the hold
 * while one exists could let the same money be refunded twice, since that report may be this very refund. Read
 * only: it never changes a review. A report Razorpay says is processed is never set aside because it could not
 * be attached yet.
 */
export function blockingRefundReview(
  order: Pick<OrderDoc, "refundReviews">,
  refund: Pick<OrderRefundDoc, "providerPaymentId" | "amountMinor">,
): boolean {
  // A refund that never recorded its payment cannot be told apart by payment, so any open report of the same amount blocks it.
  return (order.refundReviews ?? []).some(
    (review) => !review.resolvedAt && Number(review.amountMinor) === Number(refund.amountMinor) && (!refund.providerPaymentId || review.providerPaymentId === refund.providerPaymentId),
  );
}

/** A write conflict that `withTransaction` already retried as far as it would. */
function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) return true;
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

/**
 * The owner confirms, from Razorpay's own dashboard, that a stuck refund was NOT made, and releases its
 * hold so the amount can be refunded again. Callers authorise the owner first. It never contacts Razorpay
 * and never starts a refund. It never decides on its own that a refund failed: the owner states it and the
 * statement is recorded.
 *
 * Everything is read again inside one transaction. The release is a conditional update that needs the refund
 * still waiting, with no Razorpay id and no recovery, so it happens once however often it is asked, and the
 * record of it (`OrderRefund.recovery`) is written by that same update. If Razorpay reports later that the
 * refund was in fact made, it is recorded as a refund of its own (`applyRemoteRefund`).
 */
export async function recoverStuckRefund(input: { businessId: string; orderId: string; refundId: string; actorId: unknown; reason: string; now?: Date }): Promise<void> {
  await dbConnect();
  const now = input.now ?? new Date();
  if (!mongoose.isValidObjectId(input.refundId) || !mongoose.isValidObjectId(input.orderId)) throw new HttpError(404, "Refund not found", "not_found");
  const reason = input.reason.trim().slice(0, REFUND_RECOVERY_REASON_MAX);
  if (reason.length < REFUND_RECOVERY_REASON_MIN) throw new HttpError(422, "Say why you are releasing this hold, in a few words.", "reason_required");
  const business = new mongoose.Types.ObjectId(input.businessId);
  const refundObjectId = new mongoose.Types.ObjectId(input.refundId);
  const orderObjectId = new mongoose.Types.ObjectId(input.orderId);

  let released = false;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      released = false;
      const refund = await OrderRefund.findOne({ _id: refundObjectId, business, order: orderObjectId }).session(session).lean<OrderRefundDoc>();
      if (!refund) throw new HttpError(404, "Refund not found", "not_found");
      const refusal = refusalFor(refund, now);
      if (refusal) throw refusal;
      // Read in this transaction, with the order's open Razorpay reports. A report added meanwhile changes this
      // order document, so the write to it below conflicts and the whole check runs again and sees it. That
      // write always changes the document (see `orderStamp`), so it can never be a silent no-op.
      const order = await Order.findOne({ _id: orderObjectId, business }).select("refundHoldTotal updatedAt +refundReviews").session(session).lean<OrderDoc>();
      if (!order) throw new HttpError(404, "Order not found", "not_found");
      if (blockingRefundReview(order, refund)) throw new HttpError(409, REVIEW_BLOCKS_RECOVERY_MESSAGE, "refund_review_pending");
      const heldBefore = round2(Number(order.refundHoldTotal ?? 0));
      const heldAfter = Math.max(0, round2(heldBefore - refund.amount));

      const claimed = await OrderRefund.updateOne(
        { _id: refundObjectId, business, order: orderObjectId, status: "pending", provider: "razorpay", providerRefundId: null, recovery: null },
        {
          $set: {
            status: "failed",
            failureCode: OWNER_RECOVERED_FAILURE_CODE,
            recovery: { at: now, by: input.actorId, reason, previousStatus: "pending", resultingStatus: "failed", heldBefore, heldAfter },
          },
        },
        { session },
      );
      if (claimed.matchedCount !== 1) throw new HttpError(409, "This refund changed while you were confirming. Reload the order to see where it stands.", "refund_changed");
      // A conditional claim on the order as it was read. Even when the hold does not change (already 0), its
      // `updatedAt` always moves strictly past the value read, so this is a real write: if a Razorpay report was
      // added to the order after this transaction read it, MongoDB raises a write conflict and the transaction
      // runs again from the start, re-reading the refund and the order and refusing. Automatic timestamps are off
      // for this one write so the stamp is exactly the one chosen here.
      const previousStamp = order.updatedAt ? new Date(order.updatedAt).getTime() : null;
      const orderStamp = new Date(Math.max(now.getTime(), (previousStamp ?? 0) + 1));
      const orderClaim = await Order.updateOne(
        { _id: orderObjectId, business, updatedAt: previousStamp === null ? null : new Date(previousStamp) },
        { $set: { refundHoldTotal: heldAfter, updatedAt: orderStamp } },
        { session, timestamps: false },
      );
      // Never a silent no-op: if the order did not take this exact write, nothing is released.
      if (orderClaim.modifiedCount !== 1) throw new HttpError(409, "This refund changed while you were confirming. Reload the order to see where it stands.", "refund_changed");
      released = true;
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isTransactionalConflict(error)) throw new HttpError(409, "This refund changed while you were confirming. Reload the order to see where it stands.", "refund_changed");
    throw error;
  } finally {
    await session.endSession();
  }
  // After the commit, like every other refund change (lib/notification-events.ts).
  if (released) notifyRefund(input.businessId, refundObjectId);
}
