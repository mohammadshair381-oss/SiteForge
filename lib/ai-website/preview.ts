import { THEME_IDS } from "@/lib/constants";
import { pickStoreDesign } from "@/lib/design-settings";
import { getVisibleSections, type Section } from "@/lib/sections";
import { DEFAULT_THEME_SETTINGS, themeBrandColors, type StorefrontView } from "@/lib/storefront";
import type { CommerceExtras } from "@/lib/storefront-home";
import { CLASSIC_PREVIEW_ID, type WebsitePreview } from "./blueprint";

/**
 * A store view with a website proposal laid over it, for the one shared renderer (pure; safe in client
 * components). Nothing is saved. `themeId` tries the proposal in another theme, for looking only.
 */
export function websitePreviewView(view: StorefrontView, preview: WebsitePreview, themeId?: string | null): StorefrontView {
  const chosen = themeId && (THEME_IDS as readonly string[]).includes(themeId) ? (themeId as StorefrontView["themeId"]) : preview.design.themeId;
  const colors = preview.design.useThemeColors
    ? themeBrandColors(chosen, DEFAULT_THEME_SETTINGS)
    : { primaryColor: preview.design.primaryColor, accentColor: preview.design.accentColor, usesThemeColors: false };
  const font = preview.design.displayFont === preview.design.bodyFont && (preview.design.displayFont === "serif" || preview.design.displayFont === "mono") ? preview.design.displayFont : "sans";
  return {
    ...view,
    themeId: chosen,
    usesThemeColors: colors.usesThemeColors,
    theme: { ...view.theme, primaryColor: colors.primaryColor, accentColor: colors.accentColor, font, design: pickStoreDesign(preview.design) } as StorefrontView["theme"],
    navigation: preview.navigation,
  };
}

/** The proposal's pages count as this store's pages, so its links are not left out of the preview. */
export function websitePreviewExtras(extras: CommerceExtras, preview: WebsitePreview): CommerceExtras {
  return { ...extras, pageSlugs: [...new Set([...(extras.pageSlugs ?? []), ...preview.pages.map((page) => page.slug)])] };
}

/** The sections of one previewed page. None means the proposed homepage. */
export function websitePreviewSections(preview: WebsitePreview, pageId: string | null | undefined): Section[] {
  if (pageId === CLASSIC_PREVIEW_ID) return getVisibleSections(preview.classicHomepage?.sections ?? []);
  return getVisibleSections(preview.pages.find((page) => page.id === pageId)?.sections ?? []);
}
