"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { focusRing } from "@/components/ui/Button";
import { Card, Notice, Pill } from "@/components/ui/Surface";

/**
 * Storefront payment options (owner only). Cash on delivery is the only
 * selectable method; the server enforces the owner role and re-checks the
 * setting at every checkout.
 */
export default function PaymentSettings({
  businessId,
  canManage,
  initialCodEnabled,
  initialGuestCodEnabled = false,
  accountsEnabled,
}: {
  businessId: string;
  canManage: boolean;
  initialCodEnabled: boolean;
  initialGuestCodEnabled?: boolean;
  accountsEnabled: boolean;
}) {
  const router = useRouter();
  const toggleId = useId();
  const guestToggleId = useId();
  const [codEnabled, setCodEnabled] = useState(initialCodEnabled);
  const [guestCodEnabled, setGuestCodEnabled] = useState(initialGuestCodEnabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function saveGuest(next: boolean) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guestCodEnabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: "error", text: typeof data.error === "string" ? data.error : "Could not save the payment setting." });
        return;
      }
      setGuestCodEnabled(next);
      setMessage({ kind: "ok", text: next ? "Guests can now pay by cash on delivery." : "Only signed-in customers can pay by cash on delivery now." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  async function save(next: boolean) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codEnabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ kind: "error", text: typeof data.error === "string" ? data.error : "Could not save the payment setting." });
        return;
      }
      setCodEnabled(next);
      setMessage({ kind: "ok", text: next ? "Cash on delivery is enabled." : "Cash on delivery is disabled." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card as="section" aria-labelledby={`${toggleId}-title`} className="p-5 sm:p-6">
      <h2 id={`${toggleId}-title`} className="text-lg font-semibold text-slate-900">Payments</h2>
      <p className="mt-1 text-sm text-slate-600">
        Customers can always place an order and arrange payment with you. Online payment is set up separately with your own
        Razorpay account (owner only).
      </p>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 p-4">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={toggleId} className="font-semibold text-slate-900">Cash on delivery</label>
            <Pill tone={codEnabled ? "success" : "neutral"} dot>{codEnabled ? "On" : "Off"}</Pill>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Signed-in customers with a confirmed email can choose to pay in cash when the order arrives. Their items stay
            reserved until you mark the order paid or cancel it. Each customer can have at most 3 open cash-on-delivery
            orders.
          </p>
          {!accountsEnabled && !guestCodEnabled && (
            <Notice tone="warning" className="mt-3">
              Customer accounts are not enabled on this platform yet, so cash on delivery will not appear to shoppers even
              when switched on here.
            </Notice>
          )}
          {!canManage && <p className="mt-2 text-sm text-slate-500">Only the business owner can change payment settings.</p>}
        </div>
        <button
          id={toggleId}
          type="button"
          role="switch"
          aria-checked={codEnabled}
          disabled={!canManage || saving}
          onClick={() => void save(!codEnabled)}
          className={`relative inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
        >
          <span className="sr-only">{codEnabled ? "Disable" : "Enable"} cash on delivery</span>
          <span aria-hidden="true" className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${codEnabled ? "bg-brand-600" : "bg-slate-300"}`}>
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${codEnabled ? "translate-x-6" : "translate-x-1"}`} />
          </span>
        </button>
      </div>
      {codEnabled && (
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 p-4">
          <div className="min-w-0 flex-1 basis-56">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={guestToggleId} className="font-semibold text-slate-900">Cash on delivery for guests</label>
              <Pill tone={guestCodEnabled ? "success" : "neutral"} dot>{guestCodEnabled ? "On" : "Off"}</Pill>
            </div>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Shoppers can choose cash on delivery without an account, giving their name, email, phone number and address.
              Nobody has verified these details, so confirm each order, for example by phone. Items are held for 7 days, then
              released unless you start preparing the order. One phone number or email can have 2 open orders.
            </p>
          </div>
          <button
            id={guestToggleId}
            type="button"
            role="switch"
            aria-checked={guestCodEnabled}
            disabled={!canManage || saving}
            onClick={() => void saveGuest(!guestCodEnabled)}
            className={`relative inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
          >
            <span className="sr-only">{guestCodEnabled ? "Disable" : "Enable"} cash on delivery for guests</span>
            <span aria-hidden="true" className={`inline-flex h-7 w-12 items-center rounded-full transition-colors ${guestCodEnabled ? "bg-brand-600" : "bg-slate-300"}`}>
              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${guestCodEnabled ? "translate-x-6" : "translate-x-1"}`} />
            </span>
          </button>
        </div>
      )}
      <div aria-live="polite">
        {message && (
          <Notice tone={message.kind === "ok" ? "success" : "danger"} className="mt-3">
            {message.text}
          </Notice>
        )}
      </div>
    </Card>
  );
}
