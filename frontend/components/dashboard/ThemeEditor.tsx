"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { resolveEditorNavigation, type EditorPreviewPage } from "@/lib/editor-preview";
import { DEFAULT_THEME_SETTINGS, type StorefrontProduct, type StorefrontView } from "@/lib/storefront";
import type { Section } from "@/lib/sections";
import type { ThemeSettings } from "@/models/Business";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import { Button, focusRing } from "@/components/ui/Button";
import { labelClass, inputClass } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Surface";

interface BaseBusiness {
  name: string;
  subdomain: string;
  category: string;
  description: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  currency: string;
}

export default function ThemeEditor({
  businessId,
  initialThemeId,
  initialSettings,
  sections,
  pages,
  base,
  products,
  canManage,
  removeBranding,
}: {
  businessId: string;
  initialThemeId: string;
  initialSettings: ThemeSettings;
  sections: Section[];
  pages: EditorPreviewPage[];
  base: BaseBusiness;
  products: StorefrontProduct[];
  canManage: boolean;
  removeBranding: boolean;
}) {
  const router = useRouter();
  const colorId = useId();
  const accentId = useId();
  const headlineId = useId();
  const subheadlineId = useId();
  const showProductsId = useId();
  // The theme itself is chosen in the theme marketplace above this form.
  const themeId = initialThemeId;
  const [settings, setSettings] = useState<ThemeSettings>(initialSettings);
  const [loading, setLoading] = useState(false);
  const saveInFlightRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigation = useMemo(
    () => resolveEditorNavigation(settings.navigation, pages),
    [settings.navigation, pages],
  );

  const previewView: StorefrontView = useMemo(
    () => ({
      id: businessId,
      name: base.name,
      subdomain: base.subdomain,
      category: base.category,
      about: base.description || settings.about || "",
      logoUrl: base.logoUrl,
      contactEmail: base.contactEmail,
      phone: base.phone,
      address: base.address,
      currency: base.currency,
      removeBranding,
      themeId: themeId as StorefrontView["themeId"],
      theme: { ...DEFAULT_THEME_SETTINGS, ...settings },
      products,
      navigation,
    }),
    [businessId, base, settings, themeId, products, removeBranding, navigation],
  );

  function update<K extends keyof ThemeSettings>(key: K, value: ThemeSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (saveInFlightRef.current || loading) return;
    saveInFlightRef.current = true;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          themeSettings: {
            primaryColor: settings.primaryColor,
            accentColor: settings.accentColor,
            heroHeadline: settings.heroHeadline,
            heroSubheadline: settings.heroSubheadline,
            showProducts: settings.showProducts,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to save brand settings");
      setNotice("Brand settings saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save brand settings");
    } finally {
      saveInFlightRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Brand colours and welcome message</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Adjust your colours in the current theme. The preview uses your homepage draft and draft navigation; saved colours apply to the live store immediately.</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="sr-only" role="status" aria-live="polite">
          {notice ?? ""}
        </div>
        <div className="sr-only" role="alert" aria-live="assertive">
          {error ?? ""}
        </div>
        {!canManage && (
          <Notice tone="info" className="mb-4">
            Only owners and managers can edit theme settings. You can still review
            the preview below.
          </Notice>
        )}

        <fieldset disabled={!canManage || loading} className="space-y-6">
          <legend className="sr-only">Theme settings</legend>
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Brand and welcome message</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              These choices apply to the storefront theme, not individual page sections.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={colorId} className={labelClass}>
                Primary color
              </label>
              <input
                id={colorId}
                type="color"
                value={settings.primaryColor ?? "#4f46e5"}
                onChange={(e) => update("primaryColor", e.target.value)}
                className={`h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${focusRing}`}
              />
            </div>
            <div>
              <label htmlFor={accentId} className={labelClass}>
                Accent color
              </label>
              <input
                id={accentId}
                type="color"
                value={settings.accentColor ?? "#0ea5e9"}
                onChange={(e) => update("accentColor", e.target.value)}
                className={`h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 ${focusRing}`}
              />
            </div>
          </div>
          <div>
            <label htmlFor={headlineId} className={labelClass}>
              Welcome headline
            </label>
            <input
              id={headlineId}
              value={settings.heroHeadline ?? ""}
              onChange={(e) => update("heroHeadline", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={subheadlineId} className={labelClass}>
              Welcome message
            </label>
            <input
              id={subheadlineId}
              value={settings.heroSubheadline ?? ""}
              onChange={(e) => update("heroSubheadline", e.target.value)}
              className={inputClass}
            />
          </div>
          <label htmlFor={showProductsId} className="flex min-h-10 items-center gap-2 text-sm text-slate-800">
            <input
              id={showProductsId}
              type="checkbox"
              checked={settings.showProducts ?? true}
              onChange={(e) => update("showProducts", e.target.checked)}
              className={`h-4 w-4 rounded ${focusRing}`}
            />
            Show products on the website
          </label>
          {error && <Notice tone="danger">{error}</Notice>}
          {notice && <Notice tone="success">{notice}</Notice>}
          <Button block onClick={save} disabled={loading}>
            {loading ? "Saving…" : "Save brand settings"}
          </Button>
        </div>
        </fieldset>
      </div>

      <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex min-h-10 items-center justify-between gap-2 border-b border-slate-200 px-4 py-2 text-xs">
          <span className="font-medium text-slate-700">Preview of your colours</span>
          <span className="text-slate-500">Not saved until you save brand settings</span>
        </div>
        <div className="max-h-[80vh] overflow-y-auto">
          <ThemeRenderer view={previewView} productHrefBase="#" preview sections={sections} />
        </div>
      </div>
      </div>
    </div>
  );
}
