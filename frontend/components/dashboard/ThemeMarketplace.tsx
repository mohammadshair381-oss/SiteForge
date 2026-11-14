"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BUSINESS_CATEGORIES, type ThemeId } from "@/lib/constants";
import { THEMES, getThemeMeta } from "@/lib/themes";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import { sampleProductsFor } from "@/lib/theme-preview-samples";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";
import type { StorefrontConfig } from "@/lib/storefront-config";
import type { StorefrontView } from "@/lib/storefront";
import type { Section } from "@/lib/sections";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { Button, buttonClass, focusRing as focus } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill } from "@/components/ui/Surface";
import ThemeThumbnail from "./ThemeThumbnail";
import ThemePreviewImage from "@/components/marketing/ThemePreviewImage";
import PreviewFrame from "./editor/PreviewFrame";
import DeviceSwitch from "./editor/DeviceSwitch";
import type { EditorDevice } from "./editor/EditorToolbar";
import ManagementPageHeader from "./ManagementPageHeader";

const CATEGORY_NAMES = new Map<string, string>(BUSINESS_CATEGORIES.map((c) => [c.key, c.name]));

export interface MarketplacePage {
  id: string;
  title: string;
  status: "draft" | "published";
  sections: Section[];
}

type Filter = "all" | "included" | "locked";

/**
 * Theme marketplace: all nine themes for every plan. Each card shows the
 * theme's identity, what it suits, its look and motion, and whether the plan
 * includes it. Preview renders the REAL storefront renderer with this store's
 * draft data (homepage and content pages) at desktop, tablet or mobile width,
 * and never saves anything. Choosing a theme puts it in the design draft (only
 * included themes; the server enforces the same rule), keeping the owner's other
 * design choices, and the live store changes only when it is published. Locked
 * themes show the plan that unlocks them.
 */
export default function ThemeMarketplace({
  businessId,
  access,
  initialDraftThemeId,
  storeLive,
  view,
  config,
  extras,
  pages,
  canManage,
  isOwner,
}: {
  businessId: string;
  access: ThemeAccess;
  /** The theme in the design draft; the same as `access.current` when nothing is waiting. */
  initialDraftThemeId: ThemeId;
  storeLive: boolean;
  view: StorefrontView;
  config: StorefrontConfig;
  extras: CommerceExtras;
  pages: MarketplacePage[];
  canManage: boolean;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [previewId, setPreviewId] = useState<ThemeId | null>(null);
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const [previewPage, setPreviewPage] = useState<string>("home");
  const [samples, setSamples] = useState(view.products.length === 0);
  const [busy, setBusy] = useState<ThemeId | "publish" | null>(null);
  const [draftThemeId, setDraftThemeId] = useState<ThemeId>(initialDraftThemeId);
  useEffect(() => setDraftThemeId(initialDraftThemeId), [initialDraftThemeId]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const included = THEMES.filter((t) => canSelectTheme(access, t.id)).length;
  const shown = THEMES.filter((t) => (filter === "all" ? true : filter === "included" ? canSelectTheme(access, t.id) : !canSelectTheme(access, t.id)));
  const billingHref = `/dashboard/businesses/${businessId}/billing`;

  // Preview data: the store's own draft data; sample products only when the
  // store has none and the owner keeps the sample switch on.
  const previewView = useMemo<StorefrontView | null>(() => {
    if (!previewId) return null;
    const products = samples && view.products.length === 0 ? sampleProductsFor(previewId, view.currency || "USD") : view.products;
    // A store without chosen colours shows each theme in that theme's palette.
    const colors = view.usesThemeColors ? { theme: { ...view.theme, primaryColor: getThemeMeta(previewId).palette[1], accentColor: getThemeMeta(previewId).palette[2] } } : {};
    return { ...view, ...colors, themeId: previewId, products };
  }, [previewId, samples, view]);
  const commerce = useMemo(() => (previewView ? buildCommerceData(previewView, config, extras) : null), [previewView, config, extras]);
  const page = pages.find((p) => p.id === previewPage) ?? null;

  // Dialog: focus moves in, Escape closes, focus returns to the opener.
  useEffect(() => {
    if (!previewId) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewId(null);
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], select, input")];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const returnTo = opener.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      returnTo?.focus();
    };
  }, [previewId]);

  const draftBase = `/api/businesses/${businessId}`;

  /** Puts a theme in the design draft. The live store does not change. */
  async function chooseForDraft(themeId: ThemeId) {
    const name = THEMES.find((t) => t.id === themeId)?.name ?? themeId;
    setBusy(themeId);
    setMessage(null);
    try {
      const res = await fetch(`${draftBase}/design`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ themeId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The theme could not be added to your draft.");
      setDraftThemeId(themeId);
      setMessage({ ok: true, text: themeId === access.current ? `Your draft is back on ${name}. Your live store has not changed.` : `${name} is in your draft. Preview it, then publish it when you are happy. Your live store has not changed.` });
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was changed." });
    } finally {
      setBusy(null);
    }
  }

  /** Publishes the design draft through the same route as everything else. */
  async function publishDraft() {
    const name = THEMES.find((t) => t.id === draftThemeId)?.name ?? draftThemeId;
    if (!(await confirmDialog({ title: `Publish ${name}?`, message: storeLive ? "Visitors see this theme right away, together with any other design changes in your draft. Pages, content, products and settings stay exactly as they are, and your current design stays in the version history." : "It goes live when your store is published.", confirmLabel: `Publish ${name}` }))) return;
    setBusy("publish");
    setMessage(null);
    try {
      const res = await fetch(`${draftBase}/website/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: ["design"] }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The theme could not be published.");
      if (data.failed?.length) throw new Error(data.failed[0].error);
      setMessage({ ok: true, text: storeLive ? `${name} is now live.` : `${name} goes live with your store.` });
      setPreviewId(null);
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Network error. Nothing was published." });
    } finally {
      setBusy(null);
    }
  }

  const action = (themeId: ThemeId, compact = false) => {
    const theme = THEMES.find((t) => t.id === themeId)!;
    if (themeId === draftThemeId && themeId === access.current) {
      return (
        <span className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          <Icon name="check" size={15} /> Live theme
        </span>
      );
    }
    if (themeId === draftThemeId) {
      return (
        <Button disabled={!canManage || busy !== null} onClick={() => void publishDraft()}>
          {busy === "publish" ? "Publishing…" : compact ? "Publish" : `Publish ${theme.name}`}
        </Button>
      );
    }
    if (canSelectTheme(access, themeId)) {
      return (
        <Button variant={themeId === access.current ? "secondary" : "primary"} disabled={!canManage || busy !== null} onClick={() => void chooseForDraft(themeId)}>
          {busy === themeId ? "Saving…" : themeId === access.current ? "Back to this theme" : compact ? "Use in draft" : `Use ${theme.name} in draft`}
        </Button>
      );
    }
    const plan = access.requiredPlan[themeId];
    if (!plan) return <span className="text-sm text-slate-600">Not available on any current plan</span>;
    return isOwner ? (
      <a href={billingHref} className={buttonClass({ variant: "secondary" })}>
        <Icon name="lock" size={14} /> Upgrade to {plan.name}
      </a>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-sm text-slate-700">
        <Icon name="lock" size={14} /> On the {plan.name} plan. Ask the store owner to upgrade.
      </span>
    );
  };

  const currentTheme = THEMES.find((t) => t.id === access.current);
  const previewTheme = THEMES.find((t) => t.id === previewId);
  const waitingTheme = draftThemeId !== access.current ? THEMES.find((t) => t.id === draftThemeId) : undefined;

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Theme marketplace"
        description="Nine complete store designs. Preview any of them with your own store, put one your plan includes in your draft, and publish it when you are happy. Your live store does not change until then, and switching themes never changes your pages, content, products or settings."
      />

      <section aria-label="Your plan" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-5">
        <div className="min-w-0 text-sm text-slate-600">
          <p>
            Your plan: <span className="font-semibold text-slate-900">{access.planName}</span> · {included} of {THEMES.length} themes included
          </p>
          <p className="mt-0.5">
            Live theme: <span className="font-semibold text-slate-900">{currentTheme?.name}</span>
            {access.grandfathered && " (kept from an earlier plan: it stays live, but switching away needs a plan that includes it to switch back)"}
          </p>
        </div>
        <div role="group" aria-label="Show themes" className="flex max-w-full overflow-x-auto rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-sm">
          {([["all", `All ${THEMES.length}`], ["included", "Included in your plan"], ["locked", "Upgrade"]] as const).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={`min-h-10 shrink-0 whitespace-nowrap rounded-md px-3 py-1 font-medium transition-colors ${filter === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"} ${focus}`}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      {waitingTheme && (
        <Notice
          tone="info"
          title={`${waitingTheme.name} is waiting in your draft`}
          action={
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setPreviewPage("home");
                  setPreviewId(waitingTheme.id);
                }}
                className={buttonClass({ variant: "secondary" })}
              >
                Preview
              </button>
              {canManage && <Button disabled={busy !== null} onClick={() => void publishDraft()}>{busy === "publish" ? "Publishing…" : "Publish"}</Button>}
            </div>
          }
        >
          {storeLive ? `Visitors still see ${currentTheme?.name}.` : "Nothing is public yet."} Colours, fonts and buttons in your draft are in <a className="font-medium underline underline-offset-2" href={`/dashboard/businesses/${businessId}/design`}>Design</a>.
        </Notice>
      )}
      {!canManage && <Notice tone="info">Only owners and managers can change the theme. You can still preview every theme.</Notice>}
      {shown.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-10 text-center text-sm text-slate-600">
          {filter === "locked" ? "Your plan already includes every theme." : "No themes match this filter."}
        </p>
      )}

      <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-label="Themes">
        {shown.map((theme) => {
          const selectable = canSelectTheme(access, theme.id);
          const plan = access.requiredPlan[theme.id];
          const isCurrent = theme.id === access.current;
          return (
            <li key={theme.id} data-theme-card={theme.id} className={`ui-lift flex flex-col overflow-hidden rounded-2xl border bg-white shadow-sm hover:shadow-md ${isCurrent ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300"}`}>
              <button
                type="button"
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setPreviewPage("home");
                  setPreviewId(theme.id);
                }}
                className={`group relative block w-full bg-slate-100 p-3 text-left ${focus} focus-visible:ring-inset focus-visible:ring-offset-0`}
              >
                <span className="sr-only">Preview {theme.name} full screen</span>
                {/* A store with its own colours sees them on the layout; otherwise a real picture of the theme. */}
                {view.usesThemeColors ? (
                  <span className={`block overflow-hidden rounded-lg ring-1 ring-black/10 ${selectable ? "" : "opacity-90"}`}>
                    <ThemePreviewImage themeId={theme.id} className="aspect-[16/10]" />
                  </span>
                ) : (
                  <ThemeThumbnail themeId={theme.id} primary={view.theme.primaryColor} accent={view.theme.accentColor} className={selectable ? "" : "opacity-90"} />
                )}
                <span className="absolute inset-x-0 bottom-5 flex justify-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow-sm">
                    <Icon name="eye" size={13} /> Full-screen preview
                  </span>
                </span>
              </button>
              <div className="flex flex-1 flex-col p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold text-slate-900">{theme.name}</h2>
                  {isCurrent ? (
                    <Pill tone="success" dot>Live</Pill>
                  ) : theme.id === draftThemeId ? (
                    <Pill tone="warning" dot>In your draft</Pill>
                  ) : selectable ? (
                    <Pill tone="neutral">{`Included in ${access.planName}`}</Pill>
                  ) : (
                    <Pill tone="warning">
                      <Icon name="lock" size={12} /> {plan ? `${plan.name} plan` : "Unavailable"}
                    </Pill>
                  )}
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-700">{theme.identity}</p>
                <details className="mt-2 text-xs text-slate-600">
                  <summary className={`min-h-10 cursor-pointer rounded py-1 font-medium text-slate-700 ${focus}`}>Best for, look and motion</summary>
                  <dl className="mt-1 space-y-2">
                    <div>
                      <dt className="font-medium text-slate-500">Best for</dt>
                      <dd className="mt-0.5">{theme.bestFor.map((key) => CATEGORY_NAMES.get(key) ?? key).join(", ")}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Look</dt>
                      <dd className="mt-0.5">{theme.visual.join(" · ")}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Motion</dt>
                      <dd className="mt-0.5">{theme.motion}</dd>
                    </div>
                  </dl>
                </details>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  <button
                    type="button"
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setPreviewPage("home");
                      setPreviewId(theme.id);
                    }}
                    className={buttonClass({ variant: "secondary" })}
                  >
                    Preview<span className="sr-only"> {theme.name}</span>
                  </button>
                  {action(theme.id, true)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {previewId && previewView && commerce && (
        <div className="ui-fade fixed inset-0 z-50 flex bg-slate-100" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div ref={dialogRef} className="flex min-h-0 w-full flex-col">
            <div className="grid shrink-0 grid-cols-1 items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-3 py-2 sm:px-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 lg:justify-start">
                <div className="min-w-0">
                  <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
                    Previewing {previewTheme?.name}
                  </h2>
                  <p className="text-xs text-slate-600">Your store&apos;s draft content in this theme. Nothing is saved until you choose it, and nothing goes live until you publish it.</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-center">
                <DeviceSwitch device={device} onChange={setDevice} />
                <label className="min-w-0 text-xs font-medium text-slate-700">
                  <span className="sr-only">Page to preview</span>
                  <select value={previewPage} onChange={(e) => setPreviewPage(e.target.value)} className={`min-h-10 max-w-[14rem] rounded-lg border px-2 py-1.5 text-sm lg:min-h-9 ${focus}`}>
                    <option value="home">Homepage</option>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}{p.status === "draft" ? " (draft)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                {action(previewId)}
                <button ref={closeRef} type="button" onClick={() => setPreviewId(null)} className={buttonClass({ variant: "secondary" })}>
                  <Icon name="x" size={15} /> Close preview
                </button>
              </div>
            </div>
            {view.products.length === 0 && (
              <label className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 sm:items-center">
                <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} className="h-4 w-4 shrink-0" />
                Show sample products (your store has none yet). Samples exist only in this preview: never saved or shown to customers.
              </label>
            )}
            <div className="ui-dots-ink relative min-h-0 flex-1">
              <div className="absolute inset-2 sm:inset-4">
                <PreviewFrame device={device} title={`${previewTheme?.name} theme preview`}>
                  <ThemeRenderer view={previewView} productHrefBase="#" preview commerce={commerce} sections={page && page.sections.length > 0 ? page.sections : undefined} />
                </PreviewFrame>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
