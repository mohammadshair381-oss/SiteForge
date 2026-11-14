import { isDefaultStoreDesign, pickStoreDesign, readDesignDraft, readStoreDesign, type StoreDesign } from "./design-settings";
import { resolveNavItems, type ResolvedNavItem, type StoredNavigation } from "./navigation";
import { getThemeMeta } from "./themes";
import type { BusinessDoc, ThemeSettings } from "@/models/Business";
import type { ProductDoc } from "@/models/Product";
import type { ThemeId } from "./constants";
import { availabilityOf, type ProductAvailability } from "./inventory-rules";
import { effectiveCompareAt, effectivePrice, variantLabel } from "./product-variants";

export interface StorefrontProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  currency: string;
  imageUrl: string;
  /** Owner-written alt text for the main image (absent = the product name). */
  imageAlt?: string;
  category: string;
  /** Original price when on sale (only set when greater than `price`). */
  compareAtPrice?: number | null;
  /**
   * Derived availability; the exact stock count is never part of the public
   * view (client components receive it). Optional for hand-built views.
   */
  availability?: ProductAvailability;
  /** ISO timestamp, used for "new arrivals". */
  createdAt?: string | null;
  /** Product options (empty/absent = simple product). */
  options?: Array<{ name: string; values: string[] }>;
  /** Purchasable (non-archived) variants; availability only, never counts. */
  variants?: StorefrontVariant[];
  /** Approved-review summary; absent when there are no approved reviews. */
  rating?: { average: number; count: number };
  /** A second, different product image (card hover); absent when there is none. */
  hoverImageUrl?: string;
}

export interface StorefrontVariant {
  id: string;
  options: Array<{ name: string; value: string }>;
  label: string;
  price: number;
  compareAtPrice: number | null;
  availability: ProductAvailability;
  /** Its own picture and SKU, when the store set them. */
  imageUrl?: string;
  sku?: string;
}

export interface StorefrontTheme extends ThemeSettings {}

// Re-export section type for storefront consumers.
export type { Section } from "./sections";

export type StorefrontNavigationItem = ResolvedNavItem;

export interface StorefrontNavigation {
  header: StorefrontNavigationItem[];
  footer: StorefrontNavigationItem[];
}

export { availabilityOf, LOW_STOCK_DEFAULT as LOW_STOCK_THRESHOLD, type ProductAvailability } from "./inventory-rules";

export interface StoreReview {
  id: string;
  authorName: string;
  rating: number;
  title: string;
  body: string;
  productName: string;
}

export interface StorefrontView {
  id: string;
  name: string;
  subdomain: string;
  category: string;
  about: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  /** The owner's own words, shown in the footer. */
  serviceArea?: string;
  /** Approved reviews from real orders, for a reviews section. */
  reviews?: StoreReview[];
  currency: string;
  themeId: ThemeId;
  theme: StorefrontTheme;
  products: StorefrontProduct[];
  removeBranding: boolean;
  navigation?: StorefrontNavigation;
  /** No colours chosen yet: the store follows its theme's palette. */
  usesThemeColors?: boolean;
}

/**
 * The colours a store shows. While a store still has the platform's starting
 * colours, nobody has chosen any: it uses its theme's own palette, and follows
 * it when the theme changes. Any colour the owner picks is used as it is.
 */
export function themeBrandColors(themeId: ThemeId, settings: { primaryColor?: string; accentColor?: string }): { primaryColor: string; accentColor: string; usesThemeColors: boolean } {
  const primary = settings.primaryColor ?? DEFAULT_THEME_SETTINGS.primaryColor;
  const accent = settings.accentColor ?? DEFAULT_THEME_SETTINGS.accentColor;
  if (primary.toLowerCase() !== DEFAULT_THEME_SETTINGS.primaryColor || accent.toLowerCase() !== DEFAULT_THEME_SETTINGS.accentColor) {
    return { primaryColor: primary, accentColor: accent, usesThemeColors: false };
  }
  const palette = getThemeMeta(themeId).palette;
  return { primaryColor: palette[1], accentColor: palette[2], usesThemeColors: true };
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  primaryColor: "#4f46e5",
  accentColor: "#0ea5e9",
  font: "sans",
  heroHeadline: "Welcome to our store",
  heroSubheadline: "Quality you can trust, service you will love.",
  about: "",
  showProducts: true,
};

export function toStorefrontView(
  business: BusinessDoc,
  products: ProductDoc[],
  removeBranding: boolean,
  pages?: Array<{ _id: unknown; title: string; slug: string; status: string }>,
  options?: { useDraft?: boolean },
): StorefrontView {
  // The storefront homepage config (draft and published) is read separately
  // (lib/storefront-home.ts) and must not ride along in `theme`, which client
  // components receive: an unpublished draft would reach the public page.
  // The same goes for the design draft: only previews may read it.
  const { storefront: _draftStorefront, publishedStorefront: _publishedStorefront, legacySections: _legacySections, navigationDraftOnly: _navigationDraftOnly, designTokensDraftOnly: _designTokensDraftOnly, designDraft: storedDesignDraft, design: storedDesign, ...storedTheme } =
    (business.themeSettings ?? {}) as ThemeSettings & { storefront?: unknown; publishedStorefront?: unknown; legacySections?: unknown; navigationDraftOnly?: unknown; designTokensDraftOnly?: unknown; designDraft?: unknown; design?: unknown };
  void _draftStorefront;
  void _publishedStorefront;
  void _legacySections;
  void _navigationDraftOnly;
  void _designTokensDraftOnly;
  const useDraft = options?.useDraft === true;
  const designDraft = useDraft ? readDesignDraft(storedDesignDraft) : null;
  const themeId = designDraft?.themeId ?? business.themeId;
  const theme: ThemeSettings = {
    ...DEFAULT_THEME_SETTINGS,
    ...storedTheme,
    ...(designDraft
      ? designDraft.useThemeColors
        ? { primaryColor: DEFAULT_THEME_SETTINGS.primaryColor, accentColor: DEFAULT_THEME_SETTINGS.accentColor }
        : { primaryColor: designDraft.primaryColor, accentColor: designDraft.accentColor }
      : {}),
  };
  const colors = themeBrandColors(themeId, theme);
  theme.primaryColor = colors.primaryColor;
  theme.accentColor = colors.accentColor;
  const design = designDraft ?? readStoreDesign(storedDesign);
  if (!isDefaultStoreDesign(design)) {
    (theme as ThemeSettings & { design?: StoreDesign }).design = pickStoreDesign(design);
  }

  // Use published design tokens for public storefront, draft for preview
  const businessThemeSettings = (business.themeSettings ?? {}) as unknown as Record<string, unknown>;
  const publishedDesignTokens = businessThemeSettings.publishedDesignTokens;
  const draftDesignTokens = businessThemeSettings.designTokens;
  if (useDraft) {
    // Preview: use draft design tokens
    if (draftDesignTokens && typeof draftDesignTokens === "object") {
      (theme as unknown as Record<string, unknown>).designTokens = draftDesignTokens;
    }
  } else {
    // Public: use published design tokens if available, fall back to the saved ones
    // for legacy stores, unless those are known to be an unpublished draft.
    if (publishedDesignTokens && typeof publishedDesignTokens === "object") {
      (theme as unknown as Record<string, unknown>).designTokens = publishedDesignTokens;
    } else if (businessThemeSettings.designTokensDraftOnly) {
      delete (theme as unknown as Record<string, unknown>).designTokens;
    }
  }

  // Resolve navigation: draft for preview, published for public (with legacy fallback)
  const navConfig = (useDraft
    ? businessThemeSettings.navigation ?? (theme as unknown as Record<string, unknown>).navigation
    : businessThemeSettings.publishedNavigation ?? (businessThemeSettings.navigationDraftOnly ? undefined : businessThemeSettings.navigation)) as StoredNavigation | undefined;
  // The raw menus (draft labels included) reach no browser: only the resolved links below do.
  const rawTheme = theme as unknown as Record<string, unknown>;
  delete rawTheme.navigation;
  delete rawTheme.publishedNavigation;
  delete rawTheme.publishedDesignTokens;
  const pageMap = new Map((pages ?? []).map((p) => [String(p._id), { title: p.title, slug: p.slug, status: p.status }]));
  const navigation: StorefrontNavigation | undefined = navConfig
    ? {
        header: resolveNavItems(navConfig.header, pageMap, { publishedOnly: true }),
        footer: resolveNavItems(navConfig.footer, pageMap, { publishedOnly: true }),
      }
    : undefined;

  // Only include navigation if it has items
  const hasNav = navigation && (navigation.header.length > 0 || navigation.footer.length > 0);

  return {
    id: String(business._id),
    usesThemeColors: colors.usesThemeColors,
    name: business.name,
    subdomain: business.subdomain,
    category: business.category,
    about: business.description || theme.about,
    logoUrl: business.logoUrl,
    contactEmail: business.contactEmail,
    phone: business.phone,
    address: business.address,
    serviceArea: business.serviceArea ?? "",
    currency: business.currency,
    themeId,
    theme,
    products: products.map((product) => ({
      id: String(product._id),
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: product.price,
      currency: product.currency || business.currency,
      imageUrl: product.imageUrl || product.images?.[0] || "",
      ...(product.imageAlt ? { imageAlt: product.imageAlt } : {}),
      category: product.category,
      compareAtPrice:
        typeof product.compareAtPrice === "number" && product.compareAtPrice > product.price ? product.compareAtPrice : null,
      // A variant product is available through its non-archived variants only.
      availability: availabilityOf(
        Array.isArray(product.options) && product.options.length > 0
          ? (product.variants ?? []).filter((v) => !v.archived).reduce((n, v) => n + Number(v.stock || 0), 0)
          : product.stock,
        product.lowStockThreshold,
      ),
      ...(Array.isArray(product.options) && product.options.length > 0
        ? {
            options: product.options.map((o) => ({ name: o.name, values: [...o.values] })),
            variants: (product.variants ?? [])
              .filter((v) => !v.archived)
              .map((v) => ({
                id: String(v._id),
                options: v.options.map((o) => ({ name: o.name, value: o.value })),
                label: variantLabel(v.options),
                price: effectivePrice(product.price, v),
                compareAtPrice: effectiveCompareAt(product, v),
                availability: availabilityOf(v.stock, product.lowStockThreshold),
                ...(v.imageUrl ? { imageUrl: v.imageUrl } : {}),
                ...(v.sku ? { sku: v.sku } : {}),
              })),
          }
        : {}),
      ...secondImage(product.imageUrl || product.images?.[0] || "", product.images),
      ...(typeof product.ratingAverage === "number" && Number(product.ratingCount) > 0
        ? { rating: { average: product.ratingAverage, count: Number(product.ratingCount) } }
        : {}),
      createdAt: (product as { createdAt?: Date }).createdAt ? new Date((product as { createdAt?: Date }).createdAt as Date).toISOString() : null,
    })),
    removeBranding,
    ...(hasNav ? { navigation } : {}),
  };
}

/** The first product image that differs from the main one (real images only). */
function secondImage(main: string, images: unknown): { hoverImageUrl?: string } {
  const other = (Array.isArray(images) ? images : []).find((src): src is string => typeof src === "string" && src.length > 0 && src !== main);
  return other ? { hoverImageUrl: other } : {};
}
