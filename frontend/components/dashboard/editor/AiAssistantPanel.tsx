"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { StorefrontConfig } from "@/lib/storefront-config";
import type { BrandState, StorefrontDiffEntry } from "@/lib/ai-builder/storefront-changes";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice, Pill, Skeleton } from "@/components/ui/Surface";
import { editorFocus } from "./EditorWorkspace";
import AiConsentCard, { type AiConsentView } from "../AiConsentCard";
import { AI_STATUS, AiMark, AiNotes, AiPromises, AiUsageMeter, ChangeDiff } from "../ai/AiShared";

export interface AiPanelStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
}

export interface AiProposalPreview {
  id: string;
  config: StorefrontConfig;
  brand: BrandState;
}

interface ListItem {
  id: string;
  source: string;
  request: string;
  summary: string;
  status: string;
  failureCode: string | null;
  createdAt: string;
}

interface Detail extends ListItem {
  notes: string[];
  stale: boolean;
  diff: { changes: StorefrontDiffEntry[]; live: boolean };
  preview: { config: StorefrontConfig; brand: BrandState };
}

const EXAMPLES = ["Make my homepage look more premium", "Move New arrivals above the product collection", "Write a shorter, clearer hero", "Use black and gold colours"];
const FAILURES: Record<string, string> = {
  version_conflict: "Your homepage changed after this suggestion was made.",
  expired: "This suggestion expired.",
  validation_error: "This suggestion no longer fits your homepage.",
  invalid_featured_product: "A product it relies on is no longer available.",
};
const button = `inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9 ${editorFocus}`;
const primary = `inline-flex min-h-10 items-center justify-center rounded-lg bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-9 ${editorFocus}`;

/**
 * AI website assistant for the store homepage. The owner describes a change;
 * the provider's answer becomes a PENDING change proposal (validated
 * structured data, never code). The owner previews it on the canvas, then
 * approves and applies it to the DRAFT homepage, or rejects it. Publishing
 * stays the separate Publish action. When no provider is enabled, the panel
 * says so and nothing is sent anywhere; earlier suggestions stay reviewable.
 */
export default function AiAssistantPanel({
  businessId,
  status,
  consentView,
  usage,
  context,
  dirty,
  storeLive,
  previewingId,
  onPreview,
  onApplied,
  onClose,
}: {
  businessId: string;
  status: AiPanelStatus;
  /** The owner's consent (AI requests need it, on top of platform availability). */
  consentView: AiConsentView;
  usage: { used: number; limit: number; remaining: number } | null;
  context: { typeLabel: string; themeName: string; selectedLabel: string | null; selectedSectionId: string | null };
  dirty: boolean;
  storeLive: boolean;
  previewingId: string | null;
  onPreview: (preview: AiProposalPreview | null) => void;
  onApplied: () => void;
  onClose: () => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [instruction, setInstruction] = useState("");
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<"generate" | "apply" | "reject" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [used, setUsed] = useState(usage?.used ?? 0);
  const blockedMessage = consentView.blockedMessage ?? null;
  const taskUnavailable = consentView.tasks?.storefront === false;
  const ready = status.available && consentView.consent.granted && !blockedMessage && !taskUnavailable;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/proposals?target=storefront`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Suggestions could not be loaded.");
      setItems(data.proposals);
    } catch (error) {
      setItems([]);
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Suggestions could not be loaded." });
    }
  }, [businessId]);

  const open = useCallback(
    async (id: string) => {
      setMessage(null);
      try {
        const res = await fetch(`/api/businesses/${businessId}/proposals/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "This suggestion could not be opened.");
        setSelected(data.proposal);
      } catch (error) {
        setMessage({ ok: false, text: error instanceof Error ? error.message : "This suggestion could not be opened." });
      }
    },
    [businessId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** The server's count (only requests that reached the provider are charged). */
  async function refreshUsage() {
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/consent`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok && typeof data.usage?.used === "number") setUsed(data.usage.used);
    } catch {
      // Keep the last known count.
    }
  }

  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || instruction.trim().length < 3) return;
    setBusy("generate");
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/storefront`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim(), selectedSectionId: context.selectedSectionId }),
      });
      const data = await res.json().catch(() => ({}));
      void refreshUsage();
      if (!res.ok) throw new Error(data.error || "The assistant could not make a suggestion.");
      if (!data.proposal) {
        setMessage({ ok: true, text: data.message || "The assistant had no changes to suggest." });
        return;
      }
      setInstruction("");
      await load();
      setSelected(data.proposal);
      onPreview({ id: data.proposal.id, config: data.proposal.preview.config, brand: data.proposal.preview.brand });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was sent." });
    } finally {
      setBusy(null);
    }
  }

  async function review(decision: "approve" | "reject"): Promise<boolean> {
    const res = await fetch(`/api/businesses/${businessId}/proposals/${selected!.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "The suggestion could not be reviewed.");
    return true;
  }

  async function apply() {
    if (!selected) return;
    const liveNote = selected.diff.live ? "\n\nColour and font changes go to your design draft, and reach your whole store when you publish them." : "";
    if (!(await confirmDialog({ title: "Apply this suggestion to your draft?", message: `It goes to your draft homepage. Your live store does not change until you publish.${liveNote}`, confirmLabel: "Apply to draft" }))) return;
    setBusy("apply");
    setMessage(null);
    try {
      if (selected.status === "pending") await review("approve");
      const res = await fetch(`/api/businesses/${businessId}/proposals/${selected.id}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The suggestion could not be applied.");
      onPreview(null);
      // Refresh first: `open` clears the message, so the confirmation is set after it.
      await load();
      await open(selected.id);
      setMessage({ ok: true, text: "Applied to your draft. Review it in the editor, then publish when you are ready." });
      onApplied();
    } catch (error) {
      await load();
      if (selected) await open(selected.id);
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was applied." });
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!selected) return;
    setBusy("reject");
    setMessage(null);
    try {
      await review("reject");
      if (previewingId === selected.id) onPreview(null);
      await load();
      await open(selected.id);
      setMessage({ ok: true, text: "Suggestion rejected. Nothing was changed." });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error." });
    } finally {
      setBusy(null);
    }
  }

  const reviewable = selected && (selected.status === "pending" || selected.status === "approved");
  const previewing = selected && previewingId === selected.id;

  return (
    <section aria-labelledby="ai-panel-title" className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <AiMark size="sm" />
          <h2 id="ai-panel-title" className="text-sm font-semibold text-slate-900">
            AI assistant
          </h2>
          <Pill tone={ready ? "success" : "neutral"} dot>
            {ready ? "On" : status.available ? "Not turned on" : "Off"}
          </Pill>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {ready && usage && <AiUsageMeter used={used} limit={usage.limit} remaining={Math.max(0, usage.limit - used)} className="w-64 max-w-full" />}
          <button type="button" onClick={onClose} className={`inline-flex min-h-10 items-center rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 lg:min-h-8 ${editorFocus}`}>
            Close assistant
          </button>
        </div>
      </div>

      {/* Below desktop the whole body scrolls; on desktop each column scrolls on its own. */}
      <div className="grid max-h-[min(32rem,65vh)] min-h-0 overflow-y-auto lg:h-[min(26rem,48vh)] lg:max-h-none lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        <div className="min-h-0 space-y-4 border-b border-slate-200 p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="flex flex-wrap gap-1.5" aria-label="What the assistant knows">
            <Pill>{context.typeLabel} store</Pill>
            <Pill>{context.themeName} theme</Pill>
            {context.selectedLabel && <Pill tone="ember">Selected: {context.selectedLabel}</Pill>}
          </div>
          {status.available && !blockedMessage && !taskUnavailable && !consentView.consent.granted ? (
            <AiConsentCard businessId={businessId} view={consentView} compact />
          ) : ready ? (
            <form onSubmit={generate} className="space-y-2">
              <label htmlFor={inputId} className="block text-sm font-semibold text-slate-900">
                What would you like to change?
              </label>
              <textarea
                ref={textRef}
                id={inputId}
                rows={3}
                maxLength={500}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                aria-describedby={hintId}
                placeholder="For example: make the hero shorter and more premium"
                className={`w-full rounded-lg border border-slate-300 px-3 py-2 text-sm ${editorFocus}`}
              />
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" onClick={() => setInstruction(example)} className={`min-h-10 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-left text-xs text-slate-700 transition-colors hover:border-slate-300 hover:bg-slate-50 lg:min-h-7 ${editorFocus}`}>
                    {example}
                  </button>
                ))}
              </div>
              <button type="submit" className={`${primary} w-full`} disabled={busy !== null || instruction.trim().length < 3}>
                {busy === "generate" ? "Thinking…" : "Suggest changes"}
              </button>
              <p id={hintId} className="text-xs leading-5 text-slate-500">
                Suggestions are generated by {consentView.provider.name} from your store&apos;s own content (never customer, order or payment data). You review every change before it reaches your draft.
              </p>
            </form>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" role="note">
              <p className="font-semibold text-slate-900">{blockedMessage ?? "AI suggestions are not available right now."}</p>
              <p className="mt-1 text-xs leading-5">
                Nothing is sent to an AI provider. You can still make every change yourself with the editing panel.
              </p>
            </div>
          )}

          <p className="text-xs leading-5 text-slate-600">
            For new pages, SEO, product text and theme advice, open the{" "}
            <a href={`/dashboard/businesses/${businessId}/ai-builder`} className={`rounded font-medium text-slate-900 underline underline-offset-2 ${editorFocus}`}>AI Builder</a>.
          </p>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Suggestions</h3>
            {items === null ? (
              <div className="mt-2 space-y-1.5" aria-label="Loading suggestions">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : items.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">No suggestions yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5" aria-label="Suggestion history">
                {items.map((item) => {
                  const label = AI_STATUS[item.status] ?? AI_STATUS.pending;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => void open(item.id)}
                        aria-current={selected?.id === item.id ? "true" : undefined}
                        className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${editorFocus} ${selected?.id === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"}`}
                      >
                        <span className="block truncate text-sm font-medium text-slate-900">{item.request || item.summary}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <Pill tone={label.tone}>{label.text}</Pill>
                          {new Date(item.createdAt).toLocaleString()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="min-h-0 p-4 lg:overflow-y-auto">
          {message && (
            <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"} className="mb-3">
              {message.text}
            </Notice>
          )}
          {!selected ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-sm text-sm text-slate-500">Select a suggestion to see exactly what it changes.</p>
              <AiPromises className="justify-center" />
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                {selected.request && <p className="text-xs text-slate-500">You asked: “{selected.request}”</p>}
                <p className="mt-1 text-sm font-semibold text-slate-900">{selected.summary}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                  <Pill tone={(AI_STATUS[selected.status] ?? AI_STATUS.pending).tone}>{(AI_STATUS[selected.status] ?? AI_STATUS.pending).text}</Pill>
                  {selected.source === "ai" ? "Suggested by the AI assistant" : "Prepared in SiteForge"}
                  {selected.failureCode ? ` · ${FAILURES[selected.failureCode] ?? "It could not be applied."}` : ""}
                </p>
              </div>
              {selected.stale && reviewable && (
                <div role="note">
                  <Notice tone="warning" className="!text-xs">
                    Your homepage changed after this suggestion was made, so it can no longer be applied. Ask again for a fresh one.
                  </Notice>
                </div>
              )}
              {selected.diff.live && (
                <div role="note">
                  <Notice tone="warning" className="!text-xs">
                    Includes colour or font changes: these go to your design draft, and reach your whole store when you publish them.
                  </Notice>
                </div>
              )}
              <ChangeDiff rows={selected.diff.changes} caption="Changes in this suggestion" />
              <AiNotes notes={selected.notes} />
              <div className="flex flex-wrap items-center gap-2">
                {reviewable && (
                  <>
                    <button type="button" className={primary} disabled={busy !== null || selected.stale || dirty} onClick={() => void apply()}>
                      {busy === "apply" ? "Applying…" : "Apply to draft"}
                    </button>
                    <button
                      type="button"
                      className={button}
                      onClick={() => onPreview(previewing ? null : { id: selected.id, config: selected.preview.config, brand: selected.preview.brand })}
                      aria-pressed={Boolean(previewing)}
                    >
                      {previewing ? "Stop previewing" : "Preview on canvas"}
                    </button>
                    <button type="button" className={button} disabled={busy !== null} onClick={() => void reject()}>
                      {busy === "reject" ? "Rejecting…" : "Reject"}
                    </button>
                  </>
                )}
                {ready && selected.request && (
                  <button
                    type="button"
                    className={button}
                    disabled={busy !== null}
                    onClick={() => {
                      setInstruction(selected.request);
                      textRef.current?.focus();
                    }}
                  >
                    Edit request
                  </button>
                )}
                {reviewable && dirty && <span className="text-xs text-amber-800">Save or discard your unsaved changes first.</span>}
              </div>
              {reviewable && <p className="text-xs text-slate-500">Nothing changes until you apply it. Applied changes go to your draft; publishing is separate.</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
