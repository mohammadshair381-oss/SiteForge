import mongoose from "mongoose";
import { Order } from "@/models/Order";
import { recordMovements, restoreStock } from "@/lib/inventory";
import { releaseRedemption } from "@/lib/coupons";
import { HttpError } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import type { OrderCancelReason, OrderDoc } from "@/models/Order";

/** Unpaid orders hold inventory for 30 minutes. */
export const ORDER_RESERVATION_TTL_MS = 30 * 60 * 1000;
export const ORDER_RESERVATION_TTL_MINUTES = 30;
/**
 * Cash-on-delivery orders hold their stock without automatic expiry (the owner
 * confirms payment on delivery or cancels). To bound stock held by one
 * account, a customer may have at most this many pending COD orders per store.
 */
export const MAX_OPEN_COD_ORDERS_PER_CUSTOMER = 3;

/** Hard cap for a single expiry sweep, independent of the caller's request. */
export const ORDER_EXPIRY_BATCH_LIMIT = 50;
const MAX_ORDER_EXPIRY_BATCH_LIMIT = 100;

export type OrderTransitionReason =
  | "not_found"
  | "not_pending"
  | "legacy_order"
  | "expired"
  | "already_paid"
  | "already_cancelled"
  | "not_paid"
  | "already_refunded"
  /** A refund through the provider has not finished yet. */
  | "refund_in_progress"
  /** Manual confirmation attempted on a non-COD (online or unknown) order. */
  | "manual_payment_not_allowed";

export interface OrderTransitionResult {
  applied: boolean;
  reason?: OrderTransitionReason;
  order?: OrderDoc | null;
}

export interface OrderTransitionOptions {
  orderId: string;
  /** Required tenant scope. Never derive this from an untrusted order lookup. */
  businessId: string;
  /**
   * Trusted internal/test clock only. API routes must never populate this from
   * request query/body data; production callers should omit it.
   */
  now?: Date;
}

export interface CancelOrderOptions extends OrderTransitionOptions {
  reason?: Exclude<OrderCancelReason, "expired">;
}

export interface ExpireOrdersOptions {
  /** Required tenant scope for a business-facing expiry sweep. */
  businessId: string;
  /**
   * Trusted internal/test clock only. API routes must never populate this from
   * request query/body data; production callers should omit it.
   */
  now?: Date;
  limit?: number;
}

/** Options for the clearly internal, cross-tenant expiry sweep. */
export interface GlobalExpireOrdersOptions {
  /**
   * Trusted internal/test clock only. API routes must never populate this from
   * request query/body data; production callers should omit it.
   */
  now?: Date;
  limit?: number;
  /** No new order is started after this moment (epoch ms). */
  deadlineMs?: number;
  /** Orders already tried in this run, which are not tried again. */
  excludeOrderIds?: string[];
}

export interface ExpireOrderFailure {
  orderId: string;
  reason: string;
}

export interface ExpireOrdersResult {
  processed: number;
  released: number;
  skipped: number;
  failed: number;
  orderIds: string[];
  failures: ExpireOrderFailure[];
  /** Set only when a deadline was given: it passed before every candidate was tried. */
  stoppedEarly?: boolean;
}

function requireBusinessScope(businessId: string): string {
  if (typeof businessId !== "string" || businessId.trim().length === 0) {
    throw new HttpError(
      400,
      "Business scope is required for this operation",
      "business_scope_required",
    );
  }
  return assertObjectId(businessId, "business id");
}

function scopeFor(orderId: string, businessId: string): Record<string, unknown> {
  return {
    _id: assertObjectId(orderId, "order id"),
    business: requireBusinessScope(businessId),
  };
}

function isExpired(order: OrderDoc, now: Date): boolean {
  if (!order.reservationExpiresAt) return true;
  const expiresAt = new Date(order.reservationExpiresAt);
  return Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime();
}

/**
 * Return the reserved quantity to stock (product or exact variant) and record
 * the movements. Must run inside the same transaction as the order's
 * reserved -> released transition; throwing aborts that transaction.
 */
async function restoreInventory(
  order: OrderDoc,
  session: mongoose.ClientSession,
): Promise<void> {
  const changes = await restoreStock(order.items ?? [], order.business, session);
  await recordMovements(order.business, changes, {
    reason: "order_released",
    order: order._id,
    note: order.cancelReason ? `Order ${order.orderNumber} ${order.cancelReason}` : `Order ${order.orderNumber}`,
  }, session);
  // An unpaid order that never completed gives its coupon use back.
  await releaseRedemption(order, session);
}

/**
 * Apply a pending -> cancelled transition and restore stock exactly once.
 * The conditional update is the single-winner claim; duplicate cancellations
 * and concurrent expiry sweeps see a non-pending order and do nothing.
 */
async function cancelPendingOrder(
  options: OrderTransitionOptions & { reason: OrderCancelReason },
): Promise<OrderTransitionResult> {
  const { orderId, businessId, reason } = options;
  const now = options.now ?? new Date();
  const scope = scopeFor(orderId, businessId);
  const session = await mongoose.startSession();
  let result: OrderTransitionResult = { applied: false, reason: "not_found" };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOneAndUpdate(
        {
          ...scope,
          status: "pending",
          inventoryState: "reserved",
          // A shopper cannot cancel goods already on their way (e.g. a COD
          // order marked shipped); the business can (refused delivery).
          ...(reason === "customer" ? { fulfillmentStatus: { $nin: ["shipped", "delivered"] } } : {}),
        },
        {
          $set: {
            status: "cancelled",
            inventoryState: "released",
            cancelReason: reason,
            cancelledAt: now,
            inventoryReleasedAt: now,
          },
        },
        { new: true, session },
      );

      if (order) {
        await restoreInventory(order, session);
        result = { applied: true, order };
        return;
      }

      // This caller lost the race, or the order is not cancellable. Inspect
      // the current state only to return a precise, non-mutating result.
      const existing = await Order.findOne(scope).session(session);
      if (!existing) {
        result = { applied: false, reason: "not_found" };
      } else if (existing.status === "cancelled") {
        result = { applied: false, reason: "already_cancelled", order: existing };
      } else if (existing.status === "pending" && existing.inventoryState !== "reserved") {
        result = { applied: false, reason: "legacy_order", order: existing };
      } else {
        result = { applied: false, reason: "not_pending", order: existing };
      }
    });
  } finally {
    await session.endSession();
  }

  return result;
}

/**
 * Pending -> paid. Stock is already reserved, so this transition only consumes
 * the reservation and records the paid timestamp. It is conditional on the
 * reservation still being live: a payment after expiry must not resurrect a
 * released order.
 */
export async function markOrderPaid(
  options: OrderTransitionOptions,
): Promise<OrderTransitionResult> {
  const { orderId, businessId } = options;
  const now = options.now ?? new Date();
  const scope = scopeFor(orderId, businessId);
  const session = await mongoose.startSession();
  let result: OrderTransitionResult = { applied: false, reason: "not_found" };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOneAndUpdate(
        {
          ...scope,
          status: "pending",
          inventoryState: "reserved",
          reservationExpiresAt: { $gt: now },
        },
        {
          $set: {
            status: "paid",
            inventoryState: "consumed",
            paidAt: now,
          },
        },
        { new: true, session },
      );

      if (order) {
        result = { applied: true, order };
        return;
      }

      const existing = await Order.findOne(scope).session(session);
      if (!existing) {
        result = { applied: false, reason: "not_found" };
      } else if (existing.status === "paid") {
        result = { applied: false, reason: "already_paid", order: existing };
      } else if (existing.status !== "pending") {
        result = { applied: false, reason: "not_pending", order: existing };
      } else if (existing.inventoryState !== "reserved") {
        result = { applied: false, reason: "legacy_order", order: existing };
      } else if (isExpired(existing, now)) {
        result = { applied: false, reason: "expired", order: existing };
      } else {
        result = { applied: false, reason: "not_pending", order: existing };
      }
    });
  } finally {
    await session.endSession();
  }

  return result;
}

/**
 * Manual payment confirmation for CASH-ON-DELIVERY orders only: pending ->
 * paid, consuming the stock reservation, in one conditional update.
 *
 * This is the ONLY transition a business user may trigger to mark an order
 * paid. It refuses (changing nothing) when the order:
 * - is not explicitly `paymentMethod: "cod"`: online orders must be confirmed
 *   by server-side provider verification, and legacy orders without a payment
 *   method are never assumed to be COD;
 * - is not pending, has no live reservation, or its reservation expired.
 * A COD reservation without an expiry (`reservationExpiresAt: null`) stays
 * confirmable until delivered or cancelled.
 *
 * `markOrderPaid` above is reserved for the future provider-verified online
 * flow and must not be exposed to business users.
 */
export async function confirmCodPayment(
  options: OrderTransitionOptions,
): Promise<OrderTransitionResult> {
  const { orderId, businessId } = options;
  const now = options.now ?? new Date();
  const scope = scopeFor(orderId, businessId);
  const session = await mongoose.startSession();
  let result: OrderTransitionResult = { applied: false, reason: "not_found" };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOneAndUpdate(
        {
          ...scope,
          paymentMethod: "cod",
          status: "pending",
          inventoryState: "reserved",
          $or: [{ reservationExpiresAt: null }, { reservationExpiresAt: { $gt: now } }],
        },
        {
          $set: {
            status: "paid",
            inventoryState: "consumed",
            paidAt: now,
          },
        },
        { new: true, session },
      );

      if (order) {
        result = { applied: true, order };
        return;
      }

      const existing = await Order.findOne(scope).session(session);
      if (!existing) {
        result = { applied: false, reason: "not_found" };
      } else if (existing.paymentMethod !== "cod") {
        result = { applied: false, reason: "manual_payment_not_allowed", order: existing };
      } else if (existing.status === "paid") {
        result = { applied: false, reason: "already_paid", order: existing };
      } else if (existing.status !== "pending") {
        result = { applied: false, reason: "not_pending", order: existing };
      } else if (existing.inventoryState !== "reserved") {
        result = { applied: false, reason: "legacy_order", order: existing };
      } else if (isExpired(existing, now)) {
        result = { applied: false, reason: "expired", order: existing };
      } else {
        result = { applied: false, reason: "not_pending", order: existing };
      }
    });
  } finally {
    await session.endSession();
  }

  return result;
}

/**
 * Customer/admin cancellation of an unpaid order. Paid orders must go through
 * refundOrder instead; cancellation never restocks a paid order.
 */
export async function cancelOrder(
  options: CancelOrderOptions,
): Promise<OrderTransitionResult> {
  const reason = options.reason ?? "customer";
  if (!["customer", "admin", "payment_failed"].includes(reason)) {
    throw new Error(`Invalid cancellation reason: ${String(reason)}`);
  }
  return cancelPendingOrder({ ...options, reason });
}

/**
 * Expire one due order. Internal helper for the bounded sweeps; it is
 * deliberately not exported so callers must pass through an explicitly named
 * tenant-scoped or internal-global operation.
 */
async function releaseExpiredOrder(
  options: OrderTransitionOptions,
): Promise<OrderTransitionResult> {
  const { orderId, businessId } = options;
  const now = options.now ?? new Date();
  const scope = scopeFor(orderId, businessId);
  const session = await mongoose.startSession();
  let result: OrderTransitionResult = { applied: false, reason: "not_found" };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOneAndUpdate(
        {
          ...scope,
          status: "pending",
          inventoryState: "reserved",
          reservationExpiresAt: { $lte: now },
        },
        {
          $set: {
            status: "cancelled",
            inventoryState: "released",
            cancelReason: "expired",
            cancelledAt: now,
            inventoryReleasedAt: now,
          },
        },
        { new: true, session },
      );

      if (order) {
        await restoreInventory(order, session);
        result = { applied: true, order };
        return;
      }

      const existing = await Order.findOne(scope).session(session);
      if (!existing) {
        result = { applied: false, reason: "not_found" };
      } else if (existing.status === "pending" && existing.inventoryState !== "reserved") {
        result = { applied: false, reason: "legacy_order", order: existing };
      } else {
        // Another transition won, or the order is not yet due.
        result = { applied: false, reason: "not_pending", order: existing };
      }
    });
  } finally {
    await session.endSession();
  }

  return result;
}

interface ExpirySweepOptions {
  businessId?: string;
  now?: Date;
  limit?: number;
  deadlineMs?: number;
  excludeOrderIds?: string[];
}

/**
 * Shared bounded sweep implementation. Each release has its own transaction,
 * and a failure is recorded without preventing later candidates from being
 * attempted. A failed release still rolls back that order's state and any
 * stock increments from the aborted transaction.
 */
async function runExpirySweep(
  options: ExpirySweepOptions,
): Promise<ExpireOrdersResult> {
  const now = options.now ?? new Date();
  const businessId =
    options.businessId !== undefined
      ? requireBusinessScope(options.businessId)
      : undefined;

  const requestedLimit = Number.isFinite(options.limit)
    ? Math.trunc(options.limit as number)
    : ORDER_EXPIRY_BATCH_LIMIT;
  const limit = Math.min(
    Math.max(requestedLimit, 1),
    MAX_ORDER_EXPIRY_BATCH_LIMIT,
  );

  const due = await Order.find({
    ...(businessId ? { business: businessId } : {}),
    ...(options.excludeOrderIds?.length ? { _id: { $nin: options.excludeOrderIds } } : {}),
    status: "pending",
    inventoryState: "reserved",
    reservationExpiresAt: { $ne: null, $lte: now },
  })
    .sort({ reservationExpiresAt: 1, _id: 1 })
    .limit(limit)
    .select("_id business")
    .lean();

  const orderIds: string[] = [];
  const failures: ExpireOrderFailure[] = [];
  let released = 0;
  let attempted = 0;
  let stoppedEarly = false;

  for (const candidate of due) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      stoppedEarly = true;
      break;
    }
    attempted += 1;
    try {
      const result = await releaseExpiredOrder({
        orderId: String(candidate._id),
        businessId: String(candidate.business),
        now,
      });
      if (result.applied) {
        released += 1;
        orderIds.push(String(candidate._id));
      }
    } catch (error) {
      failures.push({
        orderId: String(candidate._id),
        reason: error instanceof Error ? error.message : "release_failed",
      });
    }
  }

  const failed = failures.length;
  return {
    processed: attempted,
    released,
    skipped: attempted - released - failed,
    failed,
    orderIds,
    failures,
    ...(options.deadlineMs !== undefined ? { stoppedEarly } : {}),
  };
}

/**
 * Bounded, tenant-scoped expiry sweep, for routes acting on one store.
 *
 * Only orders with `inventoryState: "reserved"` and an explicit
 * `reservationExpiresAt` are eligible, so legacy pending orders are never
 * released automatically. Each release is its own transaction; concurrent
 * sweeps are safe because the conditional transition has one winner.
 */
export async function releaseExpiredOrders(
  options: ExpireOrdersOptions,
): Promise<ExpireOrdersResult> {
  // Never let a missing runtime scope silently degrade into a global sweep.
  const businessId = requireBusinessScope(options.businessId);
  return runExpirySweep({
    businessId,
    now: options.now,
    limit: options.limit,
  });
}

/**
 * On-demand reservation cleanup for one business. A scheduler is optional
 * (`releaseDueOrdersForScheduler`), so routes that are about to check or reserve
 * stock (cart writes, order creation, the owner's order list) call this first;
 * without one, abandoned unpaid orders would otherwise hold stock until then.
 * Bounded (`limit`) and best-effort: a sweep
 * failure must never block the request that triggered it, because each release
 * is independently safe to retry on the next call.
 */
export async function releaseExpiredOrdersOnDemand(
  businessId: string,
  limit = 20,
): Promise<void> {
  try {
    const result = await releaseExpiredOrders({ businessId, limit });
    if (result.failures.length > 0) {
      console.warn(
        `[orders] ${result.failures.length} expired reservation(s) could not be released for business ${businessId}`,
      );
    }
  } catch (error) {
    // Not rethrown (see above), but never silent: a misconfigured database
    // (e.g. no replica set) would otherwise hold stock forever unnoticed.
    console.warn(
      `[orders] reservation sweep failed for business ${businessId}:`,
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

/**
 * Internal-only, cross-tenant expiry sweep for a deployment worker.
 *
 * This is intentionally named to make its blast radius obvious. Do not export
 * it through a server action or any tenant-facing boundary. Its only route is
 * the scheduler's, behind its own secret (`releaseDueOrdersForScheduler`).
 */
export async function releaseExpiredOrdersInternalGlobal(
  options: GlobalExpireOrdersOptions = {},
): Promise<ExpireOrdersResult> {
  return runExpirySweep({
    now: options.now,
    limit: options.limit,
    deadlineMs: options.deadlineMs,
    excludeOrderIds: options.excludeOrderIds,
  });
}

/**
 * One scheduled run (app/api/cron/order-expiry; lib/scheduled-jobs.ts stops two overlapping). Oldest
 * first, at most `limit` orders, each released in its own transaction by the same conditional step as
 * every other release, so stock and coupon uses come back exactly once. Which orders are due is the
 * sweep's existing rule: nothing here decides expiry.
 *
 * An order that fails rolls back alone and is counted. Failures would otherwise take the oldest places
 * in every later run and could keep newer orders waiting, so a full batch with failures also looks that
 * many places past them. They are tried again next run. Counts only: an error could hold order details.
 */
export async function releaseDueOrdersForScheduler(options: { limit: number; timeBudgetMs: number }): Promise<{ checked: number; changed: number; failed: number; skipped: number; stoppedEarly: boolean }> {
  const deadlineMs = Date.now() + options.timeBudgetMs;
  const first = await releaseExpiredOrdersInternalGlobal({ limit: options.limit, deadlineMs });
  const firstBatchFull = first.processed >= options.limit;
  const second =
    first.failed > 0 && firstBatchFull && !first.stoppedEarly
      ? await releaseExpiredOrdersInternalGlobal({ limit: first.failed, deadlineMs, excludeOrderIds: first.failures.map((failure) => failure.orderId) })
      : null;
  const failed = first.failed + (second?.failed ?? 0);
  if (failed > 0) console.warn("[orders] some expired reservations could not be released", { operation: "order_expiry", failed });
  return {
    checked: first.processed + (second?.processed ?? 0),
    changed: first.released + (second?.released ?? 0),
    failed,
    skipped: first.skipped + (second?.skipped ?? 0),
    // A full batch means more may be waiting: the next run carries on.
    stoppedEarly: Boolean(first.stoppedEarly || second?.stoppedEarly) || (second ? second.processed >= first.failed : firstBatchFull),
  };
}

/**
 * Paid -> refunded. Inventory is deliberately NOT restored automatically:
 * a refund does not prove the goods were returned, and partial/returned
 * quantities need a separate audited flow.
 */
export async function refundOrder(
  options: OrderTransitionOptions,
): Promise<OrderTransitionResult> {
  const { orderId, businessId } = options;
  const now = options.now ?? new Date();
  const scope = scopeFor(orderId, businessId);
  const session = await mongoose.startSession();
  let result: OrderTransitionResult = { applied: false, reason: "not_found" };

  try {
    await session.withTransaction(async () => {
      const order = await Order.findOneAndUpdate(
        { ...scope, status: "paid", refundHoldTotal: { $in: [null, 0] } },
        { $set: { status: "refunded", refundedAt: now } },
        { new: true, session },
      );

      if (order) {
        result = { applied: true, order };
        return;
      }

      const existing = await Order.findOne(scope).session(session);
      if (!existing) {
        result = { applied: false, reason: "not_found" };
      } else if (existing.status === "refunded") {
        result = { applied: false, reason: "already_refunded", order: existing };
      } else if (existing.status === "paid") {
        result = { applied: false, reason: "refund_in_progress", order: existing };
      } else {
        result = { applied: false, reason: "not_paid", order: existing };
      }
    });
  } finally {
    await session.endSession();
  }

  return result;
}
