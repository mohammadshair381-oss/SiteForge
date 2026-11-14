"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClass, labelClass } from "@/components/ui/Field";
import { Notice, Pill, type Tone } from "@/components/ui/Surface";
import { useToastHelpers } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/format";
import type { ManagedOrderDetail } from "@/lib/orders/management-detail";
import { REVIEW_REASON_TEXT } from "@/lib/orders/timeline";

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
/** Each outcome has its own label: Razorpay's answers are never worded like the owner's release. */
const OUTCOME_STATUS: Record<string, { label: string; tone: Tone }> = {
  in_progress: { label: "In progress", tone: "warning" },
  provider_confirmed: { label: "Refunded", tone: "success" },
  recorded: { label: "Recorded", tone: "success" },
  provider_failed: { label: "Failed", tone: "danger" },
  owner_released: { label: "Hold released by owner", tone: "neutral" },
};
const LATE_STATUS: Record<string, { label: string; tone: Tone }> = {
  recorded: { label: "Refunded after release", tone: "warning" },
  provider_failed: { label: "Hold released · confirmed by Razorpay", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "danger" },
};
const LATE_ISSUE: Record<string, string> = {
  provider_still_processing: "Razorpay has this refund but has not finished it yet. Its final answer is recorded when it arrives.",
  payment_not_found: "It could not be matched to this order's payment, so nothing was recorded.",
  does_not_fit_order: "It is more than this order has left to refund, so nothing was recorded. The customer may have been refunded twice.",
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
  // Releasing a stuck refund's hold: which refund, the owner's reason and their explicit statement.
  const [recoverId, setRecoverId] = useState<string | null>(null);
  const [recoverReason, setRecoverReason] = useState("");
  const [recoverConfirmed, setRecoverConfirmed] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
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

  function openRecovery(refundId: string | null) {
    setRecoverId(refundId);
    setRecoverReason("");
    setRecoverConfirmed(false);
    setRecoverError(null);
  }

  /** Only after the owner has checked Razorpay's dashboard. The server checks everything again. */
  async function submitRecovery(event: React.FormEvent, refund: ManagedOrderDetail["refunds"][number]) {
    event.preventDefault();
    if (!recoverConfirmed || recoverReason.trim().length < 5) {
      setRecoverError("Confirm what Razorpay's dashboard shows, and say why in a few words.");
      return;
    }
    const money = formatPrice(refund.amount, refund.currency);
    const confirmed = await confirmDialog({
      title: `Release the ${money} hold?`,
      message: `Do this only if Razorpay's dashboard shows that no refund of ${money} was made for this payment. The amount can then be refunded again. If Razorpay did make it after all, it is recorded as soon as Razorpay reports it, and the customer could be refunded twice if you refund again meanwhile. Your reason is recorded with your name.`,
      confirmLabel: "Release the hold",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    setRecoverError(null);
    try {
      const res = await fetch(`${base}/refund/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refundId: refund.id, reason: recoverReason.trim(), confirmedNotRefunded: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "The hold could not be released.");
      apply(data);
      openRecovery(null);
      success("Hold released", "The amount can be refunded again.");
    } catch (err) {
      // Said beside the form, so the owner sees why nothing changed.
      setRecoverError(err instanceof Error ? err.message : "The hold could not be released. Please try again.");
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

        {(detail.refundReviews ?? []).length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-slate-900">Razorpay reports to review</h3>
            <p className="mt-1 text-xs text-slate-600">
              Razorpay reported these refunds for this order, but each could not be matched to exactly one refund here, or could not be recorded, so nothing was attached, recorded or released. They are not failures. Look each one up in your Razorpay dashboard. If one stays open, contact support with the Razorpay refund id shown.
            </p>
            <ul className="mt-2 space-y-2">
              {detail.refundReviews.map((review) => (
                <li key={review.providerRefundId} className={`rounded-lg border p-2.5 text-sm ${review.resolvedAt ? "border-slate-200 bg-white" : "border-red-200 bg-red-50"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium tabular-nums text-slate-900">{formatPrice(review.amount, review.currency || order.currency || "USD")}</span>
                    <Pill tone={review.resolvedAt ? "neutral" : "danger"}>{review.resolvedAt ? "Matched later" : review.reason === "does_not_fit_order" ? "Refunded in Razorpay, not recorded" : "Needs review"}</Pill>
                  </div>
                  <p className="mt-1 break-all text-xs text-slate-600">
                    Razorpay refund {review.providerRefundId}
                    {review.providerPaymentId ? ` · payment ${review.providerPaymentId}` : ""}
                    {review.providerStatus ? ` · Razorpay status: ${review.providerStatus}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    {review.reason === "ambiguous_match"
                      ? `It matches ${review.candidateCount} refunds on this order by payment and amount, so it was not attached to any of them.`
                      : `${REVIEW_REASON_TEXT[review.reason] ?? "It could not be attached to a refund on this order"}.`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    First reported {when(review.firstSeenAt)}
                    {review.lastSeenAt !== review.firstSeenAt ? ` · last ${when(review.lastSeenAt)}` : ""}
                    {review.resolvedAt ? ` · matched to one refund ${when(review.resolvedAt)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {refunds.length > 0 && (
          <>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">Refunds</h3>
            <ul className="mt-2 space-y-2">
              {refunds.map((refund) => (
                <li key={refund.id} className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium tabular-nums text-slate-900">{formatPrice(refund.amount, refund.currency)}</span>
                    {(() => {
                      const shown = (refund.lateReport && LATE_STATUS[refund.lateReport.outcome]) || OUTCOME_STATUS[refund.outcome] || REFUND_STATUS[refund.status];
                      return <Pill tone={shown?.tone ?? "neutral"}>{shown?.label ?? refund.status}</Pill>;
                    })()}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {refund.provider === "manual"
                      ? "Recorded by your team"
                      : refund.confirmsRecoveryOf
                        ? "Reported by Razorpay after the owner released an earlier hold"
                        : refund.startedOutside
                          ? "Started in Razorpay"
                          : "Through Razorpay"}
                    {refund.mode === "test" ? " (test mode)" : ""} · {when(refund.createdAt)}
                    {refund.restock ? " · items back in stock" : ""}
                  </p>
                  {refund.reason && <p className="mt-1 break-words text-xs text-slate-600">{refund.reason}</p>}
                  {refund.recovery ? (
                    <div className="mt-1 space-y-0.5 break-words text-xs text-slate-600">
                      <p className="font-medium text-slate-800">Refund hold manually released by the business owner.</p>
                      <p>
                        {refund.recovery.byName} released it {when(refund.recovery.at)}, confirming that no refund was visible in Razorpay&apos;s dashboard at the time. Razorpay itself never reported a result.
                      </p>
                      <p>Reason: {refund.recovery.reason}</p>
                      <p>
                        Status: {refund.recovery.previousStatus === "pending" ? "in progress" : refund.recovery.previousStatus} → hold released. Held on the order: {formatPrice(refund.recovery.heldBefore, refund.currency)} before, {formatPrice(refund.recovery.heldAfter, refund.currency)} after.
                      </p>
                    </div>
                  ) : (
                    refund.outcome === "provider_failed" && (
                      <p className="mt-1 text-xs font-medium text-red-700">
                        {refund.failureCode === "account_unavailable"
                          ? "It was never sent: the Razorpay account this payment was taken with was not available. Nothing was refunded."
                          : `Razorpay refused or failed it${refund.failureCode ? ` (${refund.failureCode})` : ""}. Nothing was refunded.`}
                      </p>
                    )
                  )}
                  {refund.lateReport && (
                    <p className={`mt-1 break-words text-xs font-medium ${refund.lateReport.outcome === "provider_failed" ? "text-slate-700" : "text-red-700"}`}>
                      {refund.lateReport.outcome === "recorded"
                        ? `Afterwards, ${when(refund.lateReport.at)}, Razorpay reported that this refund was made after all. It is recorded as its own refund on this order. Check that the customer was not refunded twice.`
                        : refund.lateReport.outcome === "provider_failed"
                          ? `Afterwards, ${when(refund.lateReport.at)}, Razorpay confirmed that this refund was not made.`
                          : `Afterwards, ${when(refund.lateReport.at)}, Razorpay reported on this refund (${refund.lateReport.providerStatus}). ${LATE_ISSUE[refund.lateReport.issue ?? ""] ?? "Check it in your Razorpay dashboard."}`}
                    </p>
                  )}
                  {refund.status === "pending" && refund.provider === "razorpay" && isOwner && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" disabled={busy} onClick={() => void checkRefund(refund.id)}>Check with Razorpay</Button>
                        {refund.recoverable && !refund.recoveryBlockedByReview && recoverId !== refund.id && (
                          <Button variant="ghost" disabled={busy} onClick={() => openRecovery(refund.id)}>Razorpay shows no refund…</Button>
                        )}
                      </div>
                      {refund.recoverable && refund.recoveryBlockedByReview && (
                        <p className="text-xs font-medium text-red-700">
                          Razorpay has reported a refund of this amount on this payment that is still waiting for review (see &quot;Razorpay reports to review&quot;). It may be this refund, so its hold cannot be released. Check the refund in your Razorpay dashboard and contact support to have the report reviewed.
                        </p>
                      )}
                      {!refund.knownToRazorpay && !refund.recoverable && refund.recoverableFrom && (
                        <p className="text-xs text-slate-500">If Razorpay still has not answered by {when(refund.recoverableFrom)}, and its dashboard shows no refund for this payment, you can release this hold.</p>
                      )}
                      {recoverId === refund.id && (
                        <form onSubmit={(event) => void submitRecovery(event, refund)} className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <p className="text-xs text-amber-950">
                            Open this payment in your Razorpay dashboard first. Release the hold only if Razorpay shows no refund of {formatPrice(refund.amount, refund.currency)} for it. Nothing is sent to Razorpay.
                          </p>
                          <label className={labelClass}>
                            Why you are releasing it (only your team sees this)
                            <textarea rows={2} required minLength={5} maxLength={500} value={recoverReason} onChange={(e) => setRecoverReason(e.target.value)} className={`mt-1.5 ${inputClass}`} />
                          </label>
                          <label className="flex min-h-10 items-start gap-2 text-sm text-slate-800">
                            <input type="checkbox" checked={recoverConfirmed} onChange={(e) => setRecoverConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4" />
                            <span>I checked this payment in Razorpay&apos;s dashboard, and it shows no refund of {formatPrice(refund.amount, refund.currency)}.</span>
                          </label>
                          {recoverError && <p role="alert" className="text-xs font-medium text-red-700">{recoverError}</p>}
                          <div className="flex flex-wrap gap-2">
                            <Button type="submit" disabled={busy || !recoverConfirmed || recoverReason.trim().length < 5}>{busy ? "Working…" : "Release the hold"}</Button>
                            <Button variant="secondary" disabled={busy} onClick={() => openRecovery(null)}>Cancel</Button>
                          </div>
                        </form>
                      )}
                    </div>
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
