import type { OrderDoc } from "@/models/Order";

/**
 * One order's history for its owner (pure). Worked out from what the order, its payments
 * and its refunds already record, so it is just as complete for orders placed before this
 * existed. Nothing is stored twice, and only delivery updates add a record of their own.
 */
export type OrderEventKind = "order" | "payment" | "delivery" | "refund";

export interface OrderTimelineEvent {
  at: string;
  kind: OrderEventKind;
  label: string;
  detail: string;
}

interface PaymentFacts {
  status: string;
  mode: string;
  createdAt?: Date | string | null;
  paidAt?: Date | string | null;
  lastFailureAt?: Date | string | null;
  lastFailureCode?: string | null;
}

interface RefundFacts {
  provider: string;
  status: string;
  amount: number;
  currency: string;
  createdAt?: Date | string | null;
  processedAt?: Date | string | null;
}

const CANCEL_TEXT: Record<string, string> = {
  customer: "Cancelled by the customer",
  admin: "Cancelled by your team",
  expired: "Cancelled: the stock hold ended without payment or confirmation",
  payment_failed: "Cancelled: the payment failed",
};

const DELIVERY_TEXT: Record<string, string> = {
  unfulfilled: "Delivery: not started",
  processing: "Delivery: preparing",
  shipped: "Delivery: shipped",
  delivered: "Delivery: delivered",
};

const PAYMENT_METHOD_TEXT: Record<string, string> = { cod: "Cash on delivery", online: "Online payment" };

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const money = (amount: number, currency: string) => `${currency} ${Number(amount).toFixed(2)}`;

export function buildOrderTimeline(order: Partial<OrderDoc>, payments: readonly PaymentFacts[], refunds: readonly RefundFacts[]): OrderTimelineEvent[] {
  const events: OrderTimelineEvent[] = [];
  const add = (at: string | null, kind: OrderEventKind, label: string, detail = "") => {
    if (at) events.push({ at, kind, label, detail });
  };

  add(iso(order.createdAt), "order", "Order placed", [order.paymentMethod ? PAYMENT_METHOD_TEXT[order.paymentMethod] : "No payment method chosen", order.customer ? "registered customer" : "guest"].join(" · "));

  for (const payment of payments) {
    const test = payment.mode === "test" ? " (test mode)" : "";
    add(iso(payment.createdAt), "payment", `Online payment started${test}`);
    add(iso(payment.lastFailureAt), "payment", "A payment attempt was declined", payment.lastFailureCode ?? "");
    add(iso(payment.paidAt), "payment", `Payment confirmed by Razorpay${test}`);
  }
  if (order.paidAt && order.paymentMethod !== "online") {
    add(iso(order.paidAt), "payment", order.paymentMethod === "cod" ? "Marked paid: cash received" : "Marked paid");
  }

  const recorded = order.fulfillmentEvents ?? [];
  for (const event of recorded) {
    const tracking = [event.carrier, event.number].filter(Boolean).join(" ");
    add(iso(event.at), "delivery", DELIVERY_TEXT[event.status] ?? "Delivery updated", tracking);
  }
  // Orders from before delivery updates were recorded still have these dates.
  if (!recorded.some((event) => event.status === "shipped")) add(iso(order.shippedAt), "delivery", DELIVERY_TEXT.shipped);
  if (!recorded.some((event) => event.status === "delivered")) add(iso(order.deliveredAt), "delivery", DELIVERY_TEXT.delivered);

  for (const refund of refunds) {
    const how = refund.provider === "manual" ? "recorded by your team" : "through Razorpay";
    add(iso(refund.createdAt), "refund", `Refund of ${money(refund.amount, refund.currency)} started`, how);
    if (refund.status === "processed") add(iso(refund.processedAt), "refund", `Refund of ${money(refund.amount, refund.currency)} completed`, how);
    if (refund.status === "failed") add(iso(refund.processedAt) ?? iso(refund.createdAt), "refund", `Refund of ${money(refund.amount, refund.currency)} did not go through`, how);
  }

  add(iso(order.cancelledAt), "order", (order.cancelReason && CANCEL_TEXT[order.cancelReason]) || "Cancelled");
  add(iso(order.inventoryReleasedAt), "order", "Stock returned");
  add(iso(order.refundedAt), "refund", "Order fully refunded");

  return events.sort((a, b) => a.at.localeCompare(b.at));
}

export const INVENTORY_REASON_TEXT: Record<string, string> = {
  order_reserved: "Held for this order",
  order_released: "Returned to stock",
  order_refunded: "Returned with a refund",
  product_restored: "Restored from archive",
  adjustment: "Adjusted by your team",
  restock: "Restocked",
  damage: "Written off as damaged",
  correction: "Corrected",
  initial: "Starting stock",
  variants_created: "Moved to variant stock",
};
