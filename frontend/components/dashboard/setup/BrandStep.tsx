"use client";

import { useId, useMemo, useState } from "react";
import MediaPicker from "@/components/dashboard/MediaPicker";
import { THEMES } from "@/lib/themes";
import ThemeThumbnail from "../ThemeThumbnail";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import type { ThemeId } from "@/lib/constants";
import type { StorefrontView } from "@/lib/storefront";
import type { StorefrontConfig } from "@/lib/storefront-config";
import type { CommerceExtras } from "@/lib/storefront-home";
import { primaryContrastWithWhite, type BrandPalette } from "@/lib/brand-presets";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill } from "@/components/ui/Surface";
import { SetupFooter, setupInput, useSetup } from "./SetupWizard";
import SetupPreview from "./SetupPreview";

export interface BrandIdentity {
  themeId: ThemeId;
  primaryColor: string;
  accentColor: string;
  font: "sans" | "serif" | "mono";
  logoUrl: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS: Array<{ id: BrandIdentity["font"]; name: string; className: string }> = [
  { id: "sans", name: "Theme default", className: "font-sans" },
  { id: "serif", name: "Serif", className: "font-serif" },
  { id: "mono", name: "Mono", className: "font-mono" },
];
const card = "block cursor-pointer rounded-xl border p-3 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-1";
const selectedCard = "border-slate-900 ring-1 ring-slate-900";
const idleCard = "border-slate-200 hover:border-slate-400";

/**
 * Step 2: visual identity (theme, colours, font, logo) with a live preview.
 * Suggestions come from the business type (lib/brand-presets.ts); nothing is
 * forced. Theme, colours and font are store-wide settings saved through the
 * business route, so they apply to a published store as soon as they are saved.
 */
export default function BrandStep({
  initial,
  view,
  config,
  extras,
  recommendedTheme,
  palettes,
  typeLabel,
  storeLive,
  themeAccess,
}: {
  initial: BrandIdentity;
  view: StorefrontView;
  config: StorefrontConfig;
  extras: CommerceExtras;
  recommendedTheme: ThemeId;
  palettes: BrandPalette[];
  typeLabel: string;
  storeLive: boolean;
  /** Plan-based theme access (server-decided; the server enforces the same rule). */
  themeAccess: ThemeAccess;
}) {
  const { businessId } = useSetup();
  const name = useId();
  const [brand, setBrand] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<BrandIdentity>) => setBrand((b) => ({ ...b, ...patch }));
  const colorsValid = HEX.test(brand.primaryColor) && HEX.test(brand.accentColor);
  const contrast = primaryContrastWithWhite(brand.primaryColor);
  const matching = palettes.find((p) => p.primary === brand.primaryColor.toLowerCase() && p.accent === brand.accentColor.toLowerCase());

  const previewView = useMemo<StorefrontView>(
    () => ({
      ...view,
      themeId: brand.themeId,
      logoUrl: brand.logoUrl,
      theme: { ...view.theme, primaryColor: colorsValid ? brand.primaryColor : view.theme.primaryColor, accentColor: colorsValid ? brand.accentColor : view.theme.accentColor, font: brand.font },
    }),
    [view, brand, colorsValid],
  );

  async function save(): Promise<boolean> {
    if (!colorsValid) {
      setError("Colours must be hex values like #4f46e5.");
      return false;
    }
    setSaving(true);
    setError(null);
    try {
      const primaryColor = brand.primaryColor.toLowerCase();
      const accentColor = brand.accentColor.toLowerCase();
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // A live store's look changes through the design draft below; the logo is a business detail.
        body: JSON.stringify(storeLive ? { logoUrl: brand.logoUrl } : { themeId: brand.themeId, logoUrl: brand.logoUrl, themeSettings: { primaryColor, accentColor, font: brand.font } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Your brand settings could not be saved.");
      if (storeLive) {
        // Only what changed here, so other draft choices stay as they are.
        const changes = {
          ...(brand.themeId !== initial.themeId ? { themeId: brand.themeId } : {}),
          ...(primaryColor !== initial.primaryColor.toLowerCase() || accentColor !== initial.accentColor.toLowerCase() ? { useThemeColors: false, primaryColor, accentColor } : {}),
          ...(brand.font !== initial.font ? { displayFont: brand.font === "sans" ? "theme" : brand.font, bodyFont: brand.font === "sans" ? "theme" : brand.font } : {}),
        };
        if (Object.keys(changes).length > 0) {
          const draftRes = await fetch(`/api/businesses/${businessId}/design`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
          const draftData = await draftRes.json().catch(() => ({}));
          if (!draftRes.ok) throw new Error(draftData.error || "Your design could not be saved.");
        }
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Your brand settings were not saved.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const colorField = (key: "primaryColor" | "accentColor", label: string, hint: string) => {
    const id = `${name}-${key}`;
    return (
      <div>
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} picker`}
            value={HEX.test(brand[key]) ? brand[key] : "#000000"}
            onChange={(e) => set({ [key]: e.target.value } as Partial<BrandIdentity>)}
            className="h-10 w-12 cursor-pointer rounded-lg border border-slate-300 bg-white p-1"
          />
          <input id={id} value={brand[key]} maxLength={7} onChange={(e) => set({ [key]: e.target.value.trim() } as Partial<BrandIdentity>)} className={`${setupInput} font-mono`} aria-describedby={`${id}-hint`} />
        </div>
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      </div>
    );
  };

  return (
    <div>
      {storeLive && (
        <Notice tone="warning" className="mb-4">
          Your store is live: theme, colours and font go to your draft, and change on it when you publish them from Publish or Design. The logo changes as soon as you save this step.
        </Notice>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">Theme</legend>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              Each theme keeps its own look; your colours and content carry over. Your {themeAccess.planName} plan includes{" "}
              {THEMES.filter((t) => canSelectTheme(themeAccess, t.id)).length} of {THEMES.length} themes;{" "}
              <a href={`/dashboard/businesses/${businessId}/theme`} className="rounded font-medium text-slate-800 underline underline-offset-2">compare all themes</a>.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2">
              {THEMES.map((t) => (
                <div key={t.id}>
                  <input type="radio" id={`${name}-theme-${t.id}`} name={`${name}-theme`} value={t.id} checked={brand.themeId === t.id} disabled={!canSelectTheme(themeAccess, t.id)} onChange={() => set({ themeId: t.id })} className="peer sr-only" />
                  <label htmlFor={`${name}-theme-${t.id}`} className={`${card} ${brand.themeId === t.id ? selectedCard : idleCard} ${canSelectTheme(themeAccess, t.id) ? "" : "cursor-not-allowed opacity-70"}`}>
                    <ThemeThumbnail themeId={t.id} primary={brand.primaryColor} accent={brand.accentColor} className="mb-2" />
                    <span className="block text-sm font-semibold text-slate-900">{t.name}</span>
                    <span className="mt-0.5 block text-xs text-slate-600">{t.tagline}</span>
                    {t.id === recommendedTheme && <Pill tone="ember" className="mt-1.5 !whitespace-normal">Suggested for {typeLabel}</Pill>}
                    {!canSelectTheme(themeAccess, t.id) && (
                      <Pill tone="warning" className="mt-1.5">
                        <Icon name="lock" size={12} /> {themeAccess.requiredPlan[t.id] ? `${themeAccess.requiredPlan[t.id]!.name} plan` : "Unavailable"}
                      </Pill>
                    )}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">Colours</legend>
            <p className="mt-0.5 text-xs text-slate-500">Suggested for {typeLabel}. Pick one, or set your own below.</p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-3">
              {palettes.map((p) => (
                <div key={p.id}>
                  <input type="radio" id={`${name}-palette-${p.id}`} name={`${name}-palette`} checked={matching?.id === p.id} onChange={() => set({ primaryColor: p.primary, accentColor: p.accent })} className="peer sr-only" />
                  <label htmlFor={`${name}-palette-${p.id}`} className={`${card} ${matching?.id === p.id ? selectedCard : idleCard}`}>
                    <span className="flex gap-1" aria-hidden="true">
                      <span className="h-6 flex-1 rounded" style={{ background: p.primary }} />
                      <span className="h-6 w-6 rounded" style={{ background: p.accent }} />
                    </span>
                    <span className="mt-1.5 block text-xs font-medium text-slate-800">{p.name}</span>
                  </label>
                </div>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              {colorField("primaryColor", "Primary colour", "Buttons and links.")}
              {colorField("accentColor", "Accent colour", "Badges and highlights.")}
            </div>
            {contrast && !contrast.readable && (
              <p className="mt-2 text-xs text-amber-800">
                White text on this primary colour has a contrast of {contrast.ratio}:1, so your store will use dark text on buttons instead.
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">Font</legend>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {FONTS.map((f) => (
                <div key={f.id}>
                  <input type="radio" id={`${name}-font-${f.id}`} name={`${name}-font`} checked={brand.font === f.id} onChange={() => set({ font: f.id })} className="peer sr-only" />
                  <label htmlFor={`${name}-font-${f.id}`} className={`${card} text-center ${brand.font === f.id ? selectedCard : idleCard}`}>
                    <span className={`block text-lg text-slate-900 ${f.className}`} aria-hidden="true">
                      Aa
                    </span>
                    <span className="block text-xs text-slate-600">{f.name}</span>
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <div>
            <p className="text-sm font-semibold text-slate-900">Logo</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt="Current logo" className="h-12 w-12 rounded-lg border border-slate-200 object-contain" />
              ) : (
                <span className="text-xs text-slate-500">No logo yet: your store name is shown instead.</span>
              )}
              <MediaPicker businessId={businessId} selectedUrl={brand.logoUrl} allowClear contextLabel="logo" onSelect={(m) => set({ logoUrl: m?.url ?? "" })} />
            </div>
          </div>
        </div>

        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SetupPreview view={previewView} config={config} extras={extras} label="Brand preview" />
        </div>
      </div>
      {error && (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      )}
      <SetupFooter onContinue={save} saving={saving} canContinue={colorsValid} />
    </div>
  );
}
