"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps } from "@/lib/api-errors";
import { Notice } from "@/components/ui/Surface";
import AdminDialog from "./AdminDialog";
import { dangerSmallButtonClass, smallButtonClass } from "./ControlCenterUI";

/** Keep in sync with ADMIN_REASON_MIN in lib/admin-audit.ts (server enforces it). */
const REASON_MIN = 5;

type BusinessAction = "suspend" | "reactivate";

/**
 * Suspend / reactivate one business through the audited admin API
 * (`PATCH /api/admin/businesses?id=`). A reason is required and recorded in
 * the audit log; the server re-checks the super-admin role and the current
 * status, so this component only collects intent.
 */
export default function BusinessStatusAction({
  business,
  onChanged,
}: {
  business: { id: string; name: string; status: string };
  onChanged?: (status: string, message: string) => void;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [pending, setPending] = useState<BusinessAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  function open(action: BusinessAction) {
    setPending(action);
    setReason("");
    setError(null);
    setReasonError(null);
  }

  async function confirmAction() {
    if (!pending || busy) return;
    if (reason.trim().length < REASON_MIN) {
      setReasonError(`Give a reason of at least ${REASON_MIN} characters.`);
      return;
    }
    setBusy(true);
    setError(null);
    setReasonError(null);
    try {
      const res = await fetch(`/api/admin/businesses?id=${business.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: pending, reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; fields?: unknown; business?: { status: string } } | null;
      if (!res.ok || !data?.business) {
        const info = apiErrorFrom(data, "Unable to update business");
        if (info.fields.reason) setReasonError(info.fields.reason);
        else setError(info.message);
        return;
      }
      onChanged?.(
        data.business.status,
        pending === "suspend"
          ? `${business.name} is suspended. Its storefront is offline.`
          : `${business.name} is reactivated as a draft. The owner must publish it again.`,
      );
      setPending(null);
      router.refresh();
    } catch {
      setError("Network error. The business status was not changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {business.status === "suspended" ? (
        <button type="button" onClick={() => open("reactivate")} className={smallButtonClass}>
          Reactivate
        </button>
      ) : (
        <button type="button" onClick={() => open("suspend")} className={dangerSmallButtonClass}>
          Suspend
        </button>
      )}

      {pending && (
        <AdminDialog
          title={`${pending === "suspend" ? "Suspend" : "Reactivate"} ${business.name}?`}
          busy={busy}
          onClose={() => setPending(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={pending === "suspend" ? "danger" : "primary"} onClick={() => void confirmAction()} disabled={busy || reason.trim().length < REASON_MIN}>
                {busy ? "Saving…" : pending === "suspend" ? "Suspend business" : "Reactivate as draft"}
              </Button>
            </>
          }
        >
          <p className="mt-2 leading-6 text-slate-600">
            {pending === "suspend"
              ? "The storefront goes offline immediately and new orders stop. The owner keeps dashboard access but cannot publish until the business is reactivated."
              : "The business returns to draft. It stays offline until the owner publishes it again through the normal publishing checks."}
          </p>
          <label htmlFor={reasonId} className={`mt-4 ${labelClass}`}>
            Reason (recorded in the audit log)
          </label>
          <textarea id={reasonId} rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setReasonError(null); }} className={inputClass} {...invalidProps({ reason: reasonError ?? undefined }, "reason", "business-status")} />
          <p className="mt-1.5 text-xs text-slate-500">At least {REASON_MIN} characters.</p>
          <FieldError id={fieldErrorId("business-status", "reason")} message={reasonError} />
          {error && (
            <Notice tone="danger" role="alert" className="mt-3">
              {error}
            </Notice>
          )}
        </AdminDialog>
      )}
    </>
  );
}
