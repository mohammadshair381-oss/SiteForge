"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill, type Tone } from "@/components/ui/Surface";
import type { RevisionSummary } from "@/lib/website-revisions";

const REASON: Record<RevisionSummary["reason"], { label: string; tone: Tone }> = {
  published: { label: "Published", tone: "success" },
  checkpoint: { label: "Autosaved copy", tone: "neutral" },
  before_restore: { label: "Before a restore", tone: "neutral" },
  before_revert: { label: "Before going back", tone: "neutral" },
  deleted: { label: "Deleted", tone: "danger" },
};

const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Saved versions of one part of the website. Restoring brings a version back
 * into the draft and never publishes (the live website stays as it is).
 */
export default function RevisionHistoryDialog({
  businessId,
  target,
  targetId,
  title,
  onClose,
  onRestored,
}: {
  businessId: string;
  target: "page" | "home" | "design" | "navigation";
  targetId?: string;
  title: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const query = new URLSearchParams({ target, targetId: targetId ?? "" });
    fetch(`/api/businesses/${businessId}/revisions?${query}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "The history could not be loaded.");
        setRevisions(data.revisions ?? []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "The history could not be loaded."));
  }, [businessId, target, targetId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function restore(revision: RevisionSummary) {
    if (!(await confirmDialog({ title: "Restore this version?", message: `Your draft becomes the version from ${when(revision.createdAt)}. Your live website does not change until you publish, and your current draft stays in this history.`, confirmLabel: "Restore to draft" }))) return;
    setBusy(revision.id);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/revisions/${revision.id}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "This version could not be restored.");
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : "This version could not be restored.");
      setBusy(null);
    }
  }

  return (
    <div className="ui-fade fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="revision-title">
      <div className="ui-pop flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0">
            <h2 id="revision-title" className="truncate text-lg font-semibold text-slate-900">Version history: {title}</h2>
            <p className="mt-1 text-sm text-slate-600">Earlier versions are kept when you publish, and now and then while you edit. Restoring only changes your draft.</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <span className="sr-only">Close</span>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {error && <Notice tone="danger" role="alert" className="mb-3">{error}</Notice>}
          {revisions === null && !error && <p className="py-6 text-center text-sm text-slate-500">Loading versions…</p>}
          {revisions?.length === 0 && (
            <p className="rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-600">No earlier versions yet. The first one is kept the next time you publish.</p>
          )}
          {revisions && revisions.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {revisions.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{when(revision.createdAt)}</p>
                    <p className="mt-1"><Pill tone={REASON[revision.reason].tone}>{REASON[revision.reason].label}</Pill></p>
                  </div>
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void restore(revision)}>
                    {busy === revision.id ? "Restoring…" : "Restore"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
