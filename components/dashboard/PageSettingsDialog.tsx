"use client";

import { useEffect, useRef, useState } from "react";
import { apiErrorFrom, fieldErrorId, invalidProps, summaryMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";
import { suggestPageSeo } from "@/lib/page-seo-defaults";
import MediaPicker from "./MediaPicker";

const TITLE_MAX = 160;
const DESCRIPTION_MAX = 320;
const input = "mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
const label = "block text-sm font-medium text-slate-800";
const hint = "mt-1.5 text-xs leading-5 text-slate-500";

export interface PageSettingsTarget {
  _id: string;
  title: string;
  slug: string;
  status: "draft" | "published";
  isHome: boolean;
  version: number;
  seoTitle?: string;
  seoDescription?: string;
  seoImage?: string;
  noindex?: boolean;
  canonicalUrl?: string;
}

/**
 * A page's name, web address and search settings. Saving changes the draft:
 * search text goes live when the page is published. The name and address apply
 * straight away, and a published page's old address keeps working as a redirect.
 */
export default function PageSettingsDialog({
  businessId,
  page,
  businessName,
  siteAddress,
  sections,
  onClose,
  onSaved,
}: {
  businessId: string;
  page: PageSettingsTarget;
  businessName: string;
  /** The store's address, for the search preview. */
  siteAddress?: string;
  /** The page's sections, to suggest search text from. */
  sections?: unknown;
  onClose: () => void;
  onSaved: (page: PageSettingsTarget) => void;
}) {
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [seoTitle, setSeoTitle] = useState(page.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(page.seoDescription ?? "");
  const [seoImage, setSeoImage] = useState(page.seoImage ?? "");
  const [noindex, setNoindex] = useState(Boolean(page.noindex));
  const [canonicalUrl, setCanonicalUrl] = useState(page.canonicalUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const address = slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const previewTitle = seoTitle.trim() || (page.isHome ? businessName : `${title.trim() || page.title} | ${businessName}`);
  const addressChanges = address !== page.slug;
  const suggestion = suggestPageSeo({ title, isHome: page.isHome, businessName, sections });
  const fillFromPage = () => {
    if (!seoTitle.trim()) setSeoTitle(suggestion.seoTitle);
    if (!seoDescription.trim() && suggestion.seoDescription) setSeoDescription(suggestion.seoDescription);
    if (!seoImage && suggestion.seoImage) setSeoImage(suggestion.seoImage);
  };

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/businesses/${businessId}/pages/${page._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ...(page.isHome ? {} : { slug: address }), seoTitle, seoDescription, seoImage, noindex, ...(canonicalUrl !== (page.canonicalUrl ?? "") ? { canonicalUrl } : {}), expectedVersion: page.version }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.code === "version_conflict") throw new Error("This page changed elsewhere. Close this window, reload the page and try again.");
        const info = apiErrorFrom(data, "These settings could not be saved.");
        // A taken or invalid address is reported by code rather than by field.
        const fields = data.code === "slug_taken" || data.code === "invalid_slug" ? { ...info.fields, slug: info.message } : info.fields;
        setFieldErrors(fields);
        throw new Error(summaryMessage({ ...info, fields }, ["title", "slug", "seoTitle", "seoDescription", "seoImage", "canonicalUrl"]));
      }
      onSaved(data.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "These settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ui-fade fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="page-settings-title">
      <div className="ui-pop my-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-lg">
        <h2 id="page-settings-title" className="text-lg font-semibold text-slate-900">Page settings</h2>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="mt-4 space-y-4">
          <div>
            <label htmlFor="ps-title" className={label}>Page name</label>
            <input ref={firstRef} id="ps-title" required maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} className={input} {...invalidProps(fieldErrors, "title", "page-settings")} />
            <FieldError id={fieldErrorId("page-settings", "title")} message={fieldErrors.title} />
          </div>
          {!page.isHome && (
            <div>
              <label htmlFor="ps-slug" className={label}>Web address</label>
              <input id="ps-slug" required maxLength={80} value={slug} onChange={(e) => setSlug(e.target.value)} className={input} {...invalidProps(fieldErrors, "slug", "page-settings")} />
              <FieldError id={fieldErrorId("page-settings", "slug")} message={fieldErrors.slug} />
              <p className={hint}>
                /{address || "…"}
                {addressChanges && page.status === "published" && " · The old address keeps working and sends visitors here."}
              </p>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 p-3" aria-hidden="true">
            <p className="text-xs font-medium text-slate-500">How it may look in search results</p>
            <p className="mt-2 truncate text-xs text-slate-600">{siteAddress ?? "your-store"}{page.isHome ? "" : ` › ${address}`}</p>
            <p className="truncate text-base text-[#1a0dab]">{previewTitle}</p>
            <p className="line-clamp-2 text-sm leading-5 text-slate-600">{seoDescription.trim() || "A short summary of this page appears here. Without one, search engines choose their own."}</p>
          </div>

          {sections !== undefined && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
              <p className="min-w-0 flex-1 basis-48 text-xs leading-5 text-slate-600">Fill the empty fields below from this page&apos;s own content. You can change anything afterwards.</p>
              <Button variant="secondary" onClick={fillFromPage}>Suggest from this page</Button>
            </div>
          )}

          <div>
            <label htmlFor="ps-seo-title" className={label}>Search title</label>
            <input id="ps-seo-title" value={seoTitle} maxLength={TITLE_MAX} onChange={(e) => setSeoTitle(e.target.value)} placeholder={previewTitle} className={input} {...invalidProps(fieldErrors, "seoTitle", "page-settings")} />
            <FieldError id={fieldErrorId("page-settings", "seoTitle")} message={fieldErrors.seoTitle} />
            <p className={hint}>{seoTitle.length}/{TITLE_MAX} characters. Around 50 to 60 shows fully.</p>
          </div>
          <div>
            <label htmlFor="ps-seo-desc" className={label}>Search description</label>
            <textarea id="ps-seo-desc" rows={3} value={seoDescription} maxLength={DESCRIPTION_MAX} onChange={(e) => setSeoDescription(e.target.value)} className={input} {...invalidProps(fieldErrors, "seoDescription", "page-settings")} />
            <FieldError id={fieldErrorId("page-settings", "seoDescription")} message={fieldErrors.seoDescription} />
            <p className={hint}>{seoDescription.length}/{DESCRIPTION_MAX} characters. Around 150 to 160 shows fully.</p>
          </div>
          <div>
            <p className={label}>Picture when shared</p>
            <div className="mt-1 flex items-center gap-3">
              {seoImage && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={seoImage} alt="" className="h-14 w-24 shrink-0 rounded-lg border border-slate-200 object-cover" />
              )}
              <MediaPicker businessId={businessId} selectedUrl={seoImage} allowClear contextLabel="sharing picture" onSelect={(media) => setSeoImage(media?.url ?? "")} />
            </div>
            <FieldError message={fieldErrors.seoImage} />
            <div className="mt-2 overflow-hidden rounded-xl border border-slate-200" aria-hidden="true">
              <p className="px-3 pt-2 text-xs font-medium text-slate-500">How it may look when shared</p>
              <div className="mt-2 flex items-center gap-3 border-t border-slate-200 bg-slate-50 p-3">
                {(seoImage || suggestion.seoImage) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={seoImage || suggestion.seoImage} alt="" className="h-14 w-24 shrink-0 rounded object-cover" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{previewTitle}</p>
                  <p className="line-clamp-2 text-xs text-slate-600">{seoDescription.trim() || suggestion.seoDescription || "A short summary appears here."}</p>
                </div>
              </div>
            </div>
          </div>
          <label className="flex min-h-10 cursor-pointer items-start gap-2.5 text-sm text-slate-800">
            <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} className="mt-0.5 h-4 w-4 rounded" />
            <span>
              Hide from search engines
              <span className="block text-xs text-slate-500">People with the link can still open the page.</span>
            </span>
          </label>
          <details className="rounded-xl border border-slate-200 p-3">
            <summary className="min-h-6 cursor-pointer text-sm font-medium text-slate-800">Original address (advanced)</summary>
            <label htmlFor="ps-canonical" className={`${label} mt-3`}>Original address of this page</label>
            <input id="ps-canonical" type="url" maxLength={500} value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://" className={input} {...invalidProps(fieldErrors, "canonicalUrl", "page-settings")} />
            <FieldError id={fieldErrorId("page-settings", "canonicalUrl")} message={fieldErrors.canonicalUrl} />
            <p className={hint}>Only if this page repeats content that first appeared elsewhere. Leave it empty to use this page&apos;s own address.</p>
          </details>
          <p className={hint}>Published pages also tell search engines their name, address, description and any questions and answers they show. Nothing here can guarantee how a page appears or ranks in search results.</p>

          <p className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
            {page.status === "published" ? "The name and address change right away. Search settings go live the next time you publish this page." : "This page is a draft, so nothing here is visible until you publish it."}
          </p>
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || !title.trim() || (!page.isHome && !address)}>{saving ? "Saving…" : "Save settings"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
