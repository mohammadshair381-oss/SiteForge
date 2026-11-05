"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StorefrontView } from "@/lib/storefront";
import type { StorefrontConfig } from "@/lib/storefront-config";
import type { CommerceExtras } from "@/lib/storefront-home";
import { SETUP_STEP_INFO, type Readiness } from "@/lib/store-setup";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Surface";
import { SetupFooter, setupButton, setupPrimaryButton, useSetup } from "./SetupWizard";
import SetupPreview from "./SetupPreview";

/**
 * Step 6: the whole store on every screen size, what still needs attention,
 * and publishing. Publishing is always an explicit action through the
 * existing publish routes (same checks: verified email, active plan, not
 * suspended); nothing in setup publishes on its own.
 */
export default function LaunchStep({
  view,
  draft,
  extras,
  readiness,
  published,
  hasUnpublishedChanges,
  storeUrl,
}: {
  view: StorefrontView;
  draft: StorefrontConfig;
  extras: CommerceExtras;
  readiness: Readiness;
  published: boolean;
  hasUnpublishedChanges: boolean;
  storeUrl: string | null;
}) {
  const router = useRouter();
  const { businessId, busy, go } = useSetup();
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const required = readiness.items.filter((i) => i.required);
  const recommended = readiness.items.filter((i) => !i.required);

  async function publish(path: "publish" | "storefront/publish", confirmText: string) {
    if (!(await confirmDialog({ title: path === "publish" ? "Publish your store?" : "Publish your homepage changes?", message: confirmText, confirmLabel: path === "publish" ? "Publish store" : "Publish changes" }))) return;
    setPublishing(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: path === "publish" ? JSON.stringify({ publish: true }) : "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your store could not be published.");
      setMessage({ ok: true, text: path === "publish" ? "Your store is published. Customers can visit it now." : "Your homepage changes are live." });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing was published." });
    } finally {
      setPublishing(false);
    }
  }

  const item = (i: Readiness["items"][number]) => (
    <li key={i.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border border-slate-200 px-3 py-2.5">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${i.done ? "bg-emerald-100 text-emerald-800" : i.required ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}
      >
        {i.done ? <Icon name="check" size={12} /> : "!"}
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-sm font-medium text-slate-900">
          {i.label}
          <span className="sr-only">{i.done ? " (done)" : i.required ? " (required to publish)" : " (recommended)"}</span>
        </p>
        <p className="mt-0.5 text-xs leading-5 text-slate-600">{i.detail}</p>
      </div>
      {!i.done && i.step !== "launch" && (
        <button type="button" disabled={busy} onClick={() => void go(i.step)} className="ml-8 inline-flex min-h-10 shrink-0 items-center rounded text-xs font-semibold text-slate-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:ml-0">
          Go to {SETUP_STEP_INFO[i.step].title}
        </button>
      )}
    </li>
  );

  return (
    <div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <div className={`rounded-xl border px-4 py-3 text-sm ${published ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-slate-200 bg-slate-50 text-slate-800"}`} role="status">
            {published ? (
              <>
                <p className="font-semibold">Your store is live.</p>
                <p className="mt-0.5 text-xs">{hasUnpublishedChanges ? "You have homepage changes that are not published yet." : "Everything you see in the preview is live."}</p>
              </>
            ) : (
              <>
                <p className="font-semibold">Your store is a draft.</p>
                <p className="mt-0.5 text-xs">Customers cannot see it until you publish.</p>
              </>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Needed to publish</h3>
            <ul className="mt-2 space-y-1.5">{required.map(item)}</ul>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Recommended <span className="font-normal text-slate-500">({readiness.remainingRecommended} left)</span>
            </h3>
            <ul className="mt-2 space-y-1.5">{recommended.map(item)}</ul>
          </div>

          <div className="space-y-2">
            {!published ? (
              <button
                type="button"
                className={`${setupPrimaryButton} w-full`}
                disabled={publishing || !readiness.canPublish}
                onClick={() => void publish("publish", "Publish your store? Customers will be able to visit it and place orders.")}
              >
                {publishing ? "Publishing…" : "Publish store"}
              </button>
            ) : hasUnpublishedChanges ? (
              <button type="button" className={`${setupPrimaryButton} w-full`} disabled={publishing} onClick={() => void publish("storefront/publish", "Publish your homepage changes? Visitors will see them right away.")}>
                {publishing ? "Publishing…" : "Publish homepage changes"}
              </button>
            ) : null}
            {!readiness.canPublish && !published && <p className="text-xs text-red-700">Complete the items under “Needed to publish” first.</p>}
            {message && (
              <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
                {message.text}
              </Notice>
            )}
            <div className="flex flex-wrap gap-2">
              <Link href={`/dashboard/businesses/${businessId}/editor`} className={setupButton}>
                Open the website editor
              </Link>
              {published && storeUrl && (
                <a href={storeUrl} target="_blank" rel="noreferrer" className={setupButton}>
                  View store <Icon name="external" size={14} />
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SetupPreview view={view} config={draft} extras={extras} label="Store preview (draft)" className="h-[30rem] sm:h-[38rem]" />
        </div>
      </div>
      <SetupFooter continueLabel="Finish setup" hint={published ? undefined : "You can publish later from your dashboard."} />
    </div>
  );
}
