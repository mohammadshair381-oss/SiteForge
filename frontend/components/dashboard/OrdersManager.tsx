"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ManagementPageHeader from "./ManagementPageHeader";
import OrderDetailPanel from "./OrderDetailPanel";
import { useToastHelpers } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/format";
import { Button, buttonClass } from "@/components/ui/Button";
import { confirmDialog, type ConfirmOptions } from "@/components/ui/ConfirmDialog";
import { inputClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Card, EmptyState, Notice, Pill, Skeleton, type Tone } from "@/components/ui/Surface";

type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";
type OrderAction = "mark_paid" | "cancel";

interface ManagedOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  items: Array<{ productName: string; variantLabel?: string; sku?: string; quantity: number; unitPrice: number; currency: string }>;
  total: number;
  currency: string;
  status: OrderStatus;
  cancelReason: string | null;
  reservationExpiresAt: string | null;
  paymentMethod: "online" | "cod" | null;
  /** Older API responses may not include it. */
  placedBy?: "registered" | "guest";
  paymentNeedsReview?: boolean;
  dispute?: { status: string; respondBy: string | null } | null;
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  subtotal?: number;
  discount?: { code: string; amount: number } | null;
  shippingTotal?: number | null;
  shippingAddress?: { name: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string; phone?: string } | null;
  fulfillmentStatus?: Fulfillment;
  trackingCarrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  testPayment?: boolean;
  paymentFailed?: boolean;
  refundedTotal?: number;
  refundPendingTotal?: number;
  taxTotal?: number;
  taxLabel?: string;
  taxInclusive?: boolean;
  shippingZoneName?: string;
}

const PAGE_SIZE = 25;
const PAYMENT_FILTERS = [
  { value: "", label: "Any payment" },
  { value: "awaiting", label: "Awaiting payment" },
  { value: "failed", label: "Failed or expired" },
  { value: "paid", label: "Paid" },
  { value: "refunded", label: "Refunded, in part or in full" },
  { value: "cod", label: "Cash on delivery" },
  { value: "online", label: "Paid or paying online" },
];
const FULFILMENT_FILTERS = [
  { value: "", label: "Any delivery status" },
  { value: "unfulfilled", label: "Paid, not started" },
  { value: "processing", label: "Preparing" },
  { value: "shipped", label: "Shipped" },
  { value: "delivered", label: "Delivered" },
];

type Fulfillment = "unfulfilled" | "processing" | "shipped" | "delivered";
const FULFILLMENT_LABELS: Record<Fulfillment, string> = {
  unfulfilled: "Not started",
  processing: "Preparing",
  shipped: "Shipped",
  delivered: "Delivered",
};
const FULFILLMENT_ORDER: Fulfillment[] = ["unfulfilled", "processing", "shipped", "delivered"];

/**
 * Fulfilment and tracking for one order (forward only; the server enforces
 * the rules). Tracking is the business's own carrier reference.
 */
function FulfillmentControl({ businessId, order, onSaved }: { businessId: string; order: ManagedOrder; onSaved: (order: ManagedOrder) => void }) {
  const current = order.fulfillmentStatus ?? "unfulfilled";
  const [status, setStatus] = useState<Fulfillment>(current);
  const [carrier, setCarrier] = useState(order.trackingCarrier ?? "");
  const [number, setNumber] = useState(order.trackingNumber ?? "");
  const [url, setUrl] = useState(order.trackingUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = `mt-1 ${inputClass}`;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/manage/orders/${order.id}/fulfillment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, trackingCarrier: carrier, trackingNumber: number, trackingUrl: url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Could not update fulfilment.");
        return;
      }
      onSaved(data.order);
    } catch {
      setError("Could not reach the server. Nothing was changed. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-[10rem_1fr_1fr_1.4fr_auto] xl:items-end">
      <label className="block text-xs font-medium text-slate-700">
        Fulfilment
        <select value={status} onChange={(e) => setStatus(e.target.value as Fulfillment)} className={field}>
          {FULFILLMENT_ORDER.filter((f) => FULFILLMENT_ORDER.indexOf(f) >= FULFILLMENT_ORDER.indexOf(current)).map((f) => (
            <option key={f} value={f}>{FULFILLMENT_LABELS[f]}</option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium text-slate-700">Carrier<input value={carrier} maxLength={80} onChange={(e) => setCarrier(e.target.value)} className={field} /></label>
      <label className="block text-xs font-medium text-slate-700">Tracking number<input value={number} maxLength={120} onChange={(e) => setNumber(e.target.value)} className={field} /></label>
      <label className="block text-xs font-medium text-slate-700">Tracking link (https)<input type="url" value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://" className={field} /></label>
      <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Update"}</Button>
      {error && <p role="alert" className="text-xs font-medium text-red-700 sm:col-span-2 xl:col-span-5">{error}</p>}
    </form>
  );
}

const FILTERS: Array<{ value: "" | OrderStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "pending", label: "Awaiting payment" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
];

const STATUS_STYLES: Record<OrderStatus, { label: string; tone: Tone }> = {
  pending: { label: "Awaiting payment", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "info" },
};

const CANCEL_REASON_LABELS: Record<string, string> = {
  customer: "by the customer",
  admin: "by your team",
  expired: "reservation expired",
  payment_failed: "payment failed",
};

const ACTION_CONFIRM: Record<OrderAction, ConfirmOptions> = {
  mark_paid: {
    title: "Mark this order as paid?",
    message: "This is a cash-on-delivery order. Only do this once you have actually received the cash.",
    confirmLabel: "Yes, I received the cash",
    cancelLabel: "Not yet",
  },
  cancel: {
    title: "Cancel this order?",
    message: "Its items go back into stock.",
    confirmLabel: "Cancel order",
    cancelLabel: "Keep order",
    tone: "danger",
  },
};

const quietDangerClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

const segmentClass = (selected: boolean) =>
  `inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
    selected ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
  }`;

function minutesLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60000));
}

function timeLeftText(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} hours`;
  return `${Math.round(minutes / (24 * 60))} days`;
}

/** Payment state in one unmistakable phrase. Display only: it never decides what an order can do. */
function paymentState(order: ManagedOrder): { label: string; tone: Tone; note: string | null } {
  if (order.status === "paid") {
    if (Number(order.refundedTotal ?? 0) > 0) return { label: "Partly refunded", tone: "info", note: `${formatPrice(Number(order.refundedTotal), order.currency || "USD")} refunded.` };
    if (order.paymentMethod === "online") return { label: "Paid online", tone: "success", note: order.testPayment ? "Test mode: no real money moved." : "Confirmed by Razorpay." };
    if (order.paymentMethod === "cod") return { label: "Paid: cash on delivery", tone: "success", note: "Marked paid by your team after receiving the cash." };
    return { label: "Paid", tone: "success", note: null };
  }
  if (order.status === "pending") {
    if (order.paymentMethod === "online") return { label: "Pending: online payment", tone: "warning", note: null };
    if (order.paymentMethod === "cod") return { label: "Pending: cash on delivery", tone: "warning", note: null };
    return { label: "Pending: no payment method", tone: "warning", note: null };
  }
  return { ...STATUS_STYLES[order.status], note: null };
}

/** The one thing to do next, in plain words. Display only. */
function nextStep(order: ManagedOrder): { lead: string; text: string } {
  const fulfilment = order.fulfillmentStatus ?? "unfulfilled";
  if (order.status === "pending") {
    if (order.paymentMethod === "cod") {
      // A guest's details are unverified, and their stock hold ends unless it is confirmed.
      if (order.placedBy !== "registered" && fulfilment === "unfulfilled") {
        return { lead: "Next step", text: "Confirm this guest's order by phone, then start preparing it. That also stops its stock hold from running out." };
      }
      return { lead: "Next step", text: "Deliver the order and collect the cash, then mark it paid." };
    }
    return {
      lead: "Waiting",
      text:
        order.paymentMethod === "online"
          ? "Awaiting online payment. It is confirmed by the payment provider."
          : "No payment method recorded. This order cannot be marked paid manually.",
    };
  }
  if (order.status === "paid") {
    if (fulfilment === "unfulfilled") return { lead: "Next step", text: "Start preparing this order." };
    if (fulfilment === "processing") return { lead: "Next step", text: "Ship this order and add the tracking details." };
    if (fulfilment === "shipped") return { lead: "Next step", text: "Mark it delivered once it has arrived." };
    return { lead: "Done", text: "Paid and delivered. Nothing more to do." };
  }
  if (order.status === "refunded") return { lead: "Closed", text: "A refund is recorded for this order. Stock is not restored automatically." };
  return { lead: "Closed", text: "This order was cancelled. Nothing more to do." };
}

export default function OrdersManager({
  businessId,
  initialOrderNumber = null,
  isOwner = false,
}: {
  businessId: string;
  /** Refunds through Razorpay are for owners. The server enforces the same rule. */
  isOwner?: boolean;
  /** Deep link (e.g. from a customer's order history) to a single order. */
  initialOrderNumber?: string | null;
}) {
  const { success, error: toastError } = useToastHelpers();
  const router = useRouter();
  const pathname = usePathname();
  const [filter, setFilter] = useState<"" | OrderStatus>("");
  const [orderNumber, setOrderNumber] = useState<string | null>(initialOrderNumber);
  const [orders, setOrders] = useState<ManagedOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fulfilmentOpenId, setFulfilmentOpenId] = useState<string | null>(null);
  const [detailOpenId, setDetailOpenId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [fulfilmentFilter, setFulfilmentFilter] = useState("");
  const [placedByFilter, setPlacedByFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Searching waits for a pause in typing.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const filterQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (filter) params.set("status", filter);
    if (orderNumber) params.set("order", orderNumber);
    if (search) params.set("q", search);
    if (paymentFilter) params.set("payment", paymentFilter);
    if (fulfilmentFilter) params.set("fulfillment", fulfilmentFilter);
    if (placedByFilter) params.set("placedBy", placedByFilter);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    return params;
  }, [filter, orderNumber, search, paymentFilter, fulfilmentFilter, placedByFilter, fromDate, toDate]);
  const hasFilters = Boolean(search || paymentFilter || fulfilmentFilter || filter || placedByFilter || fromDate || toDate);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = filterQuery();
      params.set("limit", String(PAGE_SIZE));
      const res = await fetch(`/api/businesses/${businessId}/manage/orders?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to load orders");
      setOrders(data.orders ?? []);
      setHasMore(Boolean(data.hasMore));
      setPage(1);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Unable to load orders");
    } finally {
      setLoading(false);
    }
  }, [businessId, filterQuery]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const params = filterQuery();
      params.set("limit", String(PAGE_SIZE));
      params.set("page", String(page + 1));
      const res = await fetch(`/api/businesses/${businessId}/manage/orders?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to load more orders");
      setOrders((current) => {
        const seen = new Set(current.map((order) => order.id));
        return [...current, ...(data.orders ?? []).filter((order: ManagedOrder) => !seen.has(order.id))];
      });
      setHasMore(Boolean(data.hasMore));
      setPage((value) => value + 1);
    } catch (err) {
      toastError("Could not load more", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(order: ManagedOrder, action: OrderAction) {
    if (busyId) return;
    if (!(await confirmDialog(ACTION_CONFIRM[action]))) return;
    setBusyId(order.id);
    try {
      const res = await fetch(`/api/businesses/${businessId}/manage/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Unable to update the order");
      setOrders((list) => list.map((o) => (o.id === order.id ? data.order : o)));
      success("Order updated", `Order #${order.orderNumber} is now ${STATUS_STYLES[data.order.status as OrderStatus].label.toLowerCase()}.`);
    } catch (err) {
      toastError("Order not updated", err instanceof Error ? err.message : "Please try again.");
      void load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Orders"
        description="Orders placed on your storefront. New orders reserve stock for 30 minutes while they await payment; unpaid orders are released automatically after that."
        actions={
          <a href={`/api/businesses/${businessId}/manage/orders/export?${filterQuery().toString()}`} className={buttonClass({ variant: "secondary" })}>
            Export CSV
          </a>
        }
      />

      <Notice tone="info">
        Online orders are marked paid automatically, and only after Razorpay confirms the payment, so
        they cannot be marked paid here.{" "}
        <strong>Mark paid</strong> is available only for cash-on-delivery orders.
      </Notice>

      {orderNumber && (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-slate-700">
            Showing order <strong>#{orderNumber}</strong> only.
          </span>
          <Button
            variant="secondary"
            onClick={() => {
              setOrderNumber(null);
              // Drop ?order= so refresh/back do not re-apply the filter.
              router.replace(pathname);
            }}
          >
            Show all orders
          </Button>
        </Card>
      )}

      <div className="ui-scroll-x flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg border bg-slate-100 p-0.5" role="tablist" aria-label="Filter orders">
        {FILTERS.map((f) => (
          <button
            key={f.value || "all"}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={segmentClass(filter === f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <label className="min-w-0">
          <span className="sr-only">Search orders</span>
          <input type="search" value={searchInput} maxLength={100} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search by order, customer, phone, product, option, SKU or tracking number" className={inputClass} />
        </label>
        <label>
          <span className="sr-only">Filter by payment</span>
          <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className={inputClass}>
            {PAYMENT_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Filter by delivery status</span>
          <select value={fulfilmentFilter} onChange={(e) => setFulfilmentFilter(e.target.value)} className={inputClass}>
            {FULFILMENT_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium text-slate-700">
          Placed by
          <select value={placedByFilter} onChange={(e) => setPlacedByFilter(e.target.value)} className={`mt-1 ${inputClass}`}>
            <option value="">Anyone</option>
            <option value="guest">Guests</option>
            <option value="registered">Registered customers</option>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          From
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} className={`mt-1 ${inputClass}`} />
        </label>
        <label className="text-xs font-medium text-slate-700">
          To
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} className={`mt-1 ${inputClass}`} />
        </label>
        {hasFilters && (
          <Button
            variant="ghost"
            onClick={() => {
              setFilter("");
              setSearchInput("");
              setPaymentFilter("");
              setFulfilmentFilter("");
              setPlacedByFilter("");
              setFromDate("");
              setToDate("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {loading ? (
        <Card>
          <p role="status" className="sr-only">Loading orders…</p>
          <ul aria-hidden="true" className="divide-y divide-slate-100">
            {Array.from({ length: 3 }, (_, index) => (
              <li key={index} className="space-y-3 px-4 py-5 sm:px-6">
                <div className="flex items-center justify-between gap-4">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-5 w-20" />
                </div>
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-14 !rounded-xl" />
              </li>
            ))}
          </ul>
        </Card>
      ) : loadError ? (
        <Notice
          tone="danger"
          role="alert"
          title="Orders could not be loaded"
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {loadError}
        </Notice>
      ) : orders.length === 0 ? (
        <EmptyState icon={<Icon name="orders" size={20} />} title={orderNumber ? "Order not found" : hasFilters ? "No orders match" : "No orders yet"}>
          {hasFilters ? "Try a different search or filter, or clear them to see every order." : "When customers check out on your published storefront, their orders appear here."}
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-slate-200">
            {orders.map((order) => {
              const payment = paymentState(order);
              const next = nextStep(order);
              const left = order.status === "pending" ? minutesLeft(order.reservationExpiresAt) : null;
              const busy = busyId === order.id;
              const canFulfil = (order.status === "paid" || (order.status === "pending" && order.paymentMethod === "cod")) && order.fulfillmentStatus !== "delivered";
              const fulfilmentOpen = fulfilmentOpenId === order.id;
              const toggleFulfilment = (
                <Button variant={order.status === "paid" ? "primary" : "secondary"} aria-expanded={fulfilmentOpen} onClick={() => setFulfilmentOpenId(fulfilmentOpen ? null : order.id)}>
                  Update fulfilment
                  <Icon name="chevron-down" size={16} className={fulfilmentOpen ? "rotate-180" : ""} />
                </Button>
              );
              return (
                <li key={order.id} className="px-4 py-5 sm:px-6">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 flex-1 basis-64">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-slate-900">Order #{order.orderNumber}</h2>
                        <Pill tone={payment.tone} dot>{payment.label}</Pill>
                        {order.testPayment && <Pill tone="info">Test payment</Pill>}
                        {order.paymentFailed && <Pill tone="warning">Payment failed or expired</Pill>}
                        {Number(order.refundPendingTotal ?? 0) > 0 && <Pill tone="warning">Refund in progress</Pill>}
                        {(order.status === "paid" || (order.status === "pending" && order.paymentMethod === "cod")) && (
                          <Pill tone={order.fulfillmentStatus === "delivered" ? "success" : "neutral"}>
                            {FULFILLMENT_LABELS[order.fulfillmentStatus ?? "unfulfilled"]}
                          </Pill>
                        )}
                      </div>
                      <p className="mt-1.5 break-words text-sm text-slate-700">
                        {order.customerName} <span className="break-all text-slate-500">· {order.customerEmail}</span>
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {order.placedBy === "registered" ? "Registered customer" : "Guest"}
                        {" · "}Placed {new Date(order.createdAt).toLocaleString()}
                        {order.status === "cancelled" && order.cancelReason
                          ? ` · cancelled ${CANCEL_REASON_LABELS[order.cancelReason] ?? ""}`
                          : ""}
                        {left !== null ? ` · stock held for ${timeLeftText(left)} more` : ""}
                        {order.status === "pending" && order.paymentMethod === "cod" && left === null
                          ? " · stock stays reserved until you mark it paid or cancel it"
                          : ""}
                      </p>
                    </div>
                    <div className="sm:text-right">
                      <p className="font-heading text-xl font-semibold tabular-nums text-slate-900">{formatPrice(order.total, order.currency || "USD")}</p>
                      {payment.note && <p className="mt-0.5 text-xs text-slate-500">{payment.note}</p>}
                    </div>
                  </div>

                  {order.dispute && (
                    <p
                      className={`mt-3 rounded-lg border px-3 py-2 text-xs font-medium ${
                        order.dispute.status === "open" || order.dispute.status === "under_review"
                          ? "border-red-200 bg-red-50 text-red-800"
                          : "border-slate-200 bg-slate-100 text-slate-700"
                      }`}
                      role="note"
                    >
                      Payment dispute reported by Razorpay: {order.dispute.status.replace("_", " ")}
                      {order.dispute.respondBy && (order.dispute.status === "open" || order.dispute.status === "under_review")
                        ? ` · respond in your Razorpay dashboard by ${new Date(order.dispute.respondBy).toLocaleString()}`
                        : ""}
                    </p>
                  )}
                  {order.paymentNeedsReview && (
                    <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800" role="note">
                      Razorpay confirmed a payment for this order after it could no longer be marked paid (for example,
                      its reservation had ended). Check your Razorpay dashboard and refund the customer or fulfil the
                      order manually.
                    </p>
                  )}

                  <div className="mt-3 grid gap-x-8 gap-y-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                    <div className="min-w-0">
                      <ul className="space-y-1 text-sm text-slate-700">
                        {order.items.map((item, index) => (
                          <li key={index} className="flex justify-between gap-3">
                            <span className="min-w-0 break-words">
                              {item.quantity} × {item.productName}
                              {item.variantLabel ? <span className="text-slate-500"> ({item.variantLabel})</span> : null}
                              {item.sku ? <span className="text-xs text-slate-500"> · {item.sku}</span> : null}
                            </span>
                            <span className="shrink-0 tabular-nums text-slate-500">{formatPrice(item.unitPrice * item.quantity, item.currency || order.currency || "USD")}</span>
                          </li>
                        ))}
                      </ul>
                      {(order.discount || typeof order.shippingTotal === "number") && (
                        <p className="mt-2 text-xs text-slate-500">
                          Subtotal {formatPrice(order.subtotal ?? order.total, order.currency || "USD")}
                          {order.discount ? ` · code ${order.discount.code} −${formatPrice(order.discount.amount, order.currency || "USD")}` : ""}
                          {typeof order.shippingTotal === "number" ? ` · shipping ${order.shippingTotal === 0 ? "free" : formatPrice(order.shippingTotal, order.currency || "USD")}${order.shippingZoneName ? ` (${order.shippingZoneName})` : ""}` : ""}
                          {Number(order.taxTotal ?? 0) > 0 ? ` · ${order.taxInclusive ? "includes " : ""}${order.taxLabel} ${formatPrice(Number(order.taxTotal), order.currency || "USD")}` : ""}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      {order.shippingAddress && (
                        <address className="break-words text-xs not-italic leading-5 text-slate-600">
                          <span className="font-medium text-slate-700">Ship to: </span>
                          {[order.shippingAddress.name, order.shippingAddress.line1, order.shippingAddress.line2, order.shippingAddress.city, order.shippingAddress.region, order.shippingAddress.postalCode, order.shippingAddress.country].filter(Boolean).join(", ")}
                          {order.shippingAddress.phone ? ` · ${order.shippingAddress.phone}` : ""}
                        </address>
                      )}
                      {order.fulfillmentStatus && order.fulfillmentStatus !== "unfulfilled" && (
                        <p className="text-xs font-medium text-slate-700">
                          Fulfilment: {FULFILLMENT_LABELS[order.fulfillmentStatus]}
                          {order.trackingNumber ? ` · ${order.trackingCarrier ? `${order.trackingCarrier} ` : ""}${order.trackingNumber}` : ""}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="min-w-0 flex-1 basis-56 text-sm text-slate-700">
                        <span className="font-semibold text-slate-900">{next.lead}: </span>
                        {next.text}
                      </p>
                      {(order.status === "pending" || order.status === "paid") && (
                        <div className="flex flex-wrap items-center gap-2">
                          {order.status === "pending" && (
                            <>
                              {order.paymentMethod === "cod" && (
                                <Button disabled={busy || left === 0} onClick={() => void runAction(order, "mark_paid")}>
                                  {busy ? "Updating…" : "Mark paid (cash on delivery)"}
                                </Button>
                              )}
                              {canFulfil && toggleFulfilment}
                              <button type="button" disabled={busy} onClick={() => void runAction(order, "cancel")} className={quietDangerClass}>
                                Cancel order
                              </button>
                            </>
                          )}
                          {order.status === "paid" && (
                            <>
                              {canFulfil && toggleFulfilment}
                            </>
                          )}
                        </div>
                      )}
                      <Button variant="ghost" aria-expanded={detailOpenId === order.id} onClick={() => setDetailOpenId(detailOpenId === order.id ? null : order.id)}>
                        {order.status === "paid" ? "History, payments and refunds" : "History, payments and notes"}
                        <Icon name="chevron-down" size={16} className={detailOpenId === order.id ? "rotate-180" : ""} />
                      </Button>
                    </div>
                    {detailOpenId === order.id && (
                      <OrderDetailPanel
                        businessId={businessId}
                        orderId={order.id}
                        isOwner={isOwner}
                        onOrderChanged={(updated) => setOrders((list) => list.map((o) => (o.id === updated.id ? (updated as unknown as ManagedOrder) : o)))}
                      />
                    )}
                    {canFulfil && fulfilmentOpen && (
                      <FulfillmentControl
                        businessId={businessId}
                        order={order}
                        onSaved={(updated) => {
                          setOrders((list) => list.map((o) => (o.id === updated.id ? updated : o)));
                          setFulfilmentOpenId(null);
                          success("Fulfilment updated", `Order #${order.orderNumber}: ${FULFILLMENT_LABELS[updated.fulfillmentStatus ?? "unfulfilled"]}.`);
                        }}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <div className="border-t border-slate-200 p-4 text-center">
              <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Show more orders"}</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
