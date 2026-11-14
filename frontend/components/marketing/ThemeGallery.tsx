"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BUSINESS_CATEGORIES, type ThemeId } from "@/lib/constants";
import { THEMES } from "@/lib/themes";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import ThemePreviewImage from "./ThemePreviewImage";
import PreviewFrame from "@/components/dashboard/editor/PreviewFrame";
import type { EditorDevice } from "@/components/dashboard/editor/EditorToolbar";
import { buttonClass, focusRing } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Pill } from "@/components/ui/Surface";
import { sampleCommerceData, sampleStoreView } from "./sample-store";

const CATEGORY_NAMES = new Map<string, string>(BUSINESS_CATEGORIES.map((c) => [c.key, c.name]));
const DEVICES: Array<{ id: EditorDevice; icon: string; label: string }> = [
  { id: "desktop", icon: "monitor", label: "Desktop" },
  { id: "tablet", icon: "tablet", label: "Tablet" },
  { id: "mobile", icon: "phone", label: "Phone" },
];

type PlanNames = Record<string, { name: string; free: boolean } | null>;

/** Every theme with a full preview: the real storefront renderer, sample content. */
export default function ThemeGallery({ planNames, signUpHref }: { planNames: PlanNames; signUpHref: string }) {
  const [previewId, setPreviewId] = useState<ThemeId | null>(null);
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const view = useMemo(() => (previewId ? sampleStoreView(previewId) : null), [previewId]);
  const commerce = useMemo(() => (previewId ? sampleCommerceData(previewId) : null), [previewId]);
  const previewTheme = THEMES.find((t) => t.id === previewId);
  const open = previewId !== null;

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewId(null);
      if (event.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>("button, a[href]")];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      openerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <ul className="grid gap-x-5 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
        {THEMES.map((theme) => {
          const plan = planNames[theme.id];
          return (
            <li key={theme.id} id={theme.id} className="flex scroll-mt-24 flex-col">
              <button
                type="button"
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setPreviewId(theme.id);
                }}
                aria-label={`Preview the ${theme.name} theme`}
                className={`ui-lift group relative block overflow-hidden rounded-2xl border border-slate-200 text-left shadow-sm ${focusRing}`}
              >
                <ThemePreviewImage themeId={theme.id} className="aspect-[4/5]" />
                <span className="absolute inset-x-3 bottom-3 inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink py-2 text-xs font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Icon name="eye" size={14} /> Preview
                </span>
              </button>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xl font-semibold text-slate-900">{theme.name}</h2>
                {plan && <Pill tone={plan.free ? "success" : "neutral"}>{plan.free ? "Included on the Free plan" : `${plan.name} plan and up`}</Pill>}
              </div>
              <p className="mt-1 text-sm font-medium text-slate-700">{theme.tagline}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{theme.identity}</p>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                <span className="font-medium text-slate-700">Best for:</span> {theme.bestFor.map((key) => CATEGORY_NAMES.get(key) ?? key).join(", ")}
              </p>
              <div className="mt-4 md:hidden">
                <button
                  type="button"
                  onClick={(event) => {
                    openerRef.current = event.currentTarget;
                    setPreviewId(theme.id);
                  }}
                  className={buttonClass({ variant: "secondary", block: true })}
                >
                  Preview {theme.name}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {open && view && commerce && previewTheme && (
        <div className="ui-fade fixed inset-0 z-50 flex items-stretch bg-slate-950/70 p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div ref={dialogRef} className="ui-pop mx-auto flex w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-lg">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3">
              <div className="mr-auto min-w-0">
                <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
                  {previewTheme.name}
                </h2>
                <p className="text-xs text-slate-500">A fictional sample store. Your own products and pages will appear here.</p>
              </div>
              <div role="group" aria-label="Preview size" className="flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
                {DEVICES.map((option) => (
                  <button key={option.id} type="button" aria-pressed={device === option.id} aria-label={option.label} title={option.label} onClick={() => setDevice(option.id)} className={`flex h-9 w-10 items-center justify-center rounded-md transition-colors ${focusRing} ${device === option.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"}`}>
                    <Icon name={option.icon} size={17} />
                  </button>
                ))}
              </div>
              <Link href={signUpHref} className={buttonClass({ variant: "primary" })}>
                Start with {previewTheme.name}
              </Link>
              <button ref={closeRef} type="button" onClick={() => setPreviewId(null)} aria-label="Close preview" className={`flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${focusRing}`}>
                <Icon name="x" size={20} />
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-slate-100 p-2 sm:p-4">
              <PreviewFrame device={device} title={`${previewTheme.name} theme preview`}>
                <ThemeRenderer view={view} productHrefBase="#" preview commerce={commerce} />
              </PreviewFrame>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
