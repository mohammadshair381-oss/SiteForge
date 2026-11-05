import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCustomerPage } from "@/lib/auth/customer-page";
import { formatPrice } from "@/lib/format";
import { getCustomerOrder } from "@/lib/orders/customer-orders";
import AccountShell from "@/components/storefront/account/AccountShell";
import CancelOrderButton from "@/components/storefront/account/CancelOrderButton";
import { OrderStatusChip, orderDate } from "@/components/storefront/account/OrderSummary";
import { ConfirmHost } from "@/components/ui/ConfirmDialog";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Order details" } };

const STEPS = [
  { key: "unfulfilled", label: "Order placed" },
  { key: "processing", label: "Being prepared" },
  { key: "shipped", label: "Shipped" },
  { key: "delivered", label: "Delivered" },
] as const;

const PAYMENT_TEXT = { cod: "Cash on delivery", online: "Online payment" } as const;

/**
 * One order of the signed-in customer. Another customer's or another store's
 * order is the same 404 as a missing one (`getCustomerOrder`).
 */
export default async function CustomerOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const { business, customer } = await requireCustomerPage(`/account/orders/${encodeURIComponent(orderId)}`);
  const order = await getCustomerOrder(business._id, customer.id, orderId);
  if (!order) notFound();

  const inProgress = order.status === "pending" || order.status === "paid";
  const stepIndex = STEPS.findIndex((step) => step.key === order.fulfillmentStatus);
  const price = (value: number) => formatPrice(value, order.currency);
  const address = order.shippingAddress;
  const heading = "sf-acc-title font-display text-lg";
  const paymentNote =
    order.status === "paid"
      ? order.paymentMethod === "cod"
        ? "Cash received by the store."
        : "Your payment is confirmed."
      : order.status === "pending"
        ? order.paymentMethod === "cod"
          ? `Please have ${price(order.total)} ready when your order arrives.`
          : order.paymentMethod === "online"
            ? "We are waiting for your payment to be confirmed."
            : "The store will contact you to arrange payment."
        : order.status === "refunded"
          ? "This order was refunded."
          : "Nothing is owed on this order.";

  return (
    <AccountShell
      themeId={business.themeId}
      customerName={customer.name}
      active="orders"
      title={`Order #${order.orderNumber}`}
      intro={<>Placed {orderDate(order.createdAt)}</>}
    >
      <ConfirmHost inline />
      <p className="mb-4">
        <Link href="/account/orders" className="sf-acc-focus inline-flex min-h-10 items-center rounded text-sm font-medium underline underline-offset-4 focus-visible:outline-none">
          <span aria-hidden="true" className="mr-1">←</span>All orders
        </Link>
      </p>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {inProgress && (
            <section aria-label="Delivery progress" className="sf-acc-card p-5 sm:p-6">
              <ol className="grid gap-3 sm:grid-cols-4">
                {STEPS.map((step, index) => {
                  const done = index <= stepIndex;
                  return (
                    <li key={step.key} aria-current={index === stepIndex ? "step" : undefined} className="flex items-center gap-2 sm:flex-col sm:items-start">
                      <span aria-hidden="true" className="block h-2 w-8 shrink-0 rounded-full sm:w-full" style={done ? { background: "var(--sf-accent)" } : { background: "var(--acc-line)", opacity: 0.35 }} />
                      <span className={`text-sm ${done ? "font-semibold" : "sf-acc-muted"}`}>{step.label}</span>
                    </li>
                  );
                })}
              </ol>
              {order.fulfillmentStatus === "shipped" && !order.trackingNumber && !order.trackingUrl && (
                <p className="sf-acc-muted sf-acc-rule mt-4 border-t pt-4 text-sm">Your order is on its way. The store did not add tracking details.</p>
              )}
              {(order.trackingNumber || order.trackingUrl) && (
                <p className="sf-acc-rule mt-4 break-words border-t pt-4 text-sm">
                  {order.trackingCarrier && <>{order.trackingCarrier} </>}
                  {order.trackingNumber && <span className="font-medium">{order.trackingNumber}</span>}
                  {order.trackingUrl && (
                    <>
                      {" "}
                      <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer" className="sf-acc-focus rounded font-medium underline underline-offset-4 focus-visible:outline-none">
                        Track this delivery<span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </>
                  )}
                </p>
              )}
            </section>
          )}

          <section aria-labelledby="order-items" className="sf-acc-card p-5 sm:p-6">
            <h2 id="order-items" className={heading}>Items</h2>
            <ul className="sf-acc-rule mt-3 sf-acc-divide divide-y border-t text-sm">
              {order.items.map((item, index) => (
                <li key={index} className="flex items-center justify-between gap-4 py-3">
                  {item.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" loading="lazy" className="sf-acc-control h-14 w-14 shrink-0 object-cover" />
                  )}
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-medium">{item.productName}</span>
                    {item.variantLabel && <span className="sf-acc-muted block text-xs">{item.variantLabel}</span>}
                    <span className="sf-acc-muted block text-xs">{item.quantity} × {price(item.unitPrice)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{price(item.unitPrice * item.quantity)}</span>
                </li>
              ))}
            </ul>
            <dl className="sf-acc-rule space-y-2 border-t pt-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="sf-acc-muted">Subtotal</dt>
                <dd className="tabular-nums">{price(order.subtotal)}</dd>
              </div>
              {order.discountTotal > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="sf-acc-muted">Discount{order.discountCode ? ` (${order.discountCode})` : ""}</dt>
                  <dd className="tabular-nums">−{price(order.discountTotal)}</dd>
                </div>
              )}
              {order.shippingTotal > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="sf-acc-muted">Shipping</dt>
                  <dd className="tabular-nums">{price(order.shippingTotal)}</dd>
                </div>
              )}
              {order.shippingTotal === 0 && address && (
                <div className="flex justify-between gap-4">
                  <dt className="sf-acc-muted">Shipping</dt>
                  <dd>Free</dd>
                </div>
              )}
              {order.taxTotal > 0 && (
                <div className="flex justify-between gap-3">
                  <dt>{order.taxInclusive ? `Includes ${order.taxLabel}` : order.taxLabel}</dt>
                  <dd className="tabular-nums">{price(order.taxTotal)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-4 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{price(order.total)}</dd>
              </div>
              {order.refundedTotal > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="sf-acc-muted">Refunded</dt>
                  <dd className="tabular-nums">−{price(order.refundedTotal)}</dd>
                </div>
              )}
            </dl>
          </section>
        </div>

        <div className="space-y-4">
          <section aria-labelledby="order-status" className="sf-acc-card p-5 sm:p-6">
            <h2 id="order-status" className={heading}>Status</h2>
            <p className="mt-3"><OrderStatusChip status={order.status} /></p>
            <p className="sf-acc-muted mt-2 text-sm">{paymentNote}</p>
            <dl className="mt-3 space-y-2 text-sm">
              {order.paymentMethod && (
                <div>
                  <dt className="sf-acc-muted text-xs">Payment</dt>
                  <dd>{PAYMENT_TEXT[order.paymentMethod]}</dd>
                </div>
              )}
              {order.paidAt && (
                <div>
                  <dt className="sf-acc-muted text-xs">Paid</dt>
                  <dd>{orderDate(order.paidAt)}</dd>
                </div>
              )}
              {order.shippedAt && (
                <div>
                  <dt className="sf-acc-muted text-xs">Shipped</dt>
                  <dd>{orderDate(order.shippedAt)}</dd>
                </div>
              )}
              {order.deliveredAt && (
                <div>
                  <dt className="sf-acc-muted text-xs">Delivered</dt>
                  <dd>{orderDate(order.deliveredAt)}</dd>
                </div>
              )}
              {order.cancelledAt && (
                <div>
                  <dt className="sf-acc-muted text-xs">Cancelled</dt>
                  <dd>{orderDate(order.cancelledAt)}</dd>
                </div>
              )}
              {order.refundedAt && (
                <div>
                  <dt className="sf-acc-muted text-xs">Refunded</dt>
                  <dd>{orderDate(order.refundedAt)}</dd>
                </div>
              )}
            </dl>
            {order.canCancel && (
              <div className="sf-acc-rule mt-4 border-t pt-4">
                <CancelOrderButton orderId={order.orderId} orderNumber={order.orderNumber} />
              </div>
            )}
          </section>

          {business.contactEmail && (
            <section aria-labelledby="order-help" className="sf-acc-card p-5 sm:p-6">
              <h2 id="order-help" className={heading}>Questions about this order?</h2>
              <p className="sf-acc-muted mt-2 text-sm leading-6">
                Contact the store at{" "}
                <a href={`mailto:${business.contactEmail}`} className="sf-acc-focus break-all rounded font-medium underline underline-offset-4 focus-visible:outline-none">{business.contactEmail}</a>
                {" "}and mention order #{order.orderNumber}.
              </p>
            </section>
          )}

          {address && address.line1 && (
            <section aria-labelledby="order-address" className="sf-acc-card p-5 sm:p-6">
              <h2 id="order-address" className={heading}>Delivery address</h2>
              <address className="sf-acc-muted mt-3 break-words text-sm not-italic leading-6">
                {address.name && <span className="block">{address.name}</span>}
                <span className="block">{address.line1}</span>
                {address.line2 && <span className="block">{address.line2}</span>}
                <span className="block">{[address.city, address.region, address.postalCode].filter(Boolean).join(", ")}</span>
                {address.country && <span className="block">{address.country}</span>}
                {address.phone && <span className="block">{address.phone}</span>}
              </address>
            </section>
          )}
        </div>
      </div>
    </AccountShell>
  );
}
