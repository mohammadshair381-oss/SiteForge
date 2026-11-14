"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill, cardClass } from "@/components/ui/Surface";
import { useToastHelpers } from "@/components/ui/Toast";
import type { PendingItem } from "@/lib/website-publish";
import ManagementPageHeader from "./ManagementPageHeader";
import PreviewLinksDialog from "./PreviewLinksDialog";

/**
 * Everything that differs between the drafts and the live website, in one place.
 * The owner chooses what goes live. Items that are not ready say why and link to
 * where they are fixed.
 */
export default function PublishCenter({
  businessId,
  storeLive,
  initialItems,
  draftPages,
}: {
  businessId: string;
  storeLive: boolean;
  initialItems: PendingItem[];
  draftPages: PendingItem[];
}) {
  const router = useRouter();
  const { success, error: showError } = useToastHelpers();
  const ready = useMemo(() => initialItems.filter((item) => !item.blocked).map((item) => item.key), [initialItems]);
  const [chosen, setChosen] = useState<Set<string>>(new Set(ready));
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Array<{ key: string; error: string }>>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const base = `/dashboard/businesses/${businessId}`;
  const names = new Map([...initialItems, ...draftPages].map((item) => [item.key, item.label]));

  const toggle = (key: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  async function publish() {
    const count = chosen.size;
    if (!(await confirmDialog({ title: `Publish ${count} ${count === 1 ? "change" : "changes"}?`, message: storeLive ? "Visitors see them right away." : "They go live when your store is published.", confirmLabel: "Publish" }))) return;
    setBusy(true);
    setFailures([]);
    try {
      const res = await fetch(`/api/businesses/${businessId}/website/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: [...chosen] }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Nothing was published.");
      setFailures(data.failed ?? []);
      if ((data.published ?? []).length > 0) success("Published", `${data.published.length} ${data.published.length === 1 ? "change is" : "changes are"} live.`);
      router.refresh();
    } catch (error) {
      showError("Publish failed", error instanceof Error ? error.message : "Nothing was published.");
    } finally {
      setBusy(false);
    }
  }

  const row = (item: PendingItem) => (
    <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <label className={`flex min-w-0 flex-1 basis-56 items-start gap-3 ${item.blocked ? "" : "cursor-pointer"}`}>
        <input type="checkbox" checked={chosen.has(item.key)} disabled={Boolean(item.blocked) || busy} onChange={(e) => toggle(item.key, e.target.checked)} className="mt-1 h-4 w-4 rounded" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-slate-900">{item.label}</span>
          <span className="block break-words text-xs leading-5 text-slate-500">{item.blocked ?? item.detail}</span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        {item.blocked && <Pill tone="warning">Not ready</Pill>}
        <Link href={`${base}/${item.edit}`} className="inline-flex min-h-10 items-center rounded-lg px-2.5 text-sm font-medium text-slate-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          Open
        </Link>
      </div>
    </li>
  );

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Publish"
        description="Everything you have changed since you last published. Nothing goes live until you choose it here or in the editor."
        actions={<Button variant="secondary" onClick={() => setShareOpen(true)}>Share a draft preview</Button>}
      />
      {shareOpen && <PreviewLinksDialog businessId={businessId} onClose={() => setShareOpen(false)} />}

      {!storeLive && (
        <Notice tone="info" title="Your store is not published yet">
          You can publish changes here, and visitors see them once your store goes live from the <Link className="font-medium underline underline-offset-2" href={base}>overview</Link>.
        </Notice>
      )}

      {failures.length > 0 && (
        <Notice tone="danger" role="alert" title="Some changes were not published">
          <ul className="mt-1 list-disc pl-4">
            {failures.map((failure) => <li key={failure.key}>{names.get(failure.key) ?? failure.key}: {failure.error}</li>)}
          </ul>
        </Notice>
      )}

      <section aria-labelledby="pending-title" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
          <h2 id="pending-title" className="text-base font-semibold text-slate-900">Waiting to go live</h2>
          {initialItems.length > 0 && (
            <Button onClick={() => void publish()} disabled={busy || chosen.size === 0}>
              {busy ? "Publishing…" : `Publish ${chosen.size || ""}`.trim()}
            </Button>
          )}
        </div>
        {initialItems.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-8 text-sm text-slate-600 sm:px-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><Icon name="check" size={18} /></span>
            Your live website matches your drafts. There is nothing to publish.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">{initialItems.map(row)}</ul>
        )}
      </section>

      {draftPages.length > 0 && (
        <section aria-labelledby="draft-pages-title" className={cardClass}>
          <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
            <h2 id="draft-pages-title" className="text-base font-semibold text-slate-900">Pages not published yet</h2>
            <p className="mt-1 text-sm text-slate-600">Tick a page to publish it with the rest. A published page also needs a menu link if visitors should find it.</p>
          </div>
          <ul className="divide-y divide-slate-100">{draftPages.map(row)}</ul>
          {draftPages.some((page) => chosen.has(page.key)) && initialItems.length === 0 && (
            <div className="border-t border-slate-200 p-4 sm:px-5">
              <Button onClick={() => void publish()} disabled={busy}>{busy ? "Publishing…" : `Publish ${chosen.size}`}</Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
