import type { OrderDoc } from "@/models/Order";

/**
 * Business-facing order view (owner/manager dashboard). Allowlisted so guest
 * secrets (`ownerToken`, `orderProofHash`, `idempotencyKey`) never leave the
 * server even if a query forgets to exclude them.
 */
export interface ManagedOrderView {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  items: Array<{ productName: string; variantLabel: string; sku: string; quantity: number; unitPrice: number; currency: string }>;
  total: number;
  currency: string;
  status: OrderDoc["status"];
  cancelReason: string | null;
  reservationExpiresAt: Date | null;
  /** "online" | "cod" | null (legacy / not recorded). */
  paymentMethod: "online" | "cod" | null;
  /**
   * Whether a signed-in storefront customer account placed the order. Only
   * this flag leaves the server, never the account id or any account data.
   */
  placedBy: "registered" | "guest";
  /**
   * True when the payment provider confirmed a payment for this order that
   * could not be applied (e.g. it arrived after the reservation was released).
   * The owner must refund or fulfil it manually.
   */
  paymentNeedsReview: boolean;
  /** Latest provider-reported dispute on this order's online payment, if any. */
  dispute: { status: string; respondBy: Date | null } | null;
  /** Unpaid, partly or fully refunded and so on, from the order's own numbers. */
  paymentStatus: OrderPaymentStatusLabel;
  /** Paid with test keys: no real money moved. */
  testPayment: boolean;
  /** A declined attempt or an expired payment link on this order. */
  paymentFailed: boolean;
  refundedTotal: number;
  refundPendingTotal: number;
  taxTotal: number;
  taxLabel: string;
  taxInclusive: boolean;
  shippingZoneName: string;
  internalNote: string;
  createdAt: Date;
  paidAt: Date | null;
  cancelledAt: Date | null;
  refundedAt: Date | null;
  subtotal: number;
  discount: { code: string; amount: number } | null;
  shippingTotal: number | null;
  shippingAddress: OrderDoc["shippingAddress"] | null;
  fulfillmentStatus: "unfulfilled" | "processing" | "shipped" | "delivered";
  trackingCarrier: string;
  trackingNumber: string;
  trackingUrl: string;
  shippedAt: Date | null;
  deliveredAt: Date | null;
}

export const MANAGED_ORDER_STATUSES = ["pending", "paid", "cancelled", "refunded"] as const;

export type OrderPaymentStatusLabel = "awaiting_payment" | "cod_due" | "paid" | "partially_refunded" | "refunded" | "cancelled";

export function derivePaymentStatus(order: Pick<Partial<OrderDoc>, "status" | "paymentMethod" | "refundedTotal">): OrderPaymentStatusLabel {
  if (order.status === "refunded") return "refunded";
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "paid") return Number(order.refundedTotal ?? 0) > 0 ? "partially_refunded" : "paid";
  return order.paymentMethod === "cod" ? "cod_due" : "awaiting_payment";
}

export const ORDER_MANAGEMENT_ACTIONS = ["mark_paid", "cancel", "refund"] as const;
export type OrderManagementAction = (typeof ORDER_MANAGEMENT_ACTIONS)[number];

export function toManagedOrderView(
  order: Partial<OrderDoc> & { _id: unknown },
  options: {
    paymentNeedsReview?: boolean;
    dispute?: { status: string; respondBy: Date | null } | null;
    payments?: ReadonlyArray<{ status: string; mode: string; lastFailureAt?: Date | null }>;
  } = {},
): ManagedOrderView {
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    id: String(order._id),
    orderNumber: String(order.orderNumber ?? ""),
    customerName: String(order.customerName ?? ""),
    customerEmail: String(order.customerEmail ?? ""),
    items: items.map((item) => ({
      productName: String(item.productName ?? ""),
      variantLabel: String(item.variantLabel ?? ""),
      sku: String(item.sku ?? ""),
      quantity: Number(item.quantity ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      currency: String(item.currency ?? order.currency ?? ""),
    })),
    total: Number(order.total ?? 0),
    currency: String(order.currency ?? items[0]?.currency ?? ""),
    status: order.status ?? "pending",
    cancelReason: order.cancelReason ?? null,
    reservationExpiresAt: order.reservationExpiresAt ?? null,
    paymentMethod: order.paymentMethod === "online" || order.paymentMethod === "cod" ? order.paymentMethod : null,
    placedBy: order.customer ? "registered" : "guest",
    paymentNeedsReview: options.paymentNeedsReview === true,
    dispute: options.dispute ?? null,
    paymentStatus: derivePaymentStatus(order),
    testPayment: (options.payments ?? []).some((p) => p.status === "paid" && p.mode === "test"),
    paymentFailed: order.status !== "paid" && order.status !== "refunded" && (options.payments ?? []).some((p) => p.status === "failed" || Boolean(p.lastFailureAt)),
    refundedTotal: order.status === "refunded" ? Number(order.total ?? 0) : Number(order.refundedTotal ?? 0),
    refundPendingTotal: Number(order.refundHoldTotal ?? 0),
    taxTotal: Number(order.taxTotal ?? 0),
    taxLabel: String(order.taxLabel ?? ""),
    taxInclusive: Boolean(order.taxInclusive),
    shippingZoneName: String(order.shippingZoneName ?? ""),
    internalNote: String(order.internalNote ?? ""),
    createdAt: order.createdAt as Date,
    paidAt: order.paidAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    refundedAt: order.refundedAt ?? null,
    subtotal: Number(order.subtotal ?? order.total ?? 0),
    discount: order.discount ? { code: String(order.discount.code ?? ""), amount: Number(order.discount.amount ?? 0) } : null,
    shippingTotal: typeof order.shippingTotal === "number" ? order.shippingTotal : null,
    shippingAddress: order.shippingAddress ?? null,
    fulfillmentStatus: order.fulfillmentStatus ?? "unfulfilled",
    trackingCarrier: String(order.trackingCarrier ?? ""),
    trackingNumber: String(order.trackingNumber ?? ""),
    trackingUrl: String(order.trackingUrl ?? ""),
    shippedAt: order.shippedAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
  };
}

/** Human message for a transition the lifecycle refused. */
export function transitionRefusalMessage(reason: string | undefined): string {
  switch (reason) {
    case "manual_payment_not_allowed":
      return "Only cash-on-delivery orders can be marked paid manually. Online payments are confirmed automatically by the payment provider.";
    case "expired":
      return "This order's stock reservation has expired, so it can no longer be marked paid. Ask the customer to order again.";
    case "legacy_order":
      return "This older order predates stock reservations and can't be changed here.";
    case "already_paid":
      return "This order is already marked paid.";
    case "already_cancelled":
      return "This order is already cancelled.";
    case "already_refunded":
      return "This order is already refunded.";
    case "not_paid":
      return "Only paid orders can be refunded.";
    case "not_pending":
      return "Only pending orders can be changed this way.";
    case "refund_in_progress":
      return "A refund on this order is still in progress. Check it first.";
    default:
      return "This order can't be changed right now. Reload and try again.";
  }
}
