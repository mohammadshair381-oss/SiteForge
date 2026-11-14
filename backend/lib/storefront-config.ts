import { SECTION_TYPE_LABELS, createDefaultSection, generateSectionId, isSafeSectionHref, sectionSchema, type SectionType } from "./sections";
import { responsiveSettingsSchema } from "./section-responsive";
import { z } from "zod";
import { PRESET_KEYS, PRESET_SECTIONS, presetForBusinessType, type PresetKey } from "./storefront-presets";

/**
 * Owner-configurable storefront homepage (shared by server and client; no
 * I/O). Stored in `Business.themeSettings.storefront` (draft, used by the
 * editor and the dashboard preview) and snapshotted to
 * `themeSettings.publishedStorefront` when the owner publishes. The public
 * storefront only ever reads the published copy.
 *
 * Version 2 stores the homepage as an ordered list of section INSTANCES
 * (`sections`), each with its own heading, appearance and content, so owners
 * can add, remove, duplicate, reorder and hide sections. Version 1 configs
 * (fixed keys + top-level featured/categories/promotions/benefits) are
 * upgraded on read; stored data never needs a migration. A config without
 * sections uses the preset for the business type (lib/storefront-presets.ts).
 *
 * Content rules:
 * - links are INTERNAL storefront paths only (no external URLs, no
 *   `javascript:`), and are re-checked at render time against real products,
 *   categories and published pages, so a button never points nowhere;
 * - social links must be HTTPS URLs on the listed networks;
 * - images are checked for business ownership by the API on save;
 * - nothing here can claim reviews, ratings, sales or stock.
 */

export const HOME_SECTION_TYPES = [
  "categories",
  "featured",
  "bestSellers",
  "newArrivals",
  "sale",
  "promotions",
  "benefits",
  "story",
] as const;
/**
 * `block` is a content section from the page builder placed on the homepage. It is
 * not in the list above: upgrades, presets and single homepage suggestions never add one.
 * A website proposal can (lib/ai-website), after the owner reviews it.
 */
export type HomeSectionType = (typeof HOME_SECTION_TYPES)[number] | "block";
/** Page-builder sections an owner may place on the homepage. */
export const HOME_BLOCK_TYPES = ["richText", "imageText", "video", "gallery", "faq", "testimonials", "features", "steps", "stats", "logos", "team", "cta", "contact", "pricing", "newsletter", "spacer", "reviews"] as const satisfies readonly SectionType[];
/** Version-1 names, kept for compatibility. */
export const HOME_SECTION_KEYS = HOME_SECTION_TYPES;
export type HomeSectionKey = HomeSectionType;

export const HOME_SECTION_LABELS: Record<HomeSectionType, string> = {
  categories: "Shop by category",
  featured: "Product collection",
  bestSellers: "Best sellers",
  newArrivals: "New arrivals",
  sale: "On sale",
  promotions: "Promotions",
  benefits: "Shopping information",
  story: "About the business",
  block: "Content",
};

export const HOME_SECTION_DESCRIPTIONS: Record<HomeSectionType, string> = {
  categories: "Category tiles from your products. Shown when at least 2 categories have products.",
  featured: "Products you choose, or your newest products when none are chosen.",
  bestSellers: "Your most-ordered products from paid orders. Shown once at least 2 products have sold.",
  newArrivals: "Products added in the last 45 days.",
  sale: "Products with a real reduced price (original price higher than the price).",
  promotions: "Up to three banners with your own text, image and link.",
  benefits: "Delivery, returns, payment and support information you provide.",
  story: "Your business story. Uses your business description unless you write one here.",
  block: "A content section of your own.",
};

/** Types that may appear only once on the homepage (the rest can be duplicated). */
export const SINGLE_INSTANCE_TYPES: readonly HomeSectionType[] = ["categories", "bestSellers", "newArrivals", "sale", "benefits", "story"];
export const MAX_HOME_SECTIONS = 16;

export const SOCIAL_NETWORKS = ["instagram", "facebook", "x", "youtube", "tiktok", "linkedin", "pinterest"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

const SOCIAL_HOSTS: Record<SocialNetwork, string[]> = {
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.com"],
  x: ["x.com", "twitter.com"],
  youtube: ["youtube.com", "youtu.be"],
  tiktok: ["tiktok.com"],
  linkedin: ["linkedin.com"],
  pinterest: ["pinterest.com"],
};

const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const text = (max: number) => z.string().trim().max(max).refine(noHtml, "HTML is not supported");

/** Internal storefront path: "/", "/products?category=Tea", "/product/mug", "/about", "/cart". */
export const internalHrefSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === "" || /^\/(?!\/)[A-Za-z0-9\-._~/?=&%+]*$/.test(value), "Use a link inside your store, such as /products");

const imageUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (value === "") return true;
    // The only same-origin images that load on a store host are platform
    // local-media URLs (/api is not rewritten to /store by the middleware).
    if (value.startsWith("/")) return /^\/api\/businesses\/[a-f0-9]{24}\/local-media\?key=[A-Za-z0-9+/=%]+$/i.test(value);
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an image from your media library");

const ctaSchema = z.object({ label: text(40).prefault(""), href: internalHrefSchema.prefault("") });

const promotionSchema = z.object({
  enabled: z.boolean().prefault(true),
  eyebrow: text(40).prefault(""),
  title: text(80).prefault(""),
  text: text(200).prefault(""),
  imageUrl: imageUrlSchema.prefault(""),
  imageAlt: text(160).prefault(""),
  cta: ctaSchema.prefault({}),
});

/** Section appearance (presentation only; each theme keeps its own style). */
export const sectionAppearanceSchema = z.object({
  background: z.enum(["default", "alt", "accent"]).prefault("default"),
  spacing: z.enum(["compact", "normal", "spacious"]).prefault("normal"),
  align: z.enum(["left", "center"]).prefault("left"),
});
export type SectionAppearance = z.infer<typeof sectionAppearanceSchema>;

export const HOME_SECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const sectionBase = {
  id: z.string().regex(HOME_SECTION_ID_PATTERN, "Invalid section id"),
  enabled: z.boolean().prefault(true),
  /** The owner's name for this section in the editor. Never shown to visitors. */
  name: text(60).optional(),
  /** Spacing, alignment, columns, width and visibility per screen size (lib/section-responsive.ts). */
  responsive: responsiveSettingsSchema.optional(),
  /** Heading shown on the store ("" = the default for the section type). */
  title: text(80).prefault(""),
  /** Small line above the heading. */
  subtitle: text(160).prefault(""),
  appearance: sectionAppearanceSchema.prefault({}),
};
const railLimit = z.number().int().min(2).max(24).prefault(8);

export const homeSectionSchema = z.discriminatedUnion("type", [
  z.object({
    ...sectionBase,
    type: z.literal("categories"),
    /** Chosen categories (with optional images); empty = the largest categories. */
    categories: z.array(z.object({ name: text(80).pipe(z.string().min(1)), imageUrl: imageUrlSchema.prefault("") })).max(12).prefault([]),
    limit: z.number().int().min(2).max(12).prefault(8),
  }),
  z.object({
    ...sectionBase,
    type: z.literal("featured"),
    productIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(24).prefault([]),
    limit: railLimit,
  }),
  z.object({ ...sectionBase, type: z.literal("bestSellers"), limit: railLimit }),
  z.object({ ...sectionBase, type: z.literal("newArrivals"), limit: railLimit }),
  z.object({ ...sectionBase, type: z.literal("sale"), limit: railLimit }),
  z.object({ ...sectionBase, type: z.literal("promotions"), items: z.array(promotionSchema).max(3).prefault([]) }),
  z.object({
    ...sectionBase,
    type: z.literal("benefits"),
    shipping: text(160).prefault(""),
    returns: text(160).prefault(""),
    support: text(160).prefault(""),
    guarantee: text(160).prefault(""),
  }),
  z.object({ ...sectionBase, type: z.literal("story"), text: text(2000).prefault("") }),
  z.object({
    ...sectionBase,
    type: z.literal("block"),
    block: sectionSchema.refine((block) => (HOME_BLOCK_TYPES as readonly string[]).includes(block.type), "This section cannot be used on the homepage"),
  }),
]);
export type HomeSection = z.infer<typeof homeSectionSchema>;

/** Presentation defaults per section type (presets, new sections, upgrades). */
const TYPE_DEFAULTS: Partial<Record<HomeSectionType, { subtitle?: string; appearance?: Partial<SectionAppearance> }>> = {
  bestSellers: { subtitle: "Most ordered", appearance: { background: "alt" } },
  newArrivals: { subtitle: "Just added" },
  sale: { subtitle: "Reduced prices", appearance: { background: "alt" } },
  benefits: { appearance: { background: "alt" } },
  story: { subtitle: "Our story", appearance: { spacing: "spacious", align: "center" } },
};

/** Fills missing subtitle/appearance with the type's defaults (raw objects). */
function withTypeDefaults<T extends { type: string; subtitle?: unknown; appearance?: unknown }>(raw: T): T {
  const defaults = TYPE_DEFAULTS[raw.type as HomeSectionType];
  if (!defaults) return raw;
  return {
    ...raw,
    subtitle: raw.subtitle ?? defaults.subtitle ?? "",
    appearance: { ...(defaults.appearance ?? {}), ...((raw.appearance as object | undefined) ?? {}) },
  };
}

/**
 * Converts a version-1 config (fixed section keys, top-level featured
 * products/categories/promotions/benefits) into version 2. Pure; returns
 * other values unchanged so the v2 schema validates them.
 */
function upgradeLegacyConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const v1Sections = Array.isArray(v.sections) && v.sections.some((s) => s && typeof s === "object" && "key" in (s as object));
  const legacy = v.version === 1 || v1Sections || "featuredProductIds" in v || "benefits" in v || "promotions" in v || "categories" in v;
  if (!legacy) return value;

  const order: Array<{ key: string; enabled: boolean }> = [];
  for (const raw of Array.isArray(v.sections) ? v.sections : []) {
    const s = raw as { key?: unknown; enabled?: unknown };
    if (typeof s?.key === "string") order.push({ key: s.key, enabled: s.enabled !== false });
  }
  for (const key of HOME_SECTION_TYPES) {
    if (!order.some((o) => o.key === key)) order.push({ key, enabled: true });
  }
  const idFor = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const sections = order.map(({ key, enabled }) => {
    const base = withTypeDefaults({ id: idFor(key), type: key, enabled });
    switch (key) {
      case "featured":
        return { ...base, productIds: Array.isArray(v.featuredProductIds) ? v.featuredProductIds : [] };
      case "categories":
        return { ...base, categories: Array.isArray(v.categories) ? v.categories : [] };
      case "promotions":
        return { ...base, items: Array.isArray(v.promotions) ? v.promotions : [] };
      case "benefits":
        return { ...base, ...(v.benefits && typeof v.benefits === "object" ? (v.benefits as object) : {}) };
      default:
        return base;
    }
  });
  const { featuredProductIds: _f, categories: _c, promotions: _p, benefits: _b, ...rest } = v;
  void _f;
  void _c;
  void _p;
  void _b;
  return { ...rest, version: 2, sections };
}

/**
 * Header and footer arrangements an owner may pick instead of their theme's own. Each theme keeps
 * its colours, type and spacing. Only arrangements that are built from the skin's own tokens are
 * offered: the rest assume one theme's look, such as a dark glass bar or a heavy border.
 */
export const HEADER_LAYOUTS = ["theme", "minimal", "centered", "signboard"] as const;
export const FOOTER_LAYOUTS = ["theme", "columns", "postcard"] as const;

const footerHrefSchema = z
  .string()
  .trim()
  .max(300)
  .refine((value) => value === "" || isSafeSectionHref(value), "Use a link inside your store, or a full https:// address");

const configShape = z
  .object({
    version: z.literal(2).prefault(2),
    /** The preset this layout started from (informational). */
    preset: z.enum(PRESET_KEYS).nullable().prefault(null),
    announcement: z
      .object({
        enabled: z.boolean().prefault(false),
        text: text(140).prefault(""),
        href: internalHrefSchema.prefault(""),
        /** "brand" uses the store's main colour; "theme" keeps the theme's own bar. */
        tone: z.enum(["theme", "brand"]).prefault("theme"),
      })
      .prefault({}),
    /**
     * Choices the themes can honour. "theme" always means what the theme does by itself, so a
     * store that changes nothing keeps its theme's identity. See `HEADER_LAYOUTS` for why only
     * some arrangements are offered.
     */
    header: z
      .object({
        layout: z.enum(HEADER_LAYOUTS).prefault("theme"),
        logoDisplay: z.enum(["auto", "logo", "name", "both"]).prefault("auto"),
        logoSize: z.enum(["small", "medium", "large"]).prefault("medium"),
        navAlign: z.enum(["theme", "left", "center", "right"]).prefault("theme"),
        sticky: z.enum(["theme", "on", "off"]).prefault("theme"),
      })
      .prefault({}),
    hero: z
      .object({
        enabled: z.boolean().prefault(true),
        eyebrow: text(60).prefault(""),
        headline: text(120).prefault(""),
        description: text(300).prefault(""),
        imageUrl: imageUrlSchema.prefault(""),
        mobileImageUrl: imageUrlSchema.prefault(""),
        imageAlt: text(160).prefault(""),
        align: z.enum(["left", "center"]).prefault("left"),
        /** Darkening over the image, in percent (text stays readable). */
        overlay: z.number().int().min(0).max(80).prefault(40),
        primaryCta: ctaSchema.prefault({}),
        secondaryCta: ctaSchema.prefault({}),
      })
      .prefault({}),
    /** Homepage sections in order. Absent = the business-type preset. */
    sections: z.array(homeSectionSchema).max(MAX_HOME_SECTIONS).optional(),
    policies: z.object({ shipping: text(4000).prefault(""), returns: text(4000).prefault("") }).prefault({}),
    /** Search and sharing for the homepage; empty fields use the business's details. */
    seo: z.object({ title: text(160).prefault(""), description: text(320).prefault(""), imageUrl: imageUrlSchema.prefault("") }).prefault({}),
    footer: z
      .object({
        about: text(400).prefault(""),
        /** Replaces the usual copyright line when set. */
        copyright: text(160).prefault(""),
        layout: z.enum(FOOTER_LAYOUTS).prefault("theme"),
        /** The owner's own link columns, shown with the automatic ones. */
        columns: z
          .array(
            z.object({
              title: text(40).prefault(""),
              links: z.array(z.object({ label: text(60).prefault(""), href: footerHrefSchema.prefault("") })).max(8).prefault([]),
            }),
          )
          .max(4)
          .prefault([]),
        showContact: z.boolean().prefault(true),
        showSocial: z.boolean().prefault(true),
        showShopLinks: z.boolean().prefault(true),
        showMenuLinks: z.boolean().prefault(true),
        social: z
          .object(Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, z.string().trim().max(300).prefault("")])) as unknown as Record<SocialNetwork, z.ZodDefault<z.ZodString>>)
          .prefault({}),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    const singles = new Set<string>();
    (config.sections ?? []).forEach((section, index) => {
      if (ids.has(section.id)) ctx.addIssue({ code: "custom", message: "Each section needs its own id", path: ["sections", index, "id"] });
      ids.add(section.id);
      if (SINGLE_INSTANCE_TYPES.includes(section.type)) {
        if (singles.has(section.type)) ctx.addIssue({ code: "custom", message: `Only one ${HOME_SECTION_LABELS[section.type]} section is allowed`, path: ["sections", index] });
        singles.add(section.type);
      }
      if (section.type === "categories") {
        const names = new Set<string>();
        section.categories.forEach((category, ci) => {
          const key = category.name.toLowerCase();
          if (names.has(key)) ctx.addIssue({ code: "custom", message: "Each category can appear once", path: ["sections", index, "categories", ci] });
          names.add(key);
        });
      }
    });
    for (const network of SOCIAL_NETWORKS) {
      const value = config.footer.social[network];
      if (value && !isAllowedSocialUrl(network, value)) {
        ctx.addIssue({ code: "custom", message: `Use an https link to your ${network} profile`, path: ["footer", "social", network] });
      }
    }
  });

/** Input/storage schema (accepts version-1 configs and upgrades them). */
export const storefrontConfigSchema = z.preprocess(upgradeLegacyConfig, configShape);
export type StorefrontConfigInput = z.infer<typeof configShape>;
/** A resolved config: sections always present. */
export type StorefrontConfig = Omit<StorefrontConfigInput, "sections"> & { sections: HomeSection[] };

export function isAllowedSocialUrl(network: SocialNetwork, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    return SOCIAL_HOSTS[network].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/** Sections of a preset, parsed with defaults. */
export function presetSections(preset: PresetKey): HomeSection[] {
  return PRESET_SECTIONS[preset].map((s) => homeSectionSchema.parse(withTypeDefaults({ ...s })));
}

/** A resolved config with a fixed key order (stable for comparison and storage). */
function resolved(input: StorefrontConfigInput, sections: HomeSection[]): StorefrontConfig {
  return {
    version: input.version,
    preset: input.preset,
    announcement: input.announcement,
    header: input.header,
    hero: input.hero,
    sections,
    policies: input.policies,
    seo: input.seo,
    footer: input.footer,
  };
}

/** The full starting config for a business type (hero texts come from the business). */
export function presetConfig(businessType: string | null | undefined): StorefrontConfig {
  const preset = presetForBusinessType(businessType);
  return resolved(configShape.parse({ preset }), presetSections(preset));
}

/** General-retail preset (kept for compatibility). */
export const DEFAULT_STOREFRONT_CONFIG: StorefrontConfig = presetConfig("retail");

/**
 * Reads a stored config defensively: nothing stored, or anything invalid,
 * gives the business-type preset (a broken stored value must never break the
 * storefront). A valid config without sections also gets the preset sections.
 */
export function readStorefrontConfig(value: unknown, businessType?: string | null): StorefrontConfig {
  if (value === undefined || value === null) return presetConfig(businessType);
  const parsed = storefrontConfigSchema.safeParse(value);
  if (!parsed.success) return presetConfig(businessType);
  const preset = parsed.data.preset ?? presetForBusinessType(businessType);
  return resolved(parsed.data, parsed.data.sections ?? presetSections(preset));
}

/**
 * False when something is stored but cannot be read. `readStorefrontConfig` then answers with the
 * starting layout, which must not be saved or published in its place without keeping what was there.
 */
export function storedConfigIsReadable(value: unknown): boolean {
  return value === undefined || value === null || storefrontConfigSchema.safeParse(value).success;
}

/** A fresh section of a type with a unique id among `existing`. */
/** What a homepage section is called in the editor (a content block goes by its own heading). */
export function homeSectionName(section: HomeSection): string {
  if (section.name) return section.name;
  if (section.type !== "block") return section.title || HOME_SECTION_LABELS[section.type];
  const settings = section.block.settings as { title?: unknown; headline?: unknown };
  const own = typeof settings.title === "string" && settings.title ? settings.title : typeof settings.headline === "string" ? settings.headline : "";
  return own || SECTION_TYPE_LABELS[section.block.type];
}

export function createHomeSection(type: HomeSectionType, existing: ReadonlyArray<{ id: string }>, blockType?: SectionType): HomeSection {
  const base = type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  let id = base;
  for (let n = 2; existing.some((s) => s.id === id); n++) id = `${base}-${n}`;
  if (type === "block") return homeSectionSchema.parse({ id, type, block: createDefaultSection(blockType ?? "richText", 0) });
  return homeSectionSchema.parse(withTypeDefaults({ id, type }));
}

/** A copy of a section with a new id (types that may appear more than once). */
export function duplicateHomeSection(section: HomeSection, existing: ReadonlyArray<{ id: string }>): HomeSection | null {
  if (SINGLE_INSTANCE_TYPES.includes(section.type)) return null;
  const root = section.id.replace(/-\d+$/, "");
  let id = `${root}-2`;
  for (let n = 3; existing.some((s) => s.id === id); n++) id = `${root}-${n}`;
  const copy = { ...structuredClone(section), id };
  if (copy.type === "block") copy.block = { ...copy.block, id: generateSectionId(copy.block.type) } as typeof copy.block;
  return copy;
}

/** Section order with every key exactly once (version-1 helper, used for upgrades). */
export function orderedHomeSections(config: { sections?: Array<{ key?: string; type?: string; enabled?: boolean }> }): Array<{ key: HomeSectionType; enabled: boolean }> {
  const out: Array<{ key: HomeSectionType; enabled: boolean }> = [];
  for (const s of config.sections ?? []) {
    const key = (s.key ?? s.type) as HomeSectionType;
    if ((HOME_SECTION_TYPES as readonly string[]).includes(key) && !out.some((o) => o.key === key)) out.push({ key, enabled: s.enabled !== false });
  }
  for (const key of HOME_SECTION_TYPES) {
    if (!out.some((s) => s.key === key)) out.push({ key, enabled: true });
  }
  return out;
}

/** What an internal link may point at, resolved from the store's real data. */
export interface LinkTargets {
  productSlugs: ReadonlySet<string>;
  /** Lower-cased category names that have active products. */
  categories: ReadonlySet<string>;
  /** Published page slugs. */
  pageSlugs: ReadonlySet<string>;
  /** Whether the store has shipping/returns policy text (the /policies page). */
  hasPolicies: boolean;
  /** Slugs of ACTIVE managed categories with products (/category/<slug>). */
  categorySlugs?: ReadonlySet<string>;
}

/**
 * Returns the href only if it leads somewhere real in this store right now;
 * otherwise null (the caller hides the button).
 */
export function resolveInternalHref(href: string, targets: LinkTargets): string | null {
  if (!href || !internalHrefSchema.safeParse(href).success) return null;
  const url = new URL(href, "http://store.invalid");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/cart") return href;
  if (path === "/products") {
    const category = url.searchParams.get("category");
    if (category && !targets.categories.has(category.toLowerCase())) return null;
    return href;
  }
  const productMatch = path.match(/^\/product\/([^/]+)$/);
  if (productMatch) return targets.productSlugs.has(decodeURIComponent(productMatch[1])) ? href : null;
  if (path === "/policies") return targets.hasPolicies ? href : null;
  const categoryMatch = path.match(/^\/category\/([^/]+)$/);
  if (categoryMatch) return targets.categorySlugs?.has(decodeURIComponent(categoryMatch[1])) ? href : null;
  const pageMatch = path.match(/^\/([^/]+)$/);
  if (pageMatch && targets.pageSlugs.has(decodeURIComponent(pageMatch[1]))) return href;
  return null;
}
