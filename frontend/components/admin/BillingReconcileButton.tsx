"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { smallButtonClass } from "@/components/admin/ControlCenterUI";

/** Asks Razorpay about one store now. It can only match what Razorpay reports. */
export default function BillingReconcileButton({ businessId }: { businessId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/billing/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, reason: "Checked against Razorpay by an admin" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; outcome?: string } | null;
      if (!res.ok) {
        setMessage(data?.error ?? "Razorpay could not be reached.");
        return;
      }
      setMessage(`Checked: ${(data?.outcome ?? "done").replace(/_/g, " ")}.`);
      router.refresh();
    } catch {
      setMessage("Network error. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void run()} disabled={busy} className={smallButtonClass}>
        {busy ? "Checking…" : "Check with Razorpay"}
      </button>
      {message && (
        <span role="status" className="text-xs text-slate-600">
          {message}
        </span>
      )}
    </span>
  );
}
