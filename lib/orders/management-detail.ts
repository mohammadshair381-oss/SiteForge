import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { toManagedOrderView, type ManagedOrderView } from "@/lib/orders/management";
import { INVENTORY_REASON_TEXT, buildOrderTimeline, type OrderTimelineEvent } from "@/lib/orders/timeline";
import { InventoryMovement } from "@/models/InventoryMovement";
import { Order, type OrderDoc } from "@/models/Order";
import { OrderPayment, type OrderPaymentDoc } from "@/models/OrderPayment";
import { OrderRefund, type OrderRefundDoc } from "@/models/OrderRefund";
import { PaymentDispute } from "@/models/PaymentDispute";

/**
 * One order with its payment history, for its owner (server-only). Allowlisted:
 * payment links, secrets and idempotency keys stay on the server, and everything
 * is scoped to the business from the route.
 */
export interface ManagedOrderDetail {
  order: ManagedOrderView;
  payments: Array<{ id: string; status: string; mode: string; amount: number; currency: string; createdAt: string; paidAt: string | null; providerPaymentId: string | null; lastFailureAt: string | null; lastFailureCode: string | null; needsReview: boolean }>;
  refunds: Array<{ id: string; provider: string; mode: string | null; status: string; amount: number; currency: string; reason: string; restock: boolean; failureCode: string | null; createdAt: string; processedAt: string | null; startedOutside: boolean }>;
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
  const order = await Order.findOne({ _id: id, business }).select("-ownerToken -idempotencyKey -orderProofHash").lean<OrderDoc>();
  if (!order) throw new HttpError(404, "Order not found", "not_found");
  const [payments, refunds, dispute, movements] = await Promise.all([
    OrderPayment.find({ business, order: id }).sort({ createdAt: -1 }).lean<OrderPaymentDoc[]>(),
    OrderRefund.find({ business, order: id }).sort({ createdAt: -1 }).lean<OrderRefundDoc[]>(),
    PaymentDispute.findOne({ business, order: id }).sort({ createdAt: -1 }).select("status respondBy").lean<{ status: string; respondBy?: Date | null }>(),
    InventoryMovement.find({ business, order: id }).sort({ createdAt: 1 }).limit(100).select("product variant delta stockAfter reason createdAt").lean<Array<{ _id: unknown; product: unknown; variant?: unknown; delta: number; stockAfter?: number | null; reason: string; createdAt: Date }>>(),
  ]);
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
    refunds: refunds.map((r) => ({
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
      startedOutside: r.provider === "razorpay" && r.createdBy === null,
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
