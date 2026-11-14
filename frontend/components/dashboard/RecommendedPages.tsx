"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { DefaultPagesPreview } from "@/lib/page-generation";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { Notice, Pill, Skeleton } from "@/components/ui/Surface";

/**
 * Recommended pages for this business (type + real store data): what would
 * be prepared and why, what already exists (never touched), and what was
 * skipped. "Prepare" creates the missing pages as DRAFTS; nothing is
 * published. Used on the Pages screen and in the setup wizard.
 */
export default function RecommendedPages({ businessId, canManage, compact = false }: { businessId: string; canManage: boolean; compact?: boolean }) {
  const router = useRouter();
  const [plan, setPlan] = useState<DefaultPagesPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(!compact);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/defaults`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Recommended pages could not be loaded.");
      setPlan(data.plan as DefaultPagesPreview);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Recommended pages could not be loaded.");
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function prepare(keys?: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/defaults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(keys ? { keys } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The pages could not be prepared.");
      const created = (data.result?.created ?? []) as Array<{ title: string }>;
      const omitted = (data.result?.omitted ?? []) as Array<{ title: string }>;
      const madeText = created.length === 0 ? "" : `Prepared as drafts: ${created.map((page) => page.title).join(", ")}. Review and edit them, then publish each one when it is ready.`;
      const omittedText = omitted.length === 0 ? "" : `Not created, because your plan has no more room for pages: ${omitted.map((page) => page.title).join(", ")}. Nothing else changed, and you can prepare them after upgrading.`;
      setMessage({
        ok: created.length > 0 || omitted.length === 0,
        text: [madeText, omittedText].filter(Boolean).join(" ") || "Nothing new to prepare: every recommended page already exists.",
      });
      await load();
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was created." });
    } finally {
      setBusy(false);
    }
  }

  const missing = plan?.pages.filter((p) => p.status === "new") ?? [];
  const overLimit = plan?.pages.filter((p) => p.status === "over_limit") ?? [];

  return (
    <section aria-labelledby="recommended-pages-title" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 id="recommended-pages-title" className="text-lg font-semibold text-slate-900">Recommended pages</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            {plan ? `Suggested for a ${plan.familyLabel.toLowerCase()} store, ` : "Suggested "}
            from your business details and products. Pages are prepared as drafts in your current theme; text we cannot know is marked [[like this]] for you to replace, and nothing is published until you publish it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {compact && (
            <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              {open ? "Hide list" : "Show list"}
            </Button>
          )}
          {canManage && missing.length > 0 && (
            <Button disabled={busy} onClick={() => void prepare()}>
              {busy ? "Preparing…" : `Prepare ${missing.length} ${missing.length === 1 ? "page" : "pages"}`}
            </Button>
          )}
        </div>
      </div>
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"} className="mt-4">
          {message.text}
        </Notice>
      )}
      {loadError && <Notice tone="danger" role="alert" className="mt-4">{loadError}</Notice>}
      {plan && overLimit.length > 0 && (
        <Notice tone="info" className="mt-4" title={plan.allowance.remaining === 0 ? "Your plan has no more room for pages" : `Your plan has room for ${plan.allowance.remaining} more ${plan.allowance.remaining === 1 ? "page" : "pages"}`}>
          It includes {plan.allowance.limit} {plan.allowance.limit === 1 ? "page" : "pages"} besides your homepage, and you have {plan.allowance.used}. The most essential pages are prepared first. These wait until you have room: {overLimit.map((page) => page.title).join(", ")}.{" "}
          <a href={`/dashboard/businesses/${businessId}/billing`} className={`rounded font-medium underline underline-offset-2 ${focus}`}>See plans</a>
        </Notice>
      )}
      {!plan && !loadError && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      )}
      {plan && open && (
        <>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Recommended pages">
            {plan.pages.map((page) => (
              <li key={page.key} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {page.title} <span className="text-xs font-normal text-slate-500">/{page.slug}</span>
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-slate-600">{page.reason}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {page.nav === "header" ? "Header link" : page.nav === "footer" ? "Footer link" : "Not linked"}
                    {page.needsReview ? " · Policy template: review before publishing" : ""}
                  </p>
                </div>
                {page.status === "exists" ? (
                  <Pill className="shrink-0">Already exists</Pill>
                ) : page.status === "over_limit" ? (
                  <Pill tone="warning" className="shrink-0">Over plan limit</Pill>
                ) : canManage ? (
                  <Button variant="secondary" className="shrink-0" disabled={busy} onClick={() => void prepare([page.key])}>
                    Prepare<span className="sr-only"> {page.title}</span>
                  </Button>
                ) : (
                  <Pill tone="warning" className="shrink-0">Not yet</Pill>
                )}
              </li>
            ))}
          </ul>
          {plan.skipped.length > 0 && (
            <details className="mt-3 text-sm text-slate-600">
              <summary className={`min-h-10 cursor-pointer rounded py-1 font-medium ${focus}`}>Not suggested yet ({plan.skipped.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {plan.skipped.map((item) => (
                  <li key={item.key}>
                    <span className="font-medium">{item.title}:</span> {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Prefer AI-written drafts? The <a href={`/dashboard/businesses/${businessId}/ai-builder`} className={`rounded font-medium text-slate-800 underline underline-offset-2 ${focus}`}>AI Builder</a> can write page content for your review when AI is turned on for your store.
          </p>
        </>
      )}
    </section>
  );
}
