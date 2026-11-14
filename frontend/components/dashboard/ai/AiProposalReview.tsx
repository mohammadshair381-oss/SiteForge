"use client";

import { useMemo, useState } from "react";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";
import { getVisibleSections, type Section } from "@/lib/sections";
import type { StorefrontConfig } from "@/lib/storefront-config";
import type { StorefrontView } from "@/lib/storefront";
import { THEME_IDS } from "@/lib/constants";
import { getThemeMeta } from "@/lib/themes";
import { CLASSIC_PREVIEW_ID, type WebsitePreview } from "@/lib/ai-website/blueprint";
import { websitePreviewExtras, websitePreviewSections, websitePreviewView } from "@/lib/ai-website/preview";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Eyebrow, Notice, Pill } from "@/components/ui/Surface";
import PreviewFrame from "../editor/PreviewFrame";
import DeviceSwitch from "../editor/DeviceSwitch";
import type { EditorDevice } from "../editor/EditorToolbar";
import { AI_STATUS, AiNotes, AiPromises, ChangeDiff } from "./AiShared";

interface PageChange {
  actionId: string;
  kind: string;
  pageId: string;
  sectionId?: string;
  slug?: string;
  title?: string;
}
interface StorefrontRow {
  label: string;
  before: string;
  after: string;
  live: boolean;
}

export interface AiProposalDetail {
  id: string;
  source: string;
  target: string;
  request: string;
  notes?: string[];
  summary: string;
  status: string;
  failureCode: string | null;
  stale: boolean;
  /** Whole-website proposals: what changed since, in the owner's words. */
  staleItems?: string[];
  diff: { changes: Array<PageChange | StorefrontRow>; live?: boolean; summary?: { added?: number; modified?: number; removed?: number } };
  /** Homepage proposals: the proposed config and brand; page proposals: the proposed pages. */
  preview: {
    pages?: Array<{ id: string; title: string; slug: string; sections?: unknown[] }>;
    config?: StorefrontConfig;
    brand?: { primaryColor: string; accentColor: string; font: string };
  };
  appliedPages?: Array<{ id: string; title: string; slug: string }>;
}

const CHANGE_TEXT: Record<string, string> = {
  "create-page": "New draft page",
  "update-section": "Change section",
  "add-section": "Add section",
  "remove-section": "Remove section",
  "reorder-sections": "Move section",
};

/** The store's own draft data, for rendering a proposal with the real storefront renderer. */
export interface AiPreviewData {
  view: StorefrontView;
  config: StorefrontConfig;
  extras: CommerceExtras;
}

/** One proposal in the store's theme: the same renderer as the store, nothing saved. */
function ProposalPreview({ data, detail, device }: { data: AiPreviewData; detail: AiProposalDetail; device: EditorDevice }) {
  const [pageIndex, setPageIndex] = useState(0);
  const pages = detail.preview.pages ?? [];
  const page = pages[pageIndex] ?? pages[0];
  const sections = useMemo(() => (page ? getVisibleSections((page.sections ?? []) as Section[]) : []), [page]);
  const view = useMemo<StorefrontView>(() => {
    const brand = detail.preview.brand;
    const theme = brand ? { ...data.view.theme, primaryColor: brand.primaryColor, accentColor: brand.accentColor, font: brand.font as StorefrontView["theme"]["font"] } : data.view.theme;
    return { ...data.view, theme: sections.length > 0 ? { ...theme, sections } : theme };
  }, [data.view, detail.preview.brand, sections]);
  const commerce = useMemo(() => buildCommerceData(view, detail.preview.config ?? data.config, data.extras), [view, detail.preview.config, data.config, data.extras]);
  return (
    <>
      {pages.length > 1 && (
        <label className="mb-2 block text-xs font-medium text-slate-700">
          Page to preview
          <select value={pageIndex} onChange={(e) => setPageIndex(Number(e.target.value))} className={`ml-2 min-h-10 rounded-lg border px-2 py-1 text-sm ${focus}`}>
            {pages.map((p, i) => (
              <option key={p.id} value={i}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="ui-dots-ink h-[28rem] rounded-xl border border-slate-200 bg-slate-100 p-2 sm:p-3">
        <PreviewFrame device={device} title="Preview of this suggestion">
          <ThemeRenderer view={view} productHrefBase="#" preview commerce={commerce} sections={sections.length > 0 ? sections : undefined} />
        </PreviewFrame>
      </div>
    </>
  );
}

/** A whole website in the real renderer: the homepage and every page, in any theme. Nothing is saved. */
function WebsiteProposalPreview({ data, detail, device }: { data: AiPreviewData; detail: AiProposalDetail; device: EditorDevice }) {
  const preview = detail.preview as unknown as WebsitePreview;
  const [pageId, setPageId] = useState("");
  const [themeId, setThemeId] = useState("");
  const sections = useMemo(() => websitePreviewSections(preview, pageId), [preview, pageId]);
  const view = useMemo<StorefrontView>(() => {
    const base = websitePreviewView(data.view, preview, themeId || null);
    return sections.length > 0 ? { ...base, theme: { ...base.theme, sections } } : base;
  }, [data.view, preview, themeId, sections]);
  const commerce = useMemo(() => buildCommerceData(view, preview.config, websitePreviewExtras(data.extras, preview)), [view, preview, data.extras]);
  const control = `ml-2 min-h-10 max-w-full rounded-lg border px-2 py-1 text-sm ${focus}`;
  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="text-xs font-medium text-slate-700">
          Page
          <select value={pageId} onChange={(e) => setPageId(e.target.value)} className={control}>
            <option value="">{preview.classicHomepage ? "Homepage (once you publish it)" : "Homepage"}</option>
            {preview.classicHomepage && <option value={CLASSIC_PREVIEW_ID}>Your custom homepage (what visitors see now)</option>}
            {preview.pages.map((page) => <option key={page.id} value={page.id}>{page.title}{page.proposed ? " (in this proposal)" : ""}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-700">
          Look at it in
          <select value={themeId} onChange={(e) => setThemeId(e.target.value)} className={control}>
            <option value="">The proposed theme ({getThemeMeta(preview.design.themeId).name})</option>
            {THEME_IDS.filter((id) => id !== preview.design.themeId).map((id) => <option key={id} value={id}>{getThemeMeta(id).name}</option>)}
          </select>
        </label>
      </div>
      {preview.classicHomepage && !pageId && <p className="mb-2 text-xs text-slate-500">This is the proposed homepage. Visitors keep seeing your custom homepage until you publish this one from the website editor.</p>}
      {themeId && <p className="mb-2 text-xs text-slate-500">Only for looking: applying keeps the proposed theme. Ask the assistant to change it, and your plan decides which themes can be used.</p>}
      <div className="ui-dots-ink h-[32rem] rounded-xl border border-slate-200 bg-slate-100 p-2 sm:p-3">
        <PreviewFrame device={device} title="Preview of this website">
          <ThemeRenderer view={view} productHrefBase="#" preview commerce={commerce} sections={sections.length > 0 ? sections : undefined} />
        </PreviewFrame>
      </div>
    </>
  );
}

/**
 * Reviews one AI proposal: what it changes, a live preview (the real storefront
 * renderer in the store's theme, in `PreviewFrame` like every dashboard preview),
 * and the owner's controls. Applying is approve + apply
 * on the existing proposal routes (they re-check role, staleness and data);
 * it reaches DRAFTS only, and publishing stays separate.
 */
export default function AiProposalReview({
  businessId,
  detail,
  notes,
  dirty,
  previewData,
  onChanged,
  onApplied,
  onEditRequest,
  onTryAgain,
  onRegenerate,
}: {
  businessId: string;
  detail: AiProposalDetail;
  notes: string[];
  dirty: boolean;
  /** The store's draft data for the inline preview (the full-page preview is always linked). */
  previewData?: AiPreviewData | null;
  onChanged: (id: string) => Promise<void>;
  onApplied?: () => void;
  onEditRequest: () => void;
  onTryAgain?: () => void;
  /** Whole-website proposals: ask the assistant again, when refreshing cannot help. */
  onRegenerate?: () => void;
}) {
  const [busy, setBusy] = useState<"apply" | "reject" | "refresh" | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const [showPreview, setShowPreview] = useState(true);
  const isHomepage = detail.target === "storefront";
  const isWebsite = detail.target === "website";
  const classicHomepage = isWebsite ? ((detail.preview as unknown as WebsitePreview).classicHomepage ?? null) : null;
  const reviewable = detail.status === "pending" || detail.status === "approved";
  const refreshable = isWebsite && detail.status === "failed" && detail.failureCode === "version_conflict";
  const allNotes = [...new Set([...(detail.notes ?? []), ...notes])];
  const previewPage = detail.preview?.pages?.[0];
  const previewSrc = `/dashboard/businesses/${businessId}/preview?proposal=${detail.id}${previewPage && !isWebsite ? `&page=${encodeURIComponent(previewPage.id)}` : ""}`;
  const base = `/api/businesses/${businessId}/proposals/${detail.id}`;
  const json = { "Content-Type": "application/json" };

  async function review(decision: "approve" | "reject") {
    const res = await fetch(`${base}/review`, { method: "POST", headers: json, body: JSON.stringify({ decision }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "The suggestion could not be reviewed.");
  }

  /** Brings a stale proposal up to date. Free, and newer edits always stay. */
  async function refresh() {
    setBusy("refresh");
    setMessage(null);
    setConflicts([]);
    try {
      const res = await fetch(`${base}/refresh`, { method: "POST", headers: json, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "This proposal could not be refreshed.");
      if (data.proposal) {
        await onChanged(data.proposal.id);
        return;
      }
      if (data.unchanged) setMessage({ ok: true, text: "Your drafts already hold everything in this proposal, so there is nothing to apply." });
      else setConflicts(data.conflicts ?? []);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing was changed." });
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    const classicNote = classicHomepage ? "\n\nVisitors keep seeing your custom homepage until you publish the new one from the website editor." : "";
    const note = `${detail.diff.live ? "\n\nColour and font changes go to your design draft, and reach your whole store when you publish them." : ""}${classicNote}`;
    if (!(await confirmDialog({ title: "Apply this suggestion to your draft?", message: `Your live store does not change until you publish.${note}`, confirmLabel: "Apply to draft" }))) return;
    setBusy("apply");
    setMessage(null);
    try {
      if (detail.status === "pending") await review("approve");
      const res = await fetch(`${base}/apply`, { method: "POST", headers: json, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The suggestion could not be applied.");
      await onChanged(detail.id);
      onApplied?.();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing was applied." });
      await onChanged(detail.id).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setMessage(null);
    try {
      await review("reject");
      await onChanged(detail.id);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error." });
    } finally {
      setBusy(null);
    }
  }

  const status = AI_STATUS[detail.status];

  return (
    <div className="space-y-5" data-ai-proposal={detail.id}>
      <div>
        {detail.request && <p className="mb-2 text-xs text-slate-500">You asked: “{detail.request}”</p>}
        <Eyebrow>Here is what I understood</Eyebrow>
        <p className="mt-1 text-base font-semibold leading-6 text-slate-900">{detail.summary}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <Pill tone={status?.tone ?? "neutral"}>{status?.text ?? detail.status}</Pill>
          Suggested by the AI assistant · {isHomepage ? "Homepage" : "Pages"}
          {detail.failureCode ? " · It could not be applied." : ""}
        </p>
      </div>

      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      {detail.stale && (reviewable || refreshable) && (
        <div role="note">
          {isWebsite ? (
            <Notice
              tone="warning"
              title="Your website has changed since this proposal was made"
              action={
                <span className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={busy !== null} onClick={() => void refresh()}>{busy === "refresh" ? "Refreshing…" : "Refresh this proposal"}</Button>
                  {onRegenerate && <Button variant="ghost" disabled={busy !== null} onClick={onRegenerate}>Ask the assistant again</Button>}
                </span>
              }
            >
              {(detail.staleItems?.length ?? 0) > 0 ? `Changed since: ${detail.staleItems?.join(", ")}. ` : ""}Your newer edits are safe: this proposal cannot overwrite them, and it can&apos;t be applied as it is. Refreshing keeps your edits and adds what does not overlap, for free. Asking again uses an AI request.
            </Notice>
          ) : (
            <Notice tone="warning">
              {isHomepage ? "Your homepage" : "This page"} changed after this suggestion was made, so it can no longer be applied and nothing of yours is overwritten. Try again for a fresh one.
            </Notice>
          )}
          {conflicts.length > 0 && (
            <div className="mt-2">
              <Notice tone="warning" role="alert" title="This could not be refreshed">
                Both this proposal and your newer edits changed {conflicts.join(", ")}. Your edits are kept and nothing was changed. Ask the assistant again to build on them.
              </Notice>
            </div>
          )}
        </div>
      )}
      {classicHomepage && reviewable && (
        <div role="note">
          <Notice tone="info" title="Your custom homepage stays live">
            Your store shows an older custom homepage. Approving keeps it exactly as it is and saves the new homepage to your draft. Visitors see the new one only when you publish it from the website editor, which asks you first.
          </Notice>
        </div>
      )}
      {detail.diff.live && (
        <div role="note">
          <Notice tone="warning">Includes colour or font changes: these go to your design draft, and reach your whole store when you publish them.</Notice>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">What will change</h3>
        {isWebsite && detail.diff.summary && (
          <p className="mb-2 text-xs text-slate-600">{detail.diff.summary.added ?? 0} added, {detail.diff.summary.modified ?? 0} changed, {detail.diff.summary.removed ?? 0} removed. Approving applies all of it, or none of it if anything has changed.</p>
        )}
        {isHomepage || isWebsite ? (
          <ChangeDiff rows={detail.diff.changes as StorefrontRow[]} caption="Changes in this suggestion" />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm" aria-label="Changes in this suggestion">
            {(detail.diff.changes as PageChange[]).map((change) => (
              <li key={change.actionId} className="px-3 py-2.5">
                <span className="font-medium text-slate-900">{CHANGE_TEXT[change.kind] ?? change.kind}</span>{" "}
                <span className="text-slate-600">{change.kind === "create-page" ? `“${change.title}” at /${change.slug}` : change.sectionId}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AiNotes notes={allNotes} />
      {!isHomepage && reviewable && (
        <p className="text-xs leading-5 text-slate-600">Text we could not know appears as [[placeholders]]: replace them in the editor. A page with placeholders cannot be published.</p>
      )}

      <div className="space-y-2.5 rounded-xl bg-slate-50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {reviewable && (
            <>
              <Button disabled={busy !== null || detail.stale || dirty} onClick={() => void apply()}>
                {busy === "apply" ? "Applying…" : "Apply to draft"}
              </Button>
              <Button variant="secondary" disabled={busy !== null} onClick={() => void reject()}>
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </Button>
            </>
          )}
          <Button variant="secondary" disabled={busy !== null} onClick={onEditRequest}>Edit request</Button>
          {onTryAgain && (
            <Button variant="secondary" disabled={busy !== null} onClick={onTryAgain}>Try again</Button>
          )}
          {reviewable && dirty && <span className="text-xs text-amber-800">Save or discard your unsaved changes first.</span>}
        </div>
        {reviewable && <AiPromises />}
      </div>

      {detail.status === "applied" && (
        <Notice tone="success" role="status" title="Applied to your draft. Nothing is published yet.">
          {(detail.appliedPages ?? []).slice(0, 1).map((page) => (
            <a key={page.id} href={`/dashboard/businesses/${businessId}/editor?page=${encodeURIComponent(page.id)}`} className={`rounded font-medium underline underline-offset-2 ${focus}`}>Open “{page.title}” in the editor</a>
          ))}
          {(isHomepage || isWebsite) && (
            <a href={`/dashboard/businesses/${businessId}/editor${classicHomepage ? "?mode=store" : ""}`} className={`rounded font-medium underline underline-offset-2 ${focus}`}>{classicHomepage ? "Open the new homepage in the website editor" : "Open the website editor"}</a>
          )}
        </Notice>
      )}
      {detail.status === "rejected" && (
        <p role="status" className="rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-800">Rejected. Nothing was changed.</p>
      )}

      {reviewable && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">Preview</h3>
            <div className="flex flex-wrap items-center gap-2">
              <DeviceSwitch device={device} onChange={setDevice} />
              <Button variant="ghost" aria-pressed={showPreview} onClick={() => setShowPreview((v) => !v)}>
                {showPreview ? "Hide" : "Show"}
              </Button>
            </div>
          </div>
          {showPreview && previewData && (
            <div className="mt-2">
              {isWebsite ? <WebsiteProposalPreview data={previewData} detail={detail} device={device} /> : <ProposalPreview data={previewData} detail={detail} device={device} />}
            </div>
          )}
          <p className="mt-1.5 text-xs text-slate-500">
            Your store&apos;s theme with this suggestion. Not saved and not published.{" "}
            <a href={previewSrc} target="_blank" rel="noopener noreferrer" className={`rounded font-medium text-slate-800 underline underline-offset-2 ${focus}`}>
              Open the full preview
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
