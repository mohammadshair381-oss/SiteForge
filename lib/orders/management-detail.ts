import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { toManagedOrderView, type ManagedOrderView } from "@/lib/orders/management";
import { INVENTORY_REASON_TEXT, buildOrderTimeline, type OrderTimelineEvent } from "@/lib/orders/timeline";
import { blockingRefundReview, refundRecoveryState } from "@/lib/payments/order-refunds";
import { InventoryMovement } from "@/models/InventoryMovement";
import { Order, type OrderDoc } from "@/models/Order";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";
import { OrderRefund, type OrderRefundDoc } from "@/models/OrderRefund";
import { PaymentDispute } from "@/models/PaymentDispute";
import { User } from "@/models/User";

/**
 * One order with its payment history, for its owner (server-only). Allowlisted:
 * payment links, secrets and idempotency keys stay on the server, and everything
 * is scoped to the business from the route.
 */
export interface ManagedOrderDetail {
  order: ManagedOrderView;
  payments: Array<{ id: string; status: string; mode: string; amount: number; currency: string; createdAt: string; paidAt: string | null; providerPaymentId: string | null; lastFailureAt: string | null; lastFailureCode: string | null; needsReview: boolean }>;
  refunds: Array<{
    id: string;
    provider: string;
    mode: string | null;
    status: string;
    amount: number;
    currency: string;
    reason: string;
    restock: boolean;
    failureCode: string | null;
    createdAt: string;
    processedAt: string | null;
    startedOutside: boolean;
    /** Whether Razorpay has given this refund an id: then only Razorpay's answer can settle it. */
    knownToRazorpay: boolean;
    /** Stuck, and its hold may be released by the owner (lib/payments/order-refunds.ts `refundRecoveryState`). */
    recoverable: boolean;
    recoverableFrom: string | null;
    /**
     * An unresolved Razorpay report on this order has the same payment and amount, so releasing the hold is
     * refused (`blockingRefundReview`, checked again inside the release itself). Display only.
     */
    recoveryBlockedByReview: boolean;
    /**
     * Which of the outcomes this is, so they are never shown alike: Razorpay confirmed it, Razorpay reported it
     * failed, the owner released its hold, or it is still in progress. A manual refund is "recorded".
     */
    outcome: "provider_confirmed" | "provider_failed" | "owner_released" | "recorded" | "in_progress";
    /** The owner's release of its hold, from the record written with it. The actor by name only, never an id. */
    recovery: { at: string; reason: string; byName: string; previousStatus: string; resultingStatus: string; heldBefore: number; heldAfter: number } | null;
    /** What Razorpay said after that release. */
    lateReport: { at: string; outcome: string; providerStatus: string; issue: string | null } | null;
    /** Recorded from Razorpay's late report on an earlier released refund. */
    confirmsRecoveryOf: string | null;
  }>;
  /**
   * Razorpay refunds reported for this order that could not be attached to exactly one refund record, so
   * nothing was decided about them (lib/payments/order-refunds.ts `recordRefundReview`). Not failures.
   */
  refundReviews: Array<{
    providerRefundId: string;
    providerPaymentId: string;
    amount: number;
    currency: string;
    providerStatus: string;
    reason: string;
    candidateCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    resolvedAt: string | null;
  }>;
  /** What is left to refund, and whether a Razorpay refund is possible. */
  refundable: number;
  canRefundOnline: boolean;
  /** What happened to this order, oldest first. */
  timeline: OrderTimelineEvent[];
  /** Stock changes this order caused. Same audience as the order: owners and managers. */
  inventory: Array<{ id: string; at: string; productName: string; variantLabel: string; delta: number; stockAfter: number | null; reason: string }>;
}

const iso = (value: unknown) => (value ? new Date(value as string | Date).toISOString() : null);

export async function loadManagedOrderDetail(businessId: string, orderId: string): Promise<ManagedOrderDetail> {
  await dbConnect();
  const business = new mongoose.Types.ObjectId(businessId);
  const id = new mongoose.Types.ObjectId(orderId);
  // `refundReviews` is left out of every other read (`select: false`); the team's own view asks for it.
  const order = await Order.findOne({ _id: id, business }).select("-ownerToken -idempotencyKey -orderProofHash +refundReviews").lean<OrderDoc>();
  if (!order) throw new HttpError(404, "Order not found", "not_found");
  const [payments, refunds, dispute, movements] = await Promise.all([
    OrderPayment.find({ business, order: id }).sort({ createdAt: -1 }).lean<OrderPaymentDoc[]>(),
    OrderRefund.find({ business, order: id }).sort({ createdAt: -1 }).lean<OrderRefundDoc[]>(),
    PaymentDispute.findOne({ business, order: id }).sort({ createdAt: -1 }).select("status respondBy").lean<{ status: string; respondBy?: Date | null }>(),
    InventoryMovement.find({ business, order: id }).sort({ createdAt: 1 }).limit(100).select("product variant delta stockAfter reason createdAt").lean<Array<{ _id: unknown; product: unknown; variant?: unknown; delta: number; stockAfter?: number | null; reason: string; createdAt: Date }>>(),
  ]);
  // Who released a hold, by name. Owners of this store only ever act on its refunds.
  const actorIds = [...new Set(refunds.flatMap((r) => (r.recovery?.by ? [String(r.recovery.by)] : [])))];
  const actors = actorIds.length > 0 ? await User.find({ _id: { $in: actorIds } }).select("name").lean<Array<{ _id: unknown; name: string }>>() : [];
  const actorName = new Map(actors.map((actor) => [String(actor._id), actor.name]));
  const lineFor = (product: unknown, variant: unknown) => (order.items ?? []).find((item) => String(item.product) === String(product) && String(item.variant ?? "") === String(variant ?? ""));
  const view = toManagedOrderView(order, {
    paymentNeedsReview: payments.some((p) => p.orderOutcome === "needs_review"),
    dispute: dispute ? { status: dispute.status, respondBy: dispute.respondBy ?? null } : null,
    payments,
  });
  const refundable = order.status === "paid" ? Math.max(0, Number(order.total ?? 0) - Number(order.refundedTotal ?? 0) - Number(order.refundHoldTotal ?? 0)) : 0;
  return {
    order: view,
    payments: payments.map((p) => ({
      id: String(p._id),
      status: p.status,
      mode: p.mode,
      amount: p.amountMinor / 100,
      currency: p.currency,
      createdAt: iso(p.createdAt) as string,
      paidAt: iso(p.paidAt),
      providerPaymentId: p.providerPaymentId,
      lastFailureAt: iso(p.lastFailureAt),
      lastFailureCode: p.lastFailureCode ?? null,
      needsReview: p.orderOutcome === "needs_review",
    })),
    refunds: refunds.map((r) => {
      const recovery = refundRecoveryState(r);
      const outcome: ManagedOrderDetail["refunds"][number]["outcome"] =
        r.status === "pending" ? "in_progress" : r.provider === "manual" ? "recorded" : r.recovery ? "owner_released" : r.status === "processed" ? "provider_confirmed" : "provider_failed";
      return {
        id: String(r._id),
        provider: r.provider,
        mode: r.mode,
        status: r.status,
        amount: r.amount,
        currency: r.currency,
        reason: r.reason,
        restock: r.restock,
        failureCode: r.failureCode,
        createdAt: iso(r.createdAt) as string,
        processedAt: iso(r.processedAt),
        startedOutside: r.provider === "razorpay" && r.createdBy === null && !r.confirmsRecoveryOf,
        knownToRazorpay: Boolean(r.providerRefundId),
        recoverable: recovery.recoverable,
        recoverableFrom: iso(recovery.recoverableFrom),
        recoveryBlockedByReview: recovery.recoverable && blockingRefundReview(order, r),
        outcome,
        recovery: r.recovery
          ? {
              at: iso(r.recovery.at) as string,
              reason: r.recovery.reason,
              byName: actorName.get(String(r.recovery.by)) ?? "The owner",
              previousStatus: r.recovery.previousStatus,
              resultingStatus: r.recovery.resultingStatus,
              heldBefore: r.recovery.heldBefore,
              heldAfter: r.recovery.heldAfter,
            }
          : null,
        lateReport: r.lateProviderReport
          ? { at: iso(r.lateProviderReport.at) as string, outcome: r.lateProviderReport.outcome, providerStatus: r.lateProviderReport.providerStatus, issue: r.lateProviderReport.issue ?? null }
          : null,
        confirmsRecoveryOf: r.confirmsRecoveryOf ? String(r.confirmsRecoveryOf) : null,
      };
    }),
    refundReviews: (order.refundReviews ?? []).map((review) => ({
      providerRefundId: review.providerRefundId,
      providerPaymentId: review.providerPaymentId ?? "",
      amount: review.amountMinor / 100,
      currency: review.currency || order.currency || "",
      providerStatus: review.providerStatus ?? "",
      reason: review.reason,
      candidateCount: (review.candidateRefunds ?? []).length,
      firstSeenAt: iso(review.firstSeenAt) as string,
      lastSeenAt: iso(review.lastSeenAt) as string,
      resolvedAt: iso(review.resolvedAt),
    })),
    refundable: Math.round(refundable * 100) / 100,
    canRefundOnline: order.status === "paid" && payments.some((p) => p.status === "paid" && p.orderOutcome === "applied" && Boolean(p.providerPaymentId)),
    timeline: buildOrderTimeline(order, payments, refunds),
    inventory: movements.map((movement) => ({
      id: String(movement._id),
      at: new Date(movement.createdAt).toISOString(),
      productName: lineFor(movement.product, movement.variant)?.productName ?? "Product",
      variantLabel: lineFor(movement.product, movement.variant)?.variantLabel ?? "",
      delta: movement.delta,
      stockAfter: movement.stockAfter ?? null,
      reason: INVENTORY_REASON_TEXT[movement.reason] ?? movement.reason,
    })),
  };
}
