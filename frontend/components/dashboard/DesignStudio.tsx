"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { skinFor } from "@/components/storefront/commerce/skins";
import { Button } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice, Pill } from "@/components/ui/Surface";
import { useToastHelpers } from "@/components/ui/Toast";
import { contrastRatio, parseHexColor, textReadability } from "@/lib/color-contrast";
import {
  BODY_WEIGHTS,
  BUTTON_SHAPES,
  BUTTON_SHAPE_LABELS,
  BUTTON_STYLES,
  BUTTON_STYLE_LABELS,
  CONTENT_WIDTHS,
  CONTENT_WIDTH_LABELS,
  DEFAULT_STORE_DESIGN,
  DESIGN_FONTS,
  DESIGN_FONT_LABELS,
  HEADING_SIZES,
  HEADING_SIZE_LABELS,
  HEADING_WEIGHTS,
  LINK_STYLES,
  LINK_STYLE_LABELS,
  RADII,
  RADIUS_LABELS,
  SECTION_SPACINGS,
  SECTION_SPACING_LABELS,
  TEXT_SIZES,
  TEXT_SIZE_LABELS,
  designFontValue,
  pickStoreDesign,
  type DesignDraft,
} from "@/lib/design-settings";
import type { StorefrontView } from "@/lib/storefront";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";
import type { StorefrontConfig } from "@/lib/storefront-config";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import { THEMES, getThemeMeta } from "@/lib/themes";
import DeviceSwitch from "./editor/DeviceSwitch";
import type { EditorDevice } from "./editor/EditorToolbar";
import PreviewFrame from "./editor/PreviewFrame";
import RevisionHistoryDialog from "./editor/RevisionHistoryDialog";

const field = "mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
const labelClass = "block text-sm font-medium text-slate-800";

/**
 * Store-wide design: theme, colours, typefaces, buttons and text size, shown live
 * in the real storefront renderer. Everything stays in a draft until published,
 * and a theme keeps its own layouts whatever is chosen here.
 */
export default function DesignStudio({
  businessId,
  view,
  config,
  extras,
  initialDraft,
  initialVersion = 0,
  initialHasChanges,
  themeAccess,
  storeLive,
  canManage,
}: {
  businessId: string;
  view: StorefrontView;
  config: StorefrontConfig;
  extras: CommerceExtras;
  initialDraft: DesignDraft;
  /** What a save names, so an old tab cannot overwrite newer choices. */
  initialVersion?: number;
  initialHasChanges: boolean;
  themeAccess: ThemeAccess;
  storeLive: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const { success, error: showError } = useToastHelpers();
  const [design, setDesign] = useState<DesignDraft>(initialDraft);
  const saved = useRef(JSON.stringify(initialDraft));
  const version = useRef(initialVersion);
  const [conflict, setConflict] = useState(false);
  const [hasUnpublished, setHasUnpublished] = useState(initialHasChanges);
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const dirty = JSON.stringify(design) !== saved.current;
  const update = (patch: Partial<DesignDraft>) => {
    setDesign((current) => ({ ...current, ...patch }));
    setMessage(null);
  };

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const palette = getThemeMeta(design.themeId).palette;
  const colors = design.useThemeColors ? { primaryColor: palette[1], accentColor: palette[2] } : { primaryColor: design.primaryColor, accentColor: design.accentColor };
  const previewView = useMemo<StorefrontView>(
    () => ({
      ...view,
      themeId: design.themeId,
      theme: {
        ...view.theme,
        ...colors,
        font: "sans",
        design: pickStoreDesign(design),
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, design],
  );
  const commerce = useMemo(() => buildCommerceData(previewView, config, extras), [previewView, config, extras]);

  // Light colours on a white button label, or dark on dark, are hard to read.
  const primaryRgb = parseHexColor(design.primaryColor);
  const lowContrast = !design.useThemeColors && primaryRgb !== null && contrastRatio(primaryRgb, [255, 255, 255]) < 3 && contrastRatio(primaryRgb, [0, 0, 0]) < 3;

  // A colour left to the theme is compared as the theme's usual page or text colour. Advice only: saving and publishing stay open.
  const darkTheme = skinFor(design.themeId).dark;
  const pageReadability =
    design.backgroundColor || design.textColor
      ? textReadability(design.textColor || (darkTheme ? "#f8fafc" : "#111827"), design.backgroundColor || (darkTheme ? "#0a0c10" : "#ffffff"))
      : null;
  const pairName = design.backgroundColor && design.textColor ? "Your text colour on your page background" : design.textColor ? "Your text colour on this theme's background" : "This theme's text on your page background";

  const saveDraft = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/design`, { method: "PUT", headers: { "Content-Type": "application/json", "x-expected-version": String(version.current) }, body: JSON.stringify(design) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "draft_conflict") setConflict(true);
      if (!res.ok) throw new Error(data.error || "Your design could not be saved.");
      saved.current = JSON.stringify(design);
      if (typeof data.version === "number") version.current = data.version;
      setHasUnpublished(Boolean(data.hasUnpublishedChanges));
      setMessage({ tone: "success", text: "Draft saved. Your live store has not changed." });
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : "Your design could not be saved.";
      setMessage({ tone: "danger", text });
      return false;
    } finally {
      setBusy(false);
    }
  }, [businessId, design]);

  async function publish() {
    if (!(await confirmDialog({ title: "Publish this design?", message: storeLive ? "Visitors see the new design across your whole store right away." : "It goes live when your store is published.", confirmLabel: "Publish design" }))) return;
    if (dirty && !(await saveDraft())) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/website/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: ["design"] }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your design could not be published.");
      if (data.failed?.length) throw new Error(data.failed[0].error);
      setHasUnpublished(false);
      setMessage({ tone: "success", text: "Design published." });
      success("Design published", storeLive ? "Visitors now see it." : "It goes live with your store.");
      router.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Your design could not be published.";
      setMessage({ tone: "danger", text });
      showError("Publish failed", text);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!(await confirmDialog({ title: "Discard this draft?", message: "Your design goes back to what visitors see now.", confirmLabel: "Discard draft", tone: "danger" }))) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}/design`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The draft could not be discarded.");
      setDesign(data.draft);
      saved.current = JSON.stringify(data.draft);
      if (typeof data.version === "number") version.current = data.version;
      setConflict(false);
      setHasUnpublished(false);
      setMessage({ tone: "success", text: "Back to your live design." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "The draft could not be discarded." });
    } finally {
      setBusy(false);
    }
  }

  const fontOption = (font: (typeof DESIGN_FONTS)[number]) => (
    <option key={font} value={font}>{DESIGN_FONT_LABELS[font]}</option>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Design</h1>
            <Pill tone={dirty || hasUnpublished ? "warning" : "success"} dot>{dirty ? "Unsaved changes" : hasUnpublished ? "Draft not published" : "Matches your live store"}</Pill>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">Each theme keeps its own layouts. These choices change its colours, type and feel across your whole store.</p>
        </div>

        {message && (
          <Notice tone={message.tone} role={message.tone === "danger" ? "alert" : "status"} action={conflict ? <Button variant="secondary" onClick={() => window.location.reload()}>Reload</Button> : undefined}>
            {message.text}
          </Notice>
        )}

        <fieldset disabled={!canManage || busy} className="space-y-5 disabled:opacity-70">
          <div>
            <label htmlFor="ds-theme" className={labelClass}>Theme</label>
            <select id="ds-theme" value={design.themeId} onChange={(e) => update({ themeId: e.target.value as DesignDraft["themeId"] })} className={field}>
              {THEMES.map((theme) => {
                const locked = !canSelectTheme(themeAccess, theme.id);
                const plan = themeAccess.requiredPlan[theme.id];
                return (
                  <option key={theme.id} value={theme.id} disabled={locked}>
                    {theme.name}{locked ? ` (${plan ? plan.name : "unavailable"} plan)` : ` · ${theme.tagline}`}
                  </option>
                );
              })}
            </select>
            <p className="mt-1.5 text-xs leading-5 text-slate-500">
              <Link className="font-medium text-slate-800 underline underline-offset-2" href={`/dashboard/businesses/${businessId}/theme`}>Compare all themes</Link>
            </p>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900">Colours</h2>
            <label className="mt-2 flex min-h-10 cursor-pointer items-center gap-2.5 text-sm text-slate-800">
              <input type="checkbox" checked={design.useThemeColors} onChange={(e) => update({ useThemeColors: e.target.checked })} className="h-4 w-4 rounded" />
              Use the theme&apos;s own colours
            </label>
            {!design.useThemeColors && (
              <div className="mt-2 grid grid-cols-2 gap-3">
                {([["primaryColor", "Main colour"], ["accentColor", "Second colour"]] as const).map(([key, name]) => (
                  <label key={key} className="block text-xs font-medium text-slate-700">
                    {name}
                    <span className="mt-1 flex items-center gap-2">
                      <input type="color" value={design[key]} onChange={(e) => update({ [key]: e.target.value })} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white p-1" />
                      <input aria-label={`${name} code`} value={design[key]} maxLength={7} onChange={(e) => update({ [key]: e.target.value })} className="min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-2 text-sm" />
                    </span>
                  </label>
                ))}
              </div>
            )}
            {lowContrast && <p className="mt-2 text-xs leading-5 text-amber-800">Button text may be hard to read on this main colour.</p>}
            {!design.useThemeColors && (
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-700">Colour palettes</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {THEMES.map((theme) => (
                    <button key={theme.id} type="button" title={`${theme.name}'s colours`} aria-label={`Use ${theme.name}'s colours`} onClick={() => update({ primaryColor: theme.palette[1], accentColor: theme.palette[2] })} className="inline-flex h-10 items-center gap-0.5 rounded-lg border border-slate-300 bg-white px-1.5 hover:border-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                      <span aria-hidden="true" className="h-5 w-5 rounded" style={{ background: theme.palette[1] }} />
                      <span aria-hidden="true" className="h-5 w-5 rounded" style={{ background: theme.palette[2] }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3">
              {([["backgroundColor", "Page background"], ["textColor", "Text"]] as const).map(([key, name]) => (
                <div key={key} className="text-xs font-medium text-slate-700">
                  <span className="block">{name}</span>
                  <span className="mt-1 flex items-center gap-2">
                    <input type="color" aria-label={name} value={design[key] || "#ffffff"} onChange={(e) => update({ [key]: e.target.value })} className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white p-1" />
                    {design[key] ? (
                      <button type="button" onClick={() => update({ [key]: "" })} className="min-h-10 rounded-lg px-2 text-xs font-medium text-slate-700 underline underline-offset-2">Use the theme&apos;s</button>
                    ) : (
                      <span className="text-xs font-normal text-slate-500">The theme&apos;s own</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {pageReadability && pageReadability.level !== "good" && (
              <p role="status" className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                {pairName} {pageReadability.level === "low" ? "is hard to read" : "may be hard to read in small sizes"} (contrast {pageReadability.ratio.toFixed(1)}:1). Aim for at least 4.5:1 by making one colour lighter or darker. You can still save and publish.
              </p>
            )}
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900">Typography</h2>
            <label className="mt-2 block text-xs font-medium text-slate-700">
              Headings
              <select value={design.displayFont} onChange={(e) => update({ displayFont: e.target.value as DesignDraft["displayFont"] })} className={field} style={{ fontFamily: designFontValue(design.displayFont) ?? undefined }}>
                {DESIGN_FONTS.map(fontOption)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Text
              <select value={design.bodyFont} onChange={(e) => update({ bodyFont: e.target.value as DesignDraft["bodyFont"] })} className={field} style={{ fontFamily: designFontValue(design.bodyFont) ?? undefined }}>
                {DESIGN_FONTS.map(fontOption)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Size
              <select value={design.textSize} onChange={(e) => update({ textSize: e.target.value as DesignDraft["textSize"] })} className={field}>
                {TEXT_SIZES.map((size) => <option key={size} value={size}>{TEXT_SIZE_LABELS[size]}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Heading size
              <select value={design.headingSize} onChange={(e) => update({ headingSize: e.target.value as DesignDraft["headingSize"] })} className={field}>
                {HEADING_SIZES.map((size) => <option key={size} value={size}>{HEADING_SIZE_LABELS[size]}</option>)}
              </select>
            </label>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-slate-700">
                Heading weight
                <select value={design.headingWeight} onChange={(e) => update({ headingWeight: e.target.value as DesignDraft["headingWeight"] })} className={field}>
                  {HEADING_WEIGHTS.map((weight) => <option key={weight} value={weight}>{weight === "theme" ? "The theme's own" : weight === "400" ? "Regular" : weight === "500" ? "Medium" : weight === "600" ? "Semi-bold" : weight === "700" ? "Bold" : "Extra bold"}</option>)}
                </select>
              </label>
              <label className="block text-xs font-medium text-slate-700">
                Text weight
                <select value={design.bodyWeight} onChange={(e) => update({ bodyWeight: e.target.value as DesignDraft["bodyWeight"] })} className={field}>
                  {BODY_WEIGHTS.map((weight) => <option key={weight} value={weight}>{weight === "theme" ? "The theme's own" : weight === "300" ? "Light" : weight === "400" ? "Regular" : "Medium"}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900">Buttons</h2>
            <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Button corners">
              {BUTTON_SHAPES.map((shape) => (
                <label key={shape} className={`flex min-h-10 cursor-pointer items-center justify-center rounded-lg border px-2 text-center text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-brand-500 ${design.buttonShape === shape ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"}`}>
                  <input type="radio" name="button-shape" className="sr-only" checked={design.buttonShape === shape} onChange={() => update({ buttonShape: shape })} />
                  {BUTTON_SHAPE_LABELS[shape]}
                </label>
              ))}
            </div>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Button style
              <select value={design.buttonStyle} onChange={(e) => update({ buttonStyle: e.target.value as DesignDraft["buttonStyle"] })} className={field}>
                {BUTTON_STYLES.map((style) => <option key={style} value={style}>{BUTTON_STYLE_LABELS[style]}</option>)}
              </select>
            </label>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-slate-900">Layout and links</h2>
            <label className="mt-2 block text-xs font-medium text-slate-700">
              Corners of cards and pictures
              <select value={design.radius} onChange={(e) => update({ radius: e.target.value as DesignDraft["radius"] })} className={field}>
                {RADII.map((radius) => <option key={radius} value={radius}>{RADIUS_LABELS[radius]}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Space between sections
              <select value={design.sectionSpacing} onChange={(e) => update({ sectionSpacing: e.target.value as DesignDraft["sectionSpacing"] })} className={field}>
                {SECTION_SPACINGS.map((spacing) => <option key={spacing} value={spacing}>{SECTION_SPACING_LABELS[spacing]}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Content width
              <select value={design.contentWidth} onChange={(e) => update({ contentWidth: e.target.value as DesignDraft["contentWidth"] })} className={field}>
                {CONTENT_WIDTHS.map((width) => <option key={width} value={width}>{CONTENT_WIDTH_LABELS[width]}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Links in text
              <select value={design.linkStyle} onChange={(e) => update({ linkStyle: e.target.value as DesignDraft["linkStyle"] })} className={field}>
                {LINK_STYLES.map((style) => <option key={style} value={style}>{LINK_STYLE_LABELS[style]}</option>)}
              </select>
            </label>
          </div>

          <Button variant="secondary" block onClick={() => update({ ...DEFAULT_STORE_DESIGN, useThemeColors: true })}>Reset everything to the theme&apos;s defaults</Button>
        </fieldset>

        {canManage && (
          <div className="sticky bottom-3 flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <Button onClick={() => void publish()} disabled={busy || (!dirty && !hasUnpublished)}>Publish</Button>
            <Button variant="secondary" onClick={() => void saveDraft()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save draft"}</Button>
            <Button variant="ghost" onClick={() => setHistoryOpen(true)} disabled={busy}>History</Button>
            {(dirty || hasUnpublished) && <Button variant="ghost" className="!text-red-700 hover:!bg-red-50" onClick={() => void discard()} disabled={busy}>Discard</Button>}
          </div>
        )}
      </div>

      <section aria-label="Preview of your design" className="flex h-[70vh] min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-sm lg:sticky lg:top-4 lg:h-[calc(100dvh-7rem)]">
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-1.5 text-xs">
          <span className="font-medium text-slate-700">Draft preview</span>
          <DeviceSwitch device={device} onChange={setDevice} />
        </div>
        <div className="ui-dots-ink min-h-0 flex-1 overflow-auto p-3" inert>
          <PreviewFrame device={device} title="Design preview">
            <ThemeRenderer view={previewView} productHrefBase="#" preview commerce={commerce} />
          </PreviewFrame>
        </div>
      </section>

      {historyOpen && (
        <RevisionHistoryDialog
          businessId={businessId}
          target="design"
          title="Design"
          onClose={() => setHistoryOpen(false)}
          onRestored={() => window.location.reload()}
        />
      )}
    </div>
  );
}
