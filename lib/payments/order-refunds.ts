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
import { RazorpayApiError, createRefund, fetchRefund, toMinorUnits, type FetchLike, type RazorpayRefund } from "@/lib/payments/razorpay";
import { assertFeatureReady } from "@/lib/required-indexes";
import { Order, type OrderDoc } from "@/models/Order";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";
import { OrderRefund, type OrderRefundDoc } from "@/models/OrderRefund";

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
/** Razorpay's answer for "try again later" as opposed to "this will never work". */
const isDefiniteFailure = (error: RazorpayApiError) => error.status >= 400 && error.status < 500 && error.status !== 429;

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

async function applyRemoteRefund(refund: OrderRefundDoc, remote: RazorpayRefund, now: Date): Promise<void> {
  if (!matchesRefund(remote, refund)) {
    console.warn("[payments] refund does not match the recorded request", { operation: "refund" });
    return;
  }
  if (!refund.providerRefundId) {
    try {
      await OrderRefund.updateOne({ _id: refund._id, business: refund.business }, { $set: { providerRefundId: remote.id } });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Another record already holds this provider refund, so it must not be settled here as well.
      // This one stays pending and held until Razorpay's answer for it arrives.
      console.warn("[payments] provider refund is already recorded on another refund", { operation: "refund" });
      return;
    }
  }
  if (remote.status === "processed") await settleRefund(refund._id, now);
  else if (remote.status === "failed") await failRefund(refund._id, "provider_failed");
}

async function sendToProvider(refund: OrderRefundDoc, now: Date, fetchImpl?: FetchLike): Promise<void> {
  const account = await paymentAccountForRefunds(refund.business, refund.mode);
  if (!account) {
    // Nothing reached the provider, so this cannot have refunded anyone.
    await failRefund(refund._id, "account_unavailable");
    throw new HttpError(409, "Online refunds are not available: reconnect the Razorpay account this payment was taken with.", "refund_account_unavailable");
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
    if (isDefiniteFailure(error)) {
      await failRefund(refund._id, error.providerCode);
      throw new HttpError(422, "Razorpay refused this refund. Check your Razorpay account balance and the payment's status, then try again.", "refund_refused");
    }
    // The outcome is unknown: the refund stays pending and held, and retrying
    // with the same key cannot refund twice.
    throw new HttpError(502, "Razorpay did not answer. The refund is recorded as in progress: check it again shortly.", "refund_outcome_unknown");
  }
}

/** Reserves the amount, then refunds through Razorpay or records a manual refund. */
export async function createOrderRefund(input: RefundRequest): Promise<OrderRefundDoc> {
  const now = input.now ?? new Date();
  await dbConnect();
  // Checked before anything is held or sent, so nothing reaches Razorpay without the protection.
  if (input.method === "razorpay") await assertFeatureReady("order_refunds");
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
  else await sendToProvider(refund, now, input.fetchImpl);
  return (await OrderRefund.findById(refund._id).lean<OrderRefundDoc>()) as OrderRefundDoc;
}

/** Asks Razorpay about a pending refund again (safe to repeat). */
export async function refreshOrderRefund(input: { businessId: string; refundId: string; now?: Date; fetchImpl?: FetchLike }): Promise<OrderRefundDoc> {
  await dbConnect();
  const now = input.now ?? new Date();
  if (!mongoose.isValidObjectId(input.refundId)) throw new HttpError(404, "Refund not found", "not_found");
  const refund = await OrderRefund.findOne({ _id: input.refundId, business: input.businessId }).lean<OrderRefundDoc>();
  if (!refund) throw new HttpError(404, "Refund not found", "not_found");
  if (refund.status === "pending" && refund.provider === "razorpay") {
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
      await sendToProvider(refund, now, input.fetchImpl);
    }
  }
  return (await OrderRefund.findById(refund._id).lean<OrderRefundDoc>()) as OrderRefundDoc;
}

/**
 * From a signed webhook: re-reads the refund with this business's key and applies
 * it. A refund started in Razorpay's own dashboard is recorded too, once it is
 * proven to belong to a payment of this same business and fits what is left.
 */
export async function syncRefundFromProvider(input: { businessId: string; providerRefundId: string; now?: Date; fetchImpl?: FetchLike }): Promise<{ outcome: "unknown" | "applied" | "ignored" }> {
  const now = input.now ?? new Date();
  await dbConnect();
  const business = new mongoose.Types.ObjectId(input.businessId);
  const known = await OrderRefund.findOne({ business, providerRefundId: input.providerRefundId }).lean<OrderRefundDoc>();
  const account = await paymentAccountForRefunds(business, known?.mode ?? null);
  if (!account) return { outcome: "unknown" };
  const remote = await fetchRefund({ keyId: account.keyId, keySecret: decryptCredential(account.keySecretEnc) }, input.providerRefundId, input.fetchImpl);

  if (known) {
    await applyRemoteRefund(known, remote, now);
    return { outcome: "applied" };
  }
  const payment = await OrderPayment.findOne({ business, providerPaymentId: remote.payment_id, status: "paid" }).lean<OrderPaymentDoc>();
  if (!payment || String(remote.currency).toUpperCase() !== payment.currency) return { outcome: "unknown" };
  // Our own request whose response was lost, matched on what it asked for.
  const waiting = await OrderRefund.findOne({ business, order: payment.order, providerRefundId: null, status: "pending", provider: "razorpay", amountMinor: remote.amount }).lean<OrderRefundDoc>();
  if (waiting) {
    await applyRemoteRefund(waiting, remote, now);
    return { outcome: "applied" };
  }
  if (remote.status !== "processed") return { outcome: "ignored" };

  // Started outside SiteForge, so this creates a record. Without the index that guarantees one
  // record per provider refund, the answer is 503 and Razorpay delivers it again later.
  await assertFeatureReady("order_refunds");
  const amount = round2(remote.amount / 100);
  let createdId: unknown = null;
  let existing = null as OrderRefundDoc | null;
  let fits = true;
  const session = await mongoose.startSession();
  try {
    // Concurrent deliveries both write this order, so MongoDB retries the later one from the start,
    // and it then finds the record the earlier one committed. Everything is read again on each try.
    await session.withTransaction(async () => {
      createdId = null;
      existing = null;
      fits = true;
      existing = await OrderRefund.findOne({ business, providerRefundId: remote.id }).session(session).lean<OrderRefundDoc>();
      if (existing) return;
      const fresh = await Order.findOne({ _id: payment.order, business }).select("status total refundedTotal refundHoldTotal").session(session).lean<OrderDoc>();
      if (!fresh || (fresh.status !== "paid" && fresh.status !== "refunded") || amount > refundable(fresh) + EPSILON) {
        fits = false;
        return;
      }
      const [doc] = await OrderRefund.create(
        [{ business, order: payment.order, provider: "razorpay", mode: payment.mode, providerPaymentId: remote.payment_id, providerRefundId: remote.id, idempotencyKey: crypto.randomUUID(), amount, amountMinor: remote.amount, currency: payment.currency, status: "pending", reason: "Started in Razorpay", createdBy: null }],
        { session },
      );
      await Order.updateOne({ _id: payment.order, business }, { $set: { refundHoldTotal: round2(Number(fresh.refundHoldTotal ?? 0) + amount) } }, { session });
      createdId = doc._id;
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // The unique index stopped a duplicate: read what the other delivery recorded.
    createdId = null;
    existing = await OrderRefund.findOne({ business, providerRefundId: remote.id }).lean<OrderRefundDoc>();
    if (!existing) {
      console.warn("[payments] provider refund is recorded elsewhere", { operation: "sync_refund" });
      return { outcome: "ignored" };
    }
  } finally {
    await session.endSession();
  }
  if (!fits) {
    console.warn("[payments] provider refund could not be applied to its order", { operation: "sync_refund" });
    return { outcome: "ignored" };
  }
  // Settling is conditional on the record being pending, so finishing an earlier delivery's work is safe.
  if (existing) await applyRemoteRefund(existing, remote, now);
  else await settleRefund(createdId, now);
  return { outcome: "applied" };
}
