import React from "react";
import Link from "next/link";
import { formatPrice } from "@/lib/format";
import type { CustomerOrderView } from "@/lib/orders/customer-orders";
import CancelOrderButton from "./CancelOrderButton";

const STATUS_TEXT = {
  pending: "Pending",
  paid: "Paid",
  cancelled: "Cancelled",
  refunded: "Refunded",
} as const;

const STATUS_CLASS = {
  pending: "bg-amber-50 text-amber-900",
  paid: "bg-emerald-50 text-emerald-800",
  cancelled: "bg-slate-100 text-slate-700",
  refunded: "bg-sky-50 text-sky-800",
} as const;

export function orderDate(value: string, withTime = true): string {
  return new Date(value).toLocaleString("en-US", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

export function OrderStatusChip({ status }: { status: CustomerOrderView["status"] }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[status] ?? "bg-slate-100 text-slate-700"}`}>
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

const DELIVERY_TEXT = { unfulfilled: "", processing: "Being prepared", shipped: "Shipped", delivered: "Delivered" } as const;

/** One order in a list, linking to its full details. */
export function OrderSummaryCard({ order }: { order: CustomerOrderView }) {
  const itemCount = order.items.reduce((total, item) => total + item.quantity, 0);
  return (
    <article className="sf-acc-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="sf-acc-title min-w-0 break-words text-base sm:text-lg">
          <Link href={`/account/orders/${order.orderId}`} className="sf-acc-focus rounded underline-offset-4 hover:underline focus-visible:outline-none">
            Order #{order.orderNumber}
          </Link>
        </h2>
        <p className="sf-acc-muted flex flex-wrap items-center gap-2 text-sm">
          {order.paymentMethod === "cod" && <span>Cash on delivery</span>}
          {order.paymentMethod === "online" && <span>Paid online</span>}
          {order.status !== "cancelled" && order.status !== "refunded" && DELIVERY_TEXT[order.fulfillmentStatus] && <span className="font-medium">{DELIVERY_TEXT[order.fulfillmentStatus]}</span>}
          <OrderStatusChip status={order.status} />
        </p>
      </div>
      <p className="sf-acc-muted mt-1 text-xs">Placed {orderDate(order.createdAt)}</p>
      <ul className="sf-acc-rule mt-4 sf-acc-divide divide-y border-y text-sm">
        {order.items.slice(0, 3).map((item, index) => (
          <li key={index} className="flex justify-between gap-4 py-2.5">
            <span className="min-w-0 break-words">
              {item.quantity} × {item.productName}
              {item.variantLabel && <span className="sf-acc-muted block text-xs">{item.variantLabel}</span>}
            </span>
            <span className="shrink-0 tabular-nums">{formatPrice(item.unitPrice * item.quantity, order.currency)}</span>
          </li>
        ))}
        {order.items.length > 3 && <li className="sf-acc-muted py-2.5 text-xs">and {order.items.length - 3} more</li>}
      </ul>
      <p className="mt-3 flex justify-between gap-4 font-semibold">
        <span>Total ({itemCount} {itemCount === 1 ? "item" : "items"})</span>
        <span className="tabular-nums">{formatPrice(order.total, order.currency)}</span>
      </p>
      {order.refundedTotal > 0 && order.status !== "cancelled" && (
        <p className="sf-acc-muted mt-1 flex justify-between gap-4 text-sm">
          <span>Refunded</span>
          <span className="tabular-nums">−{formatPrice(order.refundedTotal, order.currency)}</span>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Link href={`/account/orders/${order.orderId}`} className="sf-acc-secondary sf-acc-control sf-acc-focus inline-flex min-h-10 items-center justify-center px-4 py-2 text-sm font-semibold focus-visible:outline-none">
          View details
        </Link>
        {order.canCancel && <CancelOrderButton orderId={order.orderId} orderNumber={order.orderNumber} />}
      </div>
    </article>
  );
}
