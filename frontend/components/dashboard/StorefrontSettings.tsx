"use client";

import Link from "next/link";
import { useId, useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { Button, buttonClass, focusRing as focus } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Surface";
import { SOCIAL_NETWORKS, type StorefrontConfig } from "@/lib/storefront-config";
import { socialLabel } from "@/lib/storefront-home";

const input = `mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 ${focus}`;
const label = "block min-w-0 text-sm font-medium text-slate-800";
const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6";

interface LinkOption {
  label: string;
  href: string;
}

type Status = { kind: "idle" } | { kind: "busy"; text: string } | { kind: "ok"; text: string } | { kind: "error"; text: string };

/** The parts of the storefront settings this page owns. */
type StoreWideFields = {
  announcement: Pick<StorefrontConfig["announcement"], "enabled" | "text" | "href">;
  policies: StorefrontConfig["policies"];
  footer: Pick<StorefrontConfig["footer"], "about" | "copyright" | "social">;
};

/**
 * Store-wide storefront content: announcement bar, shipping/returns policy
 * text and the footer. The hero and the homepage sections are edited
 * visually in the Website editor; this page never overwrites them (it merges
 * its fields into the LATEST saved draft before saving). Saves a draft;
 * "Publish storefront" copies the saved draft to the public store.
 */
export default function StorefrontSettings({
  businessId,
  storeLive,
  initialDraft,
  hasPublished,
  initialHasUnpublishedChanges,
  linkOptions,
}: {
  businessId: string;
  storeLive: boolean;
  initialDraft: StorefrontConfig;
  hasPublished: boolean;
  initialHasUnpublishedChanges: boolean;
  linkOptions: LinkOption[];
}) {
  const [fields, setFields] = useState<StoreWideFields>(() => ({
    announcement: { enabled: initialDraft.announcement.enabled, text: initialDraft.announcement.text, href: initialDraft.announcement.href },
    policies: { ...initialDraft.policies },
    footer: { about: initialDraft.footer.about, copyright: initialDraft.footer.copyright, social: { ...initialDraft.footer.social } },
  }));
  const [dirty, setDirty] = useState(false);
  const [unpublished, setUnpublished] = useState(initialHasUnpublishedChanges || !hasPublished);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const linkListId = useId();
  const base = `/dashboard/businesses/${businessId}`;

  function update(mutator: (draft: StoreWideFields) => void) {
    setFields((current) => {
      const next = structuredClone(current);
      mutator(next);
      return next;
    });
    setDirty(true);
    setStatus({ kind: "idle" });
  }

  async function save(): Promise<boolean> {
    setStatus({ kind: "busy", text: "Saving draft…" });
    setFieldErrors({});
    try {
      // Merge into the latest draft so edits made in the Website editor
      // (hero, sections, footer layout and columns, bar colour) are kept.
      const latest = await fetch(`/api/businesses/${businessId}/storefront`, { cache: "no-store" });
      const latestData = await latest.json().catch(() => ({}));
      if (!latest.ok) throw new Error(latestData.error || "Could not load the current draft.");
      const res = await fetch(`/api/businesses/${businessId}/storefront`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(typeof latestData.draftVersion === "number" ? { "x-expected-version": String(latestData.draftVersion) } : {}) },
        body: JSON.stringify({
          ...latestData.draft,
          ...fields,
          announcement: { ...latestData.draft?.announcement, ...fields.announcement },
          footer: { ...latestData.draft?.footer, ...fields.footer },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Validation errors arrive as "path: message, path: message".
        const errors: Record<string, string> = {};
        if (data.code === "validation_error" && typeof data.error === "string") {
          for (const part of data.error.split(/, (?=[\w.]+: )/)) {
            const match = /^([\w.]+): (.+)$/.exec(part);
            if (match) errors[match[1]] = match[2];
          }
        }
        setFieldErrors(errors);
        setStatus({ kind: "error", text: data.error || "The draft could not be saved. Check the highlighted fields." });
        return false;
      }
      setDirty(false);
      setUnpublished(true);
      setStatus({ kind: "ok", text: "Draft saved. Open the preview to check it, then publish." });
      return true;
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Network error. Your changes were not saved." });
      return false;
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setStatus({ kind: "busy", text: "Publishing…" });
    try {
      const res = await fetch(`/api/businesses/${businessId}/storefront/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: "error", text: data.error || "The storefront could not be published." });
        return;
      }
      setUnpublished(false);
      setStatus({
        kind: "ok",
        text: storeLive ? "Published. Your live store now shows these settings." : "Published. They will show once your store itself is published.",
      });
    } catch {
      setStatus({ kind: "error", text: "Network error. Nothing was published." });
    }
  }

  const err = (path: string) =>
    fieldErrors[path] ? <p className="mt-1 text-xs text-red-700">{fieldErrors[path]}</p> : null;
  const busy = status.kind === "busy";

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Storefront"
        description="Store-wide content: the announcement bar, your shipping and returns policies, and the footer. Changes are saved as a draft; preview them, then publish."
        actions={
          <>
            <Link href={`${base}/editor`} className={buttonClass({ variant: "secondary" })}>
              Edit homepage in the Website editor
            </Link>
            <a href={`${base}/preview`} target="_blank" rel="noopener" className={buttonClass({ variant: "secondary" })}>
              Open preview<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </>
        }
      />

      <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
        The hero banner and the homepage sections (categories, featured products, best sellers, promotions…) are edited visually in the{" "}
        <Link href={`${base}/editor`} className={`rounded font-medium text-slate-900 underline underline-offset-2 ${focus}`}>Website editor</Link>.
      </p>

      <datalist id={linkListId}>
        {linkOptions.map((o) => (
          <option key={o.href} value={o.href}>{o.label}</option>
        ))}
      </datalist>

      <section className={card} aria-labelledby="sf-announcement">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 id="sf-announcement" className="text-base font-semibold text-slate-900">Announcement bar</h2>
          <label className="inline-flex min-h-10 cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" role="switch" checked={fields.announcement.enabled} onChange={(e) => update((d) => { d.announcement.enabled = e.target.checked; })} className="h-4 w-4" />
            Show announcement bar
          </label>
        </div>
        <p className="mt-1 text-sm text-slate-600">A short message across the top of every page of your store.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className={label}>
            Message
            <input value={fields.announcement.text} maxLength={140} onChange={(e) => update((d) => { d.announcement.text = e.target.value; })} placeholder="Free delivery on orders over ₹999" className={input} />
            {err("announcement.text")}
          </label>
          <label className={label}>
            Link (optional)
            <input list={linkListId} value={fields.announcement.href} onChange={(e) => update((d) => { d.announcement.href = e.target.value; })} placeholder="/products" className={input} />
            {err("announcement.href")}
          </label>
        </div>
      </section>

      <section className={card} aria-labelledby="sf-policies">
        <h2 id="sf-policies" className="text-base font-semibold text-slate-900">Shipping and returns policies</h2>
        <p className="mt-1 text-sm text-slate-600">Shown on the /policies page and linked from the footer and product pages.</p>
        <div className="mt-4 grid gap-4">
          <label className={label}>
            Shipping policy
            <textarea value={fields.policies.shipping} maxLength={4000} rows={4} onChange={(e) => update((d) => { d.policies.shipping = e.target.value; })} className={input} />
          </label>
          <label className={label}>
            Returns policy
            <textarea value={fields.policies.returns} maxLength={4000} rows={4} onChange={(e) => update((d) => { d.policies.returns = e.target.value; })} className={input} />
          </label>
        </div>
      </section>

      <section className={card} aria-labelledby="sf-footer">
        <h2 id="sf-footer" className="text-base font-semibold text-slate-900">Footer</h2>
        <p className="mt-1 text-sm text-slate-600">Contact details come from Business settings and page links from Navigation.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className={`${label} sm:col-span-2`}>
            Short description
            <textarea value={fields.footer.about} maxLength={400} rows={2} onChange={(e) => update((d) => { d.footer.about = e.target.value; })} className={input} />
          </label>
          <label className={`${label} sm:col-span-2`}>
            Copyright line (optional)
            <input value={fields.footer.copyright} maxLength={160} placeholder="The usual notice is used when empty" onChange={(e) => update((d) => { d.footer.copyright = e.target.value; })} className={input} />
          </label>
          {SOCIAL_NETWORKS.map((network) => (
            <label key={network} className={label}>
              {socialLabel(network)} profile
              <input type="url" value={fields.footer.social[network]} onChange={(e) => update((d) => { d.footer.social[network] = e.target.value; })} placeholder="https://" className={input} />
              {err(`footer.social.${network}`)}
            </label>
          ))}
        </div>
      </section>

      {/* Stays in reach while scrolling, inside the page's own column (also in the setup wizard). */}
      <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <div className="flex min-w-0 flex-1 basis-60 flex-wrap items-center gap-2">
          <Pill tone={status.kind === "error" ? "danger" : dirty || unpublished ? "warning" : "success"} dot>
            {dirty ? "Unsaved" : unpublished ? "Draft" : storeLive ? "Live" : "Published"}
          </Pill>
          <p role="status" aria-live="polite" className={`min-w-0 text-sm ${status.kind === "error" ? "text-red-700" : status.kind === "ok" ? "text-emerald-800" : "text-slate-600"}`}>
            {status.kind === "idle"
              ? dirty
                ? "You have unsaved changes."
                : unpublished
                  ? "Saved draft not published yet."
                  : "Everything is published."
              : status.text}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void save()} disabled={busy || !dirty}>
          Save draft
        </Button>
        <Button onClick={() => void publish()} disabled={busy || (!dirty && !unpublished)}>
          {dirty ? "Save and publish" : "Publish storefront"}
        </Button>
      </div>
    </div>
  );
}
