"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClass } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, inputClass } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { readApiError } from "@/lib/api-errors";

/**
 * Settings → Delete this business (primary owner only). The server decides everything
 * (lib/business-deletion.ts): this only collects the confirmation and shows its answer.
 */
export default function DeleteBusinessCard({ businessId, businessName }: { businessId: string; businessName: string }) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const nameMatches = confirmName.trim() === businessName.trim();

  function reset() {
    setOpen(false);
    setConfirmName("");
    setPassword("");
    setError(null);
    setFieldErrors({});
  }

  async function onDelete(event: React.FormEvent) {
    event.preventDefault();
    if (!nameMatches || !password) return;
    const sure = await confirmDialog({
      title: `Delete ${businessName}?`,
      message: "The store goes offline at once, and nobody on your team can open this business again. This cannot be undone from your dashboard.",
      confirmLabel: "Delete business",
      tone: "danger",
    });
    if (!sure) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmName, password }),
      });
      if (!res.ok) {
        const info = await readApiError(res, "The business could not be deleted.");
        setFieldErrors(info.fields);
        setError(info.fields.confirmName || info.fields.password ? null : info.message);
        setPassword("");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error. Nothing was deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-2xl border border-red-200 bg-white p-5 shadow-sm sm:p-6">
      <div>
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">Delete this business</h2>
        <p className="mt-1 text-sm text-slate-600">
          Takes the store offline and removes the business from your dashboard and your team&apos;s. Your order and payment
          records are kept, but you will not be able to open this business again.
        </p>
      </div>

      {!open ? (
        <button type="button" className={buttonClass({ variant: "danger" })} onClick={() => setOpen(true)}>
          Delete business
        </button>
      ) : (
        <form onSubmit={onDelete} className="space-y-4">
          <ul className="list-disc space-y-1 rounded-xl bg-red-50 p-4 pl-8 text-sm text-red-900">
            <li>Your storefront and its address stop working immediately.</li>
            <li>Every manager and staff member loses access, and pending invitations are cancelled.</li>
            <li>It cannot be deleted while orders still need payment, delivery or a refund, or while a paid plan is active.</li>
          </ul>
          <Field label={`Type ${businessName} to confirm`} error={fieldErrors.confirmName}>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
              className={`${inputClass} border-slate-300`}
              disabled={busy}
            />
          </Field>
          <Field label="Your password" error={fieldErrors.password}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={`${inputClass} border-slate-300`}
              disabled={busy}
            />
          </Field>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className={buttonClass({ variant: "danger" })} disabled={busy || !nameMatches || !password}>
              {busy ? "Deleting…" : "Delete this business"}
            </button>
            <button type="button" className={buttonClass({ variant: "secondary" })} onClick={reset} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
