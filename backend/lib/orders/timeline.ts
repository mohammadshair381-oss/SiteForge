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
  failureCode?: string | null;
  /** The owner released this refund's hold after checking Razorpay (lib/payments/order-refunds.ts). */
  recovery?: { at: Date | string; heldBefore?: number; heldAfter?: number } | null;
  /** What Razorpay reported after that release. */
  lateProviderReport?: { at: Date | string; outcome: string } | null;
  /** Recorded from such a late report. */
  confirmsRecoveryOf?: unknown;
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

/** Why a Razorpay refund report was not attached. None of these is a failure: nothing was decided. */
export const REVIEW_REASON_TEXT: Record<string, string> = {
  ambiguous_match: "It matches more than one refund on this order, so it was not attached to any",
  released_refund_bound_elsewhere: "The refund it matches is already linked to a different Razorpay refund, so it was not attached",
  claim_lost: "The refund it matches changed before the report could be attached to it, so it was not attached",
  duplicate_conflict: "Another refund record already holds this Razorpay refund, so it was not attached again",
  does_not_fit_order:
    "Razorpay says this refund was completed, but no refund here stands for it and it is more than this order has left to refund, or the order can no longer be refunded. It was not recorded, so the customer may have been refunded twice. Check it in Razorpay's dashboard",
};

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
    const value = money(refund.amount, refund.currency);
    const how = refund.provider === "manual" ? "recorded by your team" : refund.confirmsRecoveryOf ? "reported by Razorpay after the owner released an earlier hold" : "through Razorpay";
    add(iso(refund.createdAt), "refund", refund.confirmsRecoveryOf ? `Razorpay reported a refund of ${value} after its hold was released` : `Refund of ${value} started`, how);
    // Three different outcomes, never worded alike: confirmed by Razorpay, refused by Razorpay, released by the owner.
    if (refund.status === "processed") add(iso(refund.processedAt), "refund", `Refund of ${value} completed`, refund.provider === "manual" ? how : "confirmed by Razorpay");
    if (refund.status === "failed" && refund.recovery) {
      const impact = typeof refund.recovery.heldBefore === "number" && typeof refund.recovery.heldAfter === "number" ? ` Held on the order: ${money(refund.recovery.heldBefore, refund.currency)} before, ${money(refund.recovery.heldAfter, refund.currency)} after.` : "";
      add(iso(refund.recovery.at), "refund", `Refund hold of ${value} manually released by the owner`, `The owner confirmed that no refund was visible in Razorpay's dashboard at the time. Razorpay never reported a result.${impact}`);
    } else if (refund.status === "failed") {
      add(
        iso(refund.processedAt) ?? iso(refund.createdAt),
        "refund",
        `Refund of ${value} did not go through`,
        refund.provider === "manual" ? how : refund.failureCode === "account_unavailable" ? "never sent: the Razorpay account was not available" : "Razorpay refused or failed it",
      );
    }
    const late = refund.lateProviderReport;
    if (refund.recovery && late) {
      const text =
        late.outcome === "recorded"
          ? "Razorpay later reported that this refund was made: it is recorded as its own refund"
          : late.outcome === "provider_failed"
            ? "Razorpay later confirmed that this refund was not made"
            : "Razorpay later reported on this refund, and it needs review";
      add(iso(late.at), "refund", text, value);
    }
  }

  add(iso(order.cancelledAt), "order", (order.cancelReason && CANCEL_TEXT[order.cancelReason]) || "Cancelled");
  add(iso(order.inventoryReleasedAt), "order", "Stock returned");
  add(iso(order.refundedAt), "refund", "Order fully refunded");

  // Razorpay refunds that could not be attached to exactly one refund: nothing was decided, so never a failure.
  for (const review of order.refundReviews ?? []) {
    const value = money(review.amountMinor / 100, review.currency || order.currency || "");
    add(
      iso(review.firstSeenAt),
      "refund",
      review.reason === "does_not_fit_order" ? `Razorpay reported a completed refund of ${value} that could not be recorded` : `Razorpay reported a refund of ${value} that needs review`,
      `${REVIEW_REASON_TEXT[review.reason] ?? "It could not be attached to a refund on this order"} (${review.providerRefundId})`,
    );
    add(iso(review.resolvedAt), "refund", `Razorpay refund ${review.providerRefundId} matched to one refund after review`);
  }

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
