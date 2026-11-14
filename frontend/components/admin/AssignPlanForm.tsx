"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";

/** Gives a store a plan by hand. The server decides whether that is allowed, and audits it. */
export default function AssignPlanForm({ businessId, plans, currentKey, providerManaged }: { businessId: string; plans: Array<{ key: string; name: string }>; currentKey: string | null; providerManaged: boolean }) {
  const router = useRouter();
  const [planKey, setPlanKey] = useState(currentKey && plans.some((p) => p.key === currentKey) ? currentKey : plans[0]?.key ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  if (providerManaged) {
    return <p className="text-[13px] text-slate-600">Razorpay manages this subscription, so its plan cannot be set here. The owner changes it from their billing page.</p>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const name = plans.find((p) => p.key === planKey)?.name ?? planKey;
    const confirmed = await confirmDialog({ title: `Put this store on the ${name} plan?`, message: "No payment is recorded. Its limits change straight away. A smaller plan never removes anything: it only stops new things being added.", confirmLabel: "Assign plan" });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setFields({});
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planKey, reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const info = apiErrorFrom(data, "The plan was not changed.");
        setFields(info.fields);
        setError(summaryMessage(info, ["planKey", "reason"]));
        return;
      }
      setDone(`The store is now on the ${name} plan.`);
      setReason("");
      router.refresh();
    } catch {
      setError("Network error. The plan was not changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <div>
        <label htmlFor="assign-plan" className={labelClass}>Plan</label>
        <select id="assign-plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)} className={inputClass}>
          {plans.map((plan) => <option key={plan.key} value={plan.key}>{plan.name}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="assign-reason" className={labelClass}>Reason (recorded in the audit log)</label>
        <input id="assign-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} {...invalidProps(fields, "reason", "assign")} />
        <FieldError id={fieldErrorId("assign", "reason")} message={fields.reason} />
      </div>
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      {done && <Notice tone="success" role="status">{done}</Notice>}
      <Button type="submit" variant="secondary" disabled={busy || !planKey}>{busy ? "Saving…" : "Assign plan"}</Button>
    </form>
  );
}
