"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatPrice } from "@/lib/format";
import { ConfirmHost, confirmDialog } from "@/components/ui/ConfirmDialog";
import ReviewPanel from "./ReviewPanel";
import { cartErrorMessage } from "./shopping-messages";

interface OrderView {
  orderId: string;
  orderNumber: string;
  status: "pending" | "paid" | "cancelled" | "refunded";
  currency: string;
  items: Array<{ productName: string; variantLabel?: string; quantity: number; unitPrice: number; currency: string; imageUrl?: string }>;
  total: number;
  customerName: string;
  createdAt: string;
  reservationExpiresAt: string | null;
  cancelReason: string | null;
  canCancel: boolean;
  placedAsGuest?: boolean;
  paymentMethod?: "cod" | "online" | null;
  subtotal?: number;
  discountCode?: string | null;
  discountTotal?: number;
  shippingTotal?: number | null;
  taxTotal?: number;
  taxLabel?: string;
  taxInclusive?: boolean;
  refundedTotal?: number;
  paymentAttemptFailed?: boolean;
  fulfillmentStatus?: "unfulfilled" | "processing" | "shipped" | "delivered";
  tracking?: { carrier: string; number: string; url: string } | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
}

const FULFILLMENT_STEPS = [
  { key: "processing", label: "Preparing" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
] as const;

const STATUS_TEXT: Record<OrderView["status"], string> = {
  pending: "Received — awaiting payment",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

/**
 * Guest order confirmation/status. Access is proven by the httpOnly
 * `order-access` cookie set at checkout; without it the API returns the same
 * 404 as for a non-existent order, so nothing leaks.
 */
export default function OrderStatusView({
  businessId,
  orderId,
  paymentResult = null,
}: {
  businessId: string;
  orderId: string;
  /**
   * `?payment=` after returning from the payment provider. Display only: the
   * order's status always comes from the server, which marks an order paid
   * only after verifying the payment with the provider.
   */
  paymentResult?: string | null;
}) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/orders/${orderId}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          res.status === 404
            ? "We couldn't find this order on this device. Order details are only available in the browser that placed the order."
            : cartErrorMessage(data.code, data.error),
        );
        return;
      }
      setError(null);
      setOrder(data);
    } catch {
      setError("Network error. Please reload the page.");
    }
  }, [businessId, orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function cancel() {
    if (cancelling) return;
    const confirmed = await confirmDialog({ title: "Cancel this order?", message: "The items go back on sale and this order can't be restored.", confirmLabel: "Cancel order", cancelLabel: "Keep order", tone: "danger" });
    if (!confirmed) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      // Reload first: a successful reload clears the error, so set it after.
      await load();
      if (!res.ok) {
        setError(cartErrorMessage(data.code, data.error ?? "This order can no longer be cancelled."));
      }
    } catch {
      setError("Network error. The order was not cancelled — please try again.");
    } finally {
      setCancelling(false);
    }
  }

  async function payNow() {
    if (paying) return;
    setPaying(true);
    setError(null);
    try {
      const res = await fetch(`/api/storefront/orders/${orderId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.url === "string" && data.url.startsWith("https://")) {
        window.location.assign(data.url);
        return;
      }
      setError(cartErrorMessage(data.code, data.error));
      await load();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPaying(false);
    }
  }

  if (error && !order) {
    return (
      <div role="alert" className="sf-acc-card p-8 text-center">
        <p className="sf-acc-muted">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm font-semibold underline">Back to the store</Link>
      </div>
    );
  }
  if (!order) return <p className="sf-acc-muted py-10 text-center">Loading your order…</p>;

  const expires = order.reservationExpiresAt ? new Date(order.reservationExpiresAt) : null;

  return (
    <div className="sf-acc-card p-6">
      <ConfirmHost inline />
      {order.status === "pending" && (
        <div className="mb-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
          <p className="font-semibold">Thank you, {order.customerName}! Your order was received.</p>
          <p className="mt-1">
            {order.paymentMethod === "cod"
              ? "What happens next: the store confirms your order, then prepares and delivers it. You pay in cash on delivery."
              : order.paymentMethod === "online"
                ? "What happens next: complete the payment. The store starts on your order once it is confirmed."
                : "What happens next: the store will contact you to arrange payment."}
          </p>
          {order.placedAsGuest && <p className="mt-1">Keep your order number. This page only opens in the browser you ordered from.</p>}
        </div>
      )}
      <h2 className="sf-acc-title font-display text-xl">Order #{order.orderNumber}</h2>
      <p className="sf-acc-muted mt-1 text-sm">Status: <strong>{STATUS_TEXT[order.status]}</strong></p>
      {order.paymentMethod === "cod" && (
        <p className="sf-acc-muted mt-1 text-sm">
          Payment: <strong>Cash on delivery</strong>
          {order.status === "pending" ? ` — please have ${formatPrice(order.total, order.currency)} ready when your order arrives.` : null}
        </p>
      )}
      {order.paymentMethod === "cod" && order.status === "pending" && expires && (
        <p className="sf-acc-muted mt-2 text-sm">
          Your items are held until {expires.toLocaleDateString([], { dateStyle: "medium" })} while the store confirms your order. They are held for as long as needed once it does.
        </p>
      )}
      {order.paymentMethod === "online" && (
        <p className="sf-acc-muted mt-1 text-sm">
          Payment: <strong>Online (Razorpay)</strong>
        </p>
      )}
      {order.paymentMethod === "online" && order.status === "pending" && paymentResult && (
        <p className="mt-3 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800" role="status">
          {paymentResult === "failed"
            ? "The payment was not completed. You can try again below."
            : paymentResult === "review"
              ? "Your payment was received after the reservation ended. The store will contact you about a refund or your order."
              : "We are confirming your payment with the payment provider. This page updates once it is confirmed — please reload in a moment."}
        </p>
      )}
      {order.paymentMethod === "online" && order.status === "paid" && paymentResult === "success" && (
        <p className="mt-3 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
          Payment confirmed. Thank you!
        </p>
      )}
      {order.status === "pending" && expires && order.paymentMethod === "online" && (
        <p className="sf-acc-muted mt-2 text-sm">
          Your items are reserved until {expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Complete the payment
          before then; unpaid orders are released after the reservation ends.
        </p>
      )}
      {order.status === "pending" && expires && order.paymentMethod !== "online" && order.paymentMethod !== "cod" && (
        <p className="sf-acc-muted mt-2 text-sm">
          Your items are reserved until {expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
          No payment was taken online; the store will contact you to arrange payment. Unpaid orders are released after the reservation ends.
        </p>
      )}
      <ul className="sf-acc-divide sf-acc-rule mt-5 divide-y border-y text-sm">
        {order.items.map((item, index) => (
          <li key={index} className="flex items-center justify-between gap-3 py-2">
            {item.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.imageUrl} alt="" loading="lazy" className="sf-acc-control h-12 w-12 shrink-0 object-cover" />
            )}
            <span className="min-w-0 flex-1">
              {item.quantity} × {item.productName}
              {item.variantLabel && <span className="sf-acc-muted block text-xs">{item.variantLabel}</span>}
            </span>
            <span className="shrink-0">{formatPrice(item.unitPrice * item.quantity, item.currency || order.currency)}</span>
          </li>
        ))}
      </ul>
      {(Boolean(order.discountTotal) || typeof order.shippingTotal === "number") && (
        <dl className="sf-acc-muted mt-3 space-y-1 text-sm">
          {typeof order.subtotal === "number" && (
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{formatPrice(order.subtotal, order.currency)}</dd></div>
          )}
          {Boolean(order.discountTotal) && (
            <div className="flex justify-between font-medium"><dt>Discount{order.discountCode ? ` (${order.discountCode})` : ""}</dt><dd>−{formatPrice(order.discountTotal as number, order.currency)}</dd></div>
          )}
          {typeof order.shippingTotal === "number" && (
            <div className="flex justify-between"><dt>Shipping</dt><dd>{order.shippingTotal === 0 ? "Free" : formatPrice(order.shippingTotal, order.currency)}</dd></div>
          )}
          {Number(order.taxTotal ?? 0) > 0 && (
            <div className="flex justify-between"><dt>{order.taxInclusive ? `Includes ${order.taxLabel}` : order.taxLabel}</dt><dd>{formatPrice(Number(order.taxTotal), order.currency)}</dd></div>
          )}
        </dl>
      )}
      <p className="mt-3 flex justify-between font-semibold">
        <span>Total</span>
        <span>{formatPrice(order.total, order.currency)}</span>
      </p>
      {Number(order.refundedTotal ?? 0) > 0 && (
        <p className="mt-1 flex justify-between text-sm">
          <span>Refunded</span>
          <span>−{formatPrice(Number(order.refundedTotal), order.currency)}</span>
        </p>
      )}
      {order.paymentAttemptFailed && (
        <p role="status" className="sf-acc-error mt-3 text-sm font-medium">Your last payment attempt did not go through, and you have not been charged for it. You can try again.</p>
      )}
      {order.status === "cancelled" && (
        <p className="sf-acc-muted mt-3 text-sm">
          {order.cancelReason === "expired" ? "This order was released because it was not paid or confirmed in time." : order.cancelReason === "customer" ? "You cancelled this order." : "The store cancelled this order."} Nothing is owed on it.
        </p>
      )}
      {order.status !== "cancelled" && order.fulfillmentStatus && order.fulfillmentStatus !== "unfulfilled" && (
        <section aria-labelledby="order-delivery" className="sf-acc-rule sf-acc-control mt-5 border p-4">
          <h2 id="order-delivery" className="text-sm font-semibold">Delivery</h2>
          <ol className="mt-3 flex flex-wrap gap-2 text-xs">
            {FULFILLMENT_STEPS.map((step, index) => {
              const reached = FULFILLMENT_STEPS.findIndex((s) => s.key === order.fulfillmentStatus) >= index;
              return (
                <li key={step.key} aria-current={order.fulfillmentStatus === step.key ? "step" : undefined} className={`rounded-full px-3 py-1 font-semibold ${reached ? "sf-acc-action" : "bg-slate-100 text-slate-600"}`}>
                  {step.label}
                </li>
              );
            })}
          </ol>
          {(order.shippedAt || order.deliveredAt) && (
            <p className="sf-acc-muted mt-3 text-sm">
              {order.shippedAt && <>Shipped {new Date(order.shippedAt).toLocaleDateString([], { dateStyle: "medium" })}. </>}
              {order.deliveredAt && <>Delivered {new Date(order.deliveredAt).toLocaleDateString([], { dateStyle: "medium" })}.</>}
            </p>
          )}
          {order.fulfillmentStatus !== "delivered" && !order.tracking && (
            <p className="sf-acc-muted mt-3 text-sm">The store adds tracking details here if it has them.</p>
          )}
          {order.tracking && (
            <p className="sf-acc-muted mt-3 text-sm">
              {order.tracking.carrier && <>Carrier: <strong>{order.tracking.carrier}</strong>. </>}
              {order.tracking.number && <>Tracking number: <strong>{order.tracking.number}</strong>. </>}
              {order.tracking.url && (
                <a href={order.tracking.url} target="_blank" rel="noopener noreferrer nofollow" className="font-semibold underline">
                  Track your parcel<span className="sr-only"> (opens the carrier&apos;s site in a new tab)</span>
                </a>
              )}
            </p>
          )}
        </section>
      )}
      {order.status === "paid" && <ReviewPanel orderId={order.orderId} />}
      {error && <p role="alert" className="sf-acc-error mt-4 text-sm">{error}</p>}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/" className="sf-acc-action sf-acc-control sf-acc-focus px-5 py-2.5 font-semibold focus-visible:outline-none">
          Continue shopping
        </Link>
        {order.paymentMethod === "online" && order.status === "pending" && order.canCancel && (
          <button type="button" onClick={() => void payNow()} disabled={paying} className="sf-acc-secondary sf-acc-control sf-acc-focus px-5 py-2.5 font-semibold focus-visible:outline-none disabled:opacity-60">
            {paying ? "Opening payment…" : "Pay now"}
          </button>
        )}
        {order.canCancel && (
          <button type="button" onClick={() => void cancel()} disabled={cancelling} className="sf-acc-danger sf-acc-control border px-5 py-2.5 font-medium disabled:opacity-60">
            {cancelling ? "Cancelling…" : "Cancel order"}
          </button>
        )}
      </div>
    </div>
  );
}
