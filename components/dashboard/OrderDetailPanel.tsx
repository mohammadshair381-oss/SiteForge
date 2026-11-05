"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClass, labelClass } from "@/components/ui/Field";
import { Notice, Pill, type Tone } from "@/components/ui/Surface";
import { useToastHelpers } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/format";
import type { ManagedOrderDetail } from "@/lib/orders/management-detail";

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  created: { label: "Waiting for payment", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  failed: { label: "Expired", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
const REFUND_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "In progress", tone: "warning" },
  processed: { label: "Refunded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/**
 * Payment history, refunds and the team's note for one order. Everything is read
 * from and checked by the server: the amount typed here is only a request.
 */
export default function OrderDetailPanel({
  businessId,
  orderId,
  isOwner,
  onOrderChanged,
}: {
  businessId: string;
  orderId: string;
  isOwner: boolean;
  onOrderChanged: (order: ManagedOrderDetail["order"]) => void;
}) {
  const { success, error: toastError } = useToastHelpers();
  const [detail, setDetail] = useState<ManagedOrderDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(true);
  const [refundOpen, setRefundOpen] = useState(false);
  const [method, setMethod] = useState<"razorpay" | "manual">("manual");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = `/api/businesses/${businessId}/manage/orders/${orderId}`;

  const apply = useCallback(
    (next: ManagedOrderDetail) => {
      setDetail(next);
      setNote(next.order.internalNote);
      setNoteSaved(true);
      setAmount(next.refundable > 0 ? next.refundable.toFixed(2) : "");
      setMethod(next.canRefundOnline && isOwner ? "razorpay" : "manual");
      onOrderChanged(next.order);
    },
    [isOwner, onOrderChanged],
  );

  useEffect(() => {
    let active = true;
    fetch(base, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "These details could not be loaded.");
        if (active) {
          setDetail(data);
          setNote(data.order.internalNote);
          setAmount(data.refundable > 0 ? Number(data.refundable).toFixed(2) : "");
          setMethod(data.canRefundOnline && isOwner ? "razorpay" : "manual");
        }
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : "These details could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [base, isOwner]);

  async function saveNote() {
    setBusy(true);
    try {
      const res = await fetch(`${base}/note`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The note could not be saved.");
      setNoteSaved(true);
      success("Note saved", "Only your team can see it.");
    } catch (err) {
      toastError("Note not saved", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRefund(event: React.FormEvent) {
    event.preventDefault();
    if (!detail) return;
    const value = Number(amount);
    if (!(value > 0)) {
      toastError("Enter an amount", "The refund must be more than zero.");
      return;
    }
    const money = formatPrice(value, detail.order.currency || "USD");
    const confirmed = await confirmDialog(
      method === "razorpay"
        ? { title: `Refund ${money} through Razorpay?`, message: `The money goes back to the customer's original payment method from your own Razorpay account.${detail.payments.some((p) => p.status === "paid" && p.mode === "test") ? " This payment was made in test mode, so no real money moves." : ""} This cannot be undone.`, confirmLabel: `Refund ${money}`, tone: "danger" }
        : { title: `Record a refund of ${money}?`, message: "This only records it. You still need to return the money to the customer yourself.", confirmLabel: "Record refund" },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await fetch(`${base}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, amount: value, reason, restock }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The refund could not be made.");
      apply(data);
      setRefundOpen(false);
      setReason("");
      setRestock(false);
      success("Refund updated", method === "razorpay" ? "Razorpay has the request." : "The refund is recorded.");
    } catch (err) {
      toastError("Refund not made", err instanceof Error ? err.message : "Please try again.");
      // The hold or outcome may have changed: show what the server now says.
      const fresh = await fetch(base, { cache: "no-store" }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
      if (fresh) apply(fresh);
    } finally {
      setBusy(false);
    }
  }

  async function checkRefund(refundId: string) {
    setBusy(true);
    try {
      const res = await fetch(`${base}/refund`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refundId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Razorpay could not be reached.");
      apply(data);
    } catch (err) {
      toastError("Could not check", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <Notice tone="danger" role="alert" className="mt-3">{loadError}</Notice>;
  if (!detail) return <p role="status" className="mt-3 text-sm text-slate-500">Loading details…</p>;

  const { order, payments, refunds, refundable, canRefundOnline, timeline, inventory } = detail;
  const currency = order.currency || "USD";

  return (
    <div className="mt-3 grid gap-4 border-t border-slate-200 pt-4 lg:grid-cols-2">
      <section aria-label="Order history" className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900">Order history</h3>
        <ol className="mt-2 space-y-2 border-l border-slate-200 pl-3">
          {timeline.map((event, index) => (
            <li key={`${event.at}-${index}`} className="text-sm">
              <p className="font-medium text-slate-800">{event.label}</p>
              <p className="text-xs text-slate-500">
                {when(event.at)}
                {event.detail ? ` · ${event.detail}` : ""}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Stock changes" className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900">Stock changes from this order</h3>
        {inventory.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">None recorded for this order.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {inventory.map((movement) => (
              <li key={movement.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
                <p className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words font-medium text-slate-900">
                    {movement.productName}
                    {movement.variantLabel ? <span className="font-normal text-slate-500"> ({movement.variantLabel})</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums font-medium text-slate-900">{movement.delta > 0 ? `+${movement.delta}` : movement.delta}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {movement.reason} · {when(movement.at)}
                  {movement.stockAfter !== null ? ` · ${movement.stockAfter} left after` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Payment history" className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900">Payment history</h3>
        {payments.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">{order.paymentMethod === "cod" ? "Cash on delivery: marked paid by your team." : "No online payment was started for this order."}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {payments.map((payment) => (
              <li key={payment.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium tabular-nums text-slate-900">{formatPrice(payment.amount, payment.currency)}</span>
                  <span className="flex flex-wrap gap-1.5">
                    {payment.mode === "test" && <Pill tone="info">Test mode</Pill>}
                    <Pill tone={PAYMENT_STATUS[payment.status]?.tone ?? "neutral"}>{PAYMENT_STATUS[payment.status]?.label ?? payment.status}</Pill>
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  Started {when(payment.createdAt)}
                  {payment.paidAt ? ` · paid ${when(payment.paidAt)}` : ""}
                </p>
                {payment.providerPaymentId && <p className="break-all text-xs text-slate-500">Razorpay payment {payment.providerPaymentId}</p>}
                {payment.lastFailureAt && <p className="mt-1 text-xs font-medium text-amber-800">An attempt was declined {when(payment.lastFailureAt)}{payment.lastFailureCode ? ` (${payment.lastFailureCode})` : ""}.</p>}
                {payment.needsReview && <p className="mt-1 text-xs font-medium text-red-700">Paid after the order closed: refund it or fulfil it by hand.</p>}
              </li>
            ))}
          </ul>
        )}

        {refunds.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">Refunds</h3>
            <ul className="mt-2 space-y-2">
              {refunds.map((refund) => (
                <li key={refund.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium tabular-nums text-slate-900">{formatPrice(refund.amount, refund.currency)}</span>
                    <Pill tone={REFUND_STATUS[refund.status]?.tone ?? "neutral"}>{REFUND_STATUS[refund.status]?.label ?? refund.status}</Pill>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {refund.provider === "manual" ? "Recorded by your team" : refund.startedOutside ? "Started in Razorpay" : "Through Razorpay"}
                    {refund.mode === "test" ? " (test mode)" : ""} · {when(refund.createdAt)}
                    {refund.restock ? " · items back in stock" : ""}
                  </p>
                  {refund.reason && <p className="mt-1 break-words text-xs text-slate-600">{refund.reason}</p>}
                  {refund.failureCode && <p className="mt-1 text-xs font-medium text-red-700">It did not go through ({refund.failureCode}).</p>}
                  {refund.status === "pending" && refund.provider === "razorpay" && isOwner && (
                    <Button variant="secondary" className="mt-2" disabled={busy} onClick={() => void checkRefund(refund.id)}>Check with Razorpay</Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-label="Refund and notes" className="min-w-0 space-y-4">
        {refundable > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Refund</h3>
            <p className="mt-1 text-sm text-slate-600">Up to {formatPrice(refundable, currency)} can still be refunded.</p>
            {!refundOpen ? (
              <Button variant="secondary" className="mt-2" onClick={() => setRefundOpen(true)}>Start a refund</Button>
            ) : (
              <form onSubmit={submitRefund} className="mt-2 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
                {canRefundOnline && (
                  <label className={labelClass}>
                    How
                    <select value={method} onChange={(e) => setMethod(e.target.value as "razorpay" | "manual")} className={`mt-1.5 ${inputClass}`}>
                      <option value="razorpay" disabled={!isOwner}>Through Razorpay{isOwner ? "" : " (owner only)"}</option>
                      <option value="manual">Record one made another way</option>
                    </select>
                  </label>
                )}
                <label className={labelClass}>
                  Amount ({currency})
                  <input type="number" min={0.01} max={refundable} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} className={`mt-1.5 ${inputClass}`} />
                </label>
                <label className={labelClass}>
                  Reason (only your team sees this)
                  <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className={`mt-1.5 ${inputClass}`} />
                </label>
                <label className="flex min-h-10 items-start gap-2 text-sm text-slate-800">
                  <input type="checkbox" checked={restock} disabled={Number(amount) < refundable - 0.005} onChange={(e) => setRestock(e.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span>
                    Put the items back in stock
                    <span className="block text-xs text-slate-500">Only with a refund of the full remaining amount. For a partial return, adjust stock in Inventory.</span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>{busy ? "Working…" : method === "razorpay" ? "Refund through Razorpay" : "Record refund"}</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => setRefundOpen(false)}>Cancel</Button>
                </div>
              </form>
            )}
          </div>
        )}
        <div>
          <label className={labelClass}>
            Team note (customers never see this)
            <textarea
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setNoteSaved(false);
              }}
              className={`mt-1.5 ${inputClass}`}
            />
          </label>
          <Button variant="secondary" className="mt-2" disabled={busy || noteSaved} onClick={() => void saveNote()}>Save note</Button>
        </div>
      </section>
    </div>
  );
}
