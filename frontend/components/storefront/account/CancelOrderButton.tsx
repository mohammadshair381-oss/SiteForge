"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "@/components/ui/ConfirmDialog";

const BUTTON = "inline-flex min-h-10 items-center justify-center px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60";

/** Cancels one of the signed-in customer's unpaid orders (the server re-checks ownership and state). */
export default function CancelOrderButton({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmAndCancel() {
    if (busy) return;
    const confirmed = await confirmDialog({ title: `Cancel order #${orderNumber}?`, message: "The items go back on sale and this order can't be restored.", confirmLabel: "Cancel order", cancelLabel: "Keep order", tone: "danger" });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/storefront/account/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not cancel the order. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void confirmAndCancel()}
        disabled={busy}
        aria-busy={busy}
        className={`${BUTTON} sf-acc-danger sf-acc-control border font-medium hover:opacity-80 focus-visible:ring-current disabled:opacity-60`}
      >
        {busy ? "Cancelling…" : "Cancel order"}
      </button>
      {error && (
        <p role="alert" className="sf-acc-error w-full text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
