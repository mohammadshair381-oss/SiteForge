"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { buttonClass } from "@/components/ui/Button";
import { Notice, Pill } from "@/components/ui/Surface";

/** Fixed locale and time zone: the server and the browser render the same text (no hydration mismatch). */
const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
const formatDateTime = (iso: string) => `${new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

export interface AiConsentView {
  provider: { name: string; available: boolean };
  /** Kinds of request the platform can handle now (server-decided). */
  tasks?: Record<string, boolean>;
  /** Why this store cannot use AI, whatever the owner's consent: its plan or a suspension. */
  blockedMessage?: string | null;
  disclosure: { version: string; points: readonly string[]; changes?: string };
  consent: { granted: boolean; outdated: boolean; version: string | null; grantedAt: string | null; revokedAt: string | null };
  /** Only the owner can turn AI suggestions on or off. */
  canManage: boolean;
  history?: Array<{ action: string; version: string; at: string; actor: string }>;
}

/**
 * The owner's consent to AI suggestions: what the AI provider receives (and
 * never receives), that suggestions need review, that approved changes are
 * drafts, and an explicit opt-in that can be revoked at any time.
 */
export default function AiConsentCard({ businessId, view, compact = false }: { businessId: string; view: AiConsentView; compact?: boolean }) {
  const router = useRouter();
  const checkId = useId();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const { consent, provider, disclosure, canManage } = view;

  async function send(method: "POST" | "DELETE") {
    if (method === "DELETE" && !(await confirmDialog({ title: "Turn off AI suggestions?", message: "AI requests for this store stop immediately. Suggestions you already applied stay in your drafts.", confirmLabel: "Turn off", tone: "danger" }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/consent`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "POST" ? { version: disclosure.version } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your choice could not be saved.");
      setMessage({ ok: true, text: method === "POST" ? "AI suggestions are on for this store." : "AI suggestions are off. No more requests are sent." });
      setAgreed(false);
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  }

  const statusText = consent.granted
    ? `On since ${consent.grantedAt ? formatDate(consent.grantedAt) : ""}`
    : consent.outdated
      ? "Off: the disclosure changed, please review it again"
      : "Off";

  return (
    <section aria-labelledby={`${checkId}-title`} className={compact ? "space-y-3 text-sm" : "space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${checkId}-title`} className={compact ? "text-sm font-semibold text-slate-900" : "text-lg font-semibold text-slate-900"}>
          AI suggestions with {provider.name}
        </h2>
        <Pill tone={consent.granted ? "success" : consent.outdated ? "warning" : "neutral"} dot className="!whitespace-normal">
          {statusText}
        </Pill>
      </div>
      {!provider.available && <p className="text-sm text-slate-600">AI suggestions are not available on this platform right now. Nothing is sent to {provider.name}.</p>}
      {provider.available && view.blockedMessage && <p className="text-sm text-slate-600">{view.blockedMessage}</p>}
      <div className={compact ? "rounded-xl bg-slate-50 p-3" : "rounded-xl bg-slate-50 p-4"}>
        {consent.outdated && disclosure.changes && <p className="mb-2 text-xs font-medium leading-5 text-slate-800">{disclosure.changes} AI suggestions stay off until the store owner agrees to this version.</p>}
        <p className="text-xs font-medium text-slate-500">What this means</p>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-5 text-slate-700">
          {disclosure.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">Disclosure version {disclosure.version}</p>
      </div>
      {canManage ? (
        consent.granted ? (
          <button type="button" disabled={busy} onClick={() => void send("DELETE")} className={buttonClass({ variant: "secondary", className: "!border-red-200 !text-red-700 hover:!border-red-300 hover:!bg-red-50" })}>
            {busy ? "Saving…" : "Turn off AI suggestions"}
          </button>
        ) : (
          <div className="space-y-2.5">
            <label htmlFor={checkId} className="flex items-start gap-2.5 text-sm text-slate-800">
              <input id={checkId} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 rounded" />
              <span>I have read this and allow {provider.name} to process my store content for AI suggestions.</span>
            </label>
            <button type="button" disabled={busy || !agreed} onClick={() => void send("POST")} className={buttonClass({ variant: "primary" })}>
              {busy ? "Saving…" : "Turn on AI suggestions"}
            </button>
          </div>
        )
      ) : (
        <p className="text-xs leading-5 text-slate-600">{consent.granted ? "The store owner turned on AI suggestions." : "Only the store owner can turn on AI suggestions."}</p>
      )}
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      {!compact && view.history && view.history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">History</h3>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
            {view.history.map((h, i) => (
              <li key={i}>
                {formatDateTime(h.at)} · {h.action === "granted" ? "Turned on" : "Turned off"} by {h.actor || "the owner"} · version {h.version}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
