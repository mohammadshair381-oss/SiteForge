"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Surface";
import { PREVIEW_LINK_DURATIONS, PREVIEW_LINK_DURATION_KEYS, type PreviewLinkDuration, type PreviewLinkSummary } from "@/lib/preview-link-options";

const field = "mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Makes a link that shows the saved drafts to someone without an account. The
 * address is shown once, because only a hash of it is stored.
 */
export default function PreviewLinksDialog({
  businessId,
  page,
  prepare,
  onClose,
}: {
  businessId: string;
  /** Offers a link to just this page. */
  page?: { id: string; title: string };
  /** Saves unsaved edits first, so the link shows them. */
  prepare?: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<PreviewLinkSummary[] | null>(null);
  const [scope, setScope] = useState<"site" | "page">(page ? "page" : "site");
  const [duration, setDuration] = useState<PreviewLinkDuration>("24h");
  const [address, setAddress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const base = `/api/businesses/${businessId}/preview-links`;

  useEffect(() => {
    closeRef.current?.focus();
    fetch(base, { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Your preview links could not be loaded.");
        setLinks(data.links ?? []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Your preview links could not be loaded."));
  }, [base]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function create() {
    setBusy(true);
    setError(null);
    setAddress(null);
    setCopied(false);
    try {
      await prepare?.();
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, duration, ...(scope === "page" && page ? { pageId: page.id } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The link could not be created.");
      setAddress(`${window.location.origin}${data.path}`);
      setLinks((list) => [data.link, ...(list ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link: PreviewLinkSummary) {
    if (!(await confirmDialog({ title: "Turn off this link?", message: "Anyone who has it can no longer open the preview.", confirmLabel: "Turn off", tone: "danger" }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/${link.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The link could not be turned off.");
      setLinks((list) => (list ?? []).filter((item) => item.id !== link.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link could not be turned off.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setError("Copying was blocked by your browser. Select the link and copy it yourself.");
    }
  }

  return (
    <div className="ui-fade fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="preview-links-title">
      <div className="ui-pop my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
          <div className="min-w-0">
            <h2 id="preview-links-title" className="text-lg font-semibold text-slate-900">Share a draft preview</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">Anyone with the link can see your saved drafts until it ends, without signing in. Your live website does not change.</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <span className="sr-only">Close</span>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="space-y-4 p-5">
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-2">
            {page && (
              <label className="block text-sm font-medium text-slate-800">
                Show
                <select value={scope} onChange={(e) => setScope(e.target.value as "site" | "page")} className={field}>
                  <option value="page">Only {page.title}</option>
                  <option value="site">The whole website</option>
                </select>
              </label>
            )}
            <label className="block text-sm font-medium text-slate-800">
              Link lasts
              <select value={duration} onChange={(e) => setDuration(e.target.value as PreviewLinkDuration)} className={field}>
                {PREVIEW_LINK_DURATION_KEYS.map((key) => <option key={key} value={key}>{PREVIEW_LINK_DURATIONS[key].label}</option>)}
              </select>
            </label>
          </div>
          <Button onClick={() => void create()} disabled={busy}>{busy ? "Working…" : "Create link"}</Button>

          {address && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <label className="block text-sm font-medium text-emerald-950">
                Your link
                <input readOnly value={address} onFocus={(e) => e.target.select()} className={field} />
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button variant="secondary" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button>
                <p className="min-w-0 flex-1 basis-48 text-xs leading-5 text-emerald-950">Copy it now: it cannot be shown again.</p>
              </div>
            </div>
          )}

          <div className="border-t border-slate-200 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">Open links</h3>
            {links === null && !error && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
            {links?.length === 0 && <p className="mt-2 text-sm text-slate-600">None right now.</p>}
            {links && links.length > 0 && (
              <ul className="mt-1 divide-y divide-slate-100">
                {links.map((link) => (
                  <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900">{link.scope === "site" ? "Whole website" : link.pageTitle ?? "A deleted page"}</p>
                      <p className="text-xs text-slate-500">Ends {when(link.expiresAt)}</p>
                    </div>
                    <Button variant="ghost" className="!text-red-700 hover:!bg-red-50" disabled={busy} onClick={() => void revoke(link)}>Turn off</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
