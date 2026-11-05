"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";

/** Internal super-admin note on a dispute (audited; never changes its status). */
export default function DisputeNoteForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/admin/disputes/${disputeId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; fields?: unknown } | null;
      if (!res.ok) {
        const info = apiErrorFrom(data, "The note was not saved.");
        setFieldErrors(info.fields);
        setMessage({ ok: false, text: summaryMessage(info, ["note"]) });
        return;
      }
      setNote("");
      setMessage({ ok: true, text: "Note added." });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: "Network error. The note was not saved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      <label htmlFor={id} className={labelClass}>Internal note</label>
      <textarea id={id} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} {...invalidProps(fieldErrors, "note", `dispute-${disputeId}`)} />
      <FieldError id={fieldErrorId(`dispute-${disputeId}`, "note")} message={fieldErrors.note} />
      <p className="text-xs leading-5 text-slate-500">Visible to super admins only and recorded in the audit log. Do not paste card numbers or secrets.</p>
      <div aria-live="polite">{message && <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-emerald-800" : "text-red-700"}`}>{message.text}</p>}</div>
      <Button type="submit" disabled={busy || note.trim().length < 5}>
        {busy ? "Saving…" : "Add note"}
      </Button>
    </form>
  );
}
