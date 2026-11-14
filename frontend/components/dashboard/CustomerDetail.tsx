"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { formatCustomerTotals, type CustomerSummaryView } from "./CustomersManager";
import { formatPrice } from "@/lib/format";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, Notice, Pill, Skeleton, type Tone } from "@/components/ui/Surface";

type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";

interface CustomerOrder {
  id: string;
  orderNumber: string;
  createdAt: string;
  status: OrderStatus;
  cancelReason: string | null;
  items: Array<{ productName: string; quantity: number }>;
  total: number;
  currency: string;
}

const STATUS_STYLES: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting payment", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "info" },
};

function itemSummary(items: CustomerOrder["items"]): string {
  if (items.length === 0) return "No items";
  const shown = items.slice(0, 3).map((item) => `${item.quantity} × ${item.productName}`);
  return items.length > 3 ? `${shown.join(", ")} and ${items.length - 3} more` : shown.join(", ");
}

export default function CustomerDetail({
  businessId,
  customerId,
}: {
  businessId: string;
  customerId: string;
}) {
  const [customer, setCustomer] = useState<CustomerSummaryView | null>(null);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setNotFound(false);
    try {
      const res = await fetch(`/api/businesses/${businessId}/manage/customers/${encodeURIComponent(customerId)}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Unable to load this customer");
      setCustomer(data.customer);
      setOrders(data.orders ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to load this customer");
    } finally {
      setLoading(false);
    }
  }, [businessId, customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const backLink = (
    <ButtonLink href={`/dashboard/businesses/${businessId}/customers`} variant="secondary">
      <Icon name="arrow-left" size={16} />
      All customers
    </ButtonLink>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <p role="status" className="sr-only">Loading customer…</p>
        <div aria-hidden="true" className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div aria-hidden="true" className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28 !rounded-2xl" />
          <Skeleton className="h-28 !rounded-2xl" />
          <Skeleton className="h-28 !rounded-2xl" />
        </div>
        <Skeleton className="h-64 !rounded-2xl" />
      </div>
    );
  }
  if (notFound) {
    return (
      <div className="space-y-4">
        {backLink}
        <Card className="px-6 py-12 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Customer not found</h1>
          <p className="mt-2 text-sm text-slate-600">This customer does not exist in this business.</p>
        </Card>
      </div>
    );
  }
  if (loadError || !customer) {
    return (
      <div className="space-y-4">
        {backLink}
        <Notice tone="danger" role="alert" title="This customer could not be loaded" action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>}>
          {loadError ?? "Unable to load this customer"}
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title={customer.name || "Unnamed customer"}
        description={customer.email}
        actions={backLink}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="min-w-0 p-5">
          <p className="text-xs font-medium text-slate-500">Orders</p>
          <p className="mt-2 font-heading text-2xl font-semibold tracking-tight text-slate-900">{customer.orderCount}</p>
          <p className="mt-1 text-xs text-slate-500">{customer.paidOrderCount} paid</p>
        </Card>
        <Card className="min-w-0 p-5">
          <p className="text-xs font-medium text-slate-500">Total</p>
          {formatCustomerTotals(customer.totals).map((line) => (
            <p key={line} className="mt-2 text-sm font-semibold text-slate-900">{line}</p>
          ))}
          <p className="mt-1 text-xs text-slate-500">Cancelled and refunded orders are not counted.</p>
        </Card>
        <Card className="min-w-0 p-5">
          <p className="text-xs font-medium text-slate-500">Customer since</p>
          <p className="mt-2 text-sm font-semibold text-slate-900">{new Date(customer.firstOrderAt).toLocaleDateString()}</p>
          <p className="mt-1 text-xs text-slate-500">Last order {new Date(customer.lastOrderAt).toLocaleDateString()}</p>
        </Card>
      </div>

      <Card as="section" aria-labelledby="order-history">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-6">
          <h2 id="order-history" className="text-lg font-semibold text-slate-900">Order history</h2>
          {orders.length < customer.orderCount && (
            <p className="mt-1 text-xs text-slate-500">
              Showing the newest {orders.length} of {customer.orderCount} orders. Older orders are under Orders.
            </p>
          )}
        </div>
        {orders.length === 0 ? (
          <p className="px-4 py-8 text-sm text-slate-500 sm:px-6">No orders.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {orders.map((order) => {
              const style = STATUS_STYLES[order.status] ?? STATUS_STYLES.pending;
              return (
                <li key={order.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-6">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                      Order #{order.orderNumber}
                      <Pill tone={style.tone} dot>{style.label}</Pill>
                    </p>
                    <p className="mt-1 text-sm text-slate-600">{itemSummary(order.items)}</p>
                    <p className="mt-1 text-xs text-slate-500">{new Date(order.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 sm:block sm:text-right">
                    <p className="font-semibold tabular-nums text-slate-900">{formatPrice(order.total, order.currency || "USD")}</p>
                    <Link
                      href={`/dashboard/businesses/${businessId}/orders?order=${encodeURIComponent(order.orderNumber)}`}
                      className="mt-1 inline-flex min-h-10 items-center rounded text-sm font-semibold text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                    >
                      Manage order
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
