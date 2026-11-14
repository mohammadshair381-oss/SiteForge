import type { ResolvedNavItem } from "./navigation";
import type { Section } from "./sections";
import { BUSINESS_CATEGORIES } from "./constants";
import { storeVocabulary, type StoreVocabulary } from "./storefront-presets";
import type { ResponsiveSettings } from "./section-responsive";
import type { StoreReview, StorefrontProduct, StorefrontView } from "@/lib/storefront";
import {
  readStorefrontConfig,
  resolveInternalHref,
  SOCIAL_NETWORKS,
  type HomeSection,
  type HomeSectionType,
  type LinkTargets,
  type SectionAppearance,
  type SocialNetwork,
  type StorefrontConfig,
} from "@/lib/storefront-config";

/**
 * Builds everything the commerce homepage, header and footer render, from
 * REAL store data plus the owner's storefront config (pure; no I/O, usable on
 * server and client — the editor preview calls it with the DRAFT config and
 * the public store with the PUBLISHED one, so both render identically).
 * Every section can be empty; empty sections are left out (and reported in
 * `hiddenSections` for the editor). Nothing is invented: best sellers come
 * only from paid-order data passed in, "new" only from product dates, "sale"
 * only from a real compare-at price, availability only from stock.
 */

export const RAIL_LIMIT = 8;
const NEW_ARRIVAL_DAYS = 45;
const MIN_CATEGORIES = 2;
const MIN_BEST_SELLERS = 2;

/** The platform's default hero texts: treated as "not set" (never shown as claims). */
const DEFAULT_HERO_HEADLINE = "Welcome to our store";
const DEFAULT_HERO_SUBHEADLINE = "Quality you can trust, service you will love.";

/** A business's managed category (lib/categories.ts), as plain data. */
export interface ManagedCategory {
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  sort: number;
  active: boolean;
}

export interface CommerceExtras {
  /** Managed categories; when present they set order, images, links and visibility. */
  managedCategories?: ManagedCategory[];
  /** Product ids ordered by units sold in paid orders (from the server). */
  bestSellerIds?: string[];
  /** Published page slugs (for link validation). */
  pageSlugs?: string[];
  accountsEnabled?: boolean;
  /** Signed-in storefront customer of THIS store (display name), if any. */
  signedInName?: string | null;
  /** Signed in but the e-mail address is not confirmed yet. */
  signedInUnverified?: boolean;
  /** The store can take online payment (Razorpay connected and enabled). */
  onlinePayments?: boolean;
  /** Cash on delivery is offered (store setting + customer accounts on). */
  codAvailable?: boolean;
  /** Approved reviews from real orders, for the editor's preview of a reviews section. */
  reviews?: StoreReview[];
  now?: Date;
}

export interface CommerceLink {
  /** Opens another site in a new tab. */
  external?: boolean;
  /** Only on larger screens, or only in the phone menu. */
  showOn?: "desktop" | "mobile";
  /** A dropdown under this link (one level). */
  children?: CommerceLink[];
  label: string;
  href: string;
}

export interface CommerceCategory {
  name: string;
  href: string;
  imageUrl: string;
  count: number;
}

export interface CommercePromotion {
  eyebrow: string;
  title: string;
  text: string;
  imageUrl: string;
  imageAlt: string;
  cta: CommerceLink | null;
}

export interface CommerceBenefit {
  key: string;
  title: string;
  text: string;
}

interface SectionCommon {
  id: string;
  title: string;
  subtitle: string;
  appearance: SectionAppearance;
}

/** A homepage section ready to render (only sections with real content). */
export type CommerceSection =
  | (SectionCommon & { type: "categories"; categories: CommerceCategory[] })
  | (SectionCommon & { type: "featured" | "bestSellers" | "newArrivals" | "sale"; products: StorefrontProduct[]; viewAll: string | null })
  | (SectionCommon & { type: "promotions"; promotions: CommercePromotion[] })
  | (SectionCommon & { type: "block"; block: Section })
  | (SectionCommon & { type: "benefits"; benefits: CommerceBenefit[] })
  | (SectionCommon & { type: "story"; text: string });

export interface CommerceData {
  businessId: string;
  /** The words this kind of business uses for what it offers. */
  labels: StoreVocabulary;
  announcement: { text: string; href: string | null; tone: StorefrontConfig["announcement"]["tone"] } | null;
  /** Screen size settings of the homepage sections that have any. */
  sectionResponsive: Record<string, ResponsiveSettings>;
  hero: {
    eyebrow: string;
    headline: string;
    description: string;
    imageUrl: string;
    mobileImageUrl: string;
    imageAlt: string;
    align: "left" | "center";
    overlay: number;
    primaryCta: CommerceLink | null;
    secondaryCta: CommerceLink | null;
    /** Real product images for an image-less hero (never placeholders). */
    collage: Array<{ src: string; alt: string }>;
  } | null;
  /** Rendered homepage sections, in the owner's order. */
  sections: CommerceSection[];
  /** Enabled sections that are hidden because they have nothing real to show. */
  hiddenSections: Array<{ id: string; reason: string }>;
  // Summary data (first section of each kind, or the store-wide value).
  categories: CommerceCategory[];
  featured: StorefrontProduct[];
  featuredTitle: string;
  bestSellers: StorefrontProduct[];
  newArrivals: StorefrontProduct[];
  sale: StorefrontProduct[];
  promotions: CommercePromotion[];
  benefits: CommerceBenefit[];
  story: string;
  /** Types of the rendered sections, in order. */
  sectionOrder: HomeSectionType[];
  header: {
    navLinks: CommerceLink[];
    categoryLinks: CommerceLink[];
    accountsEnabled: boolean;
    signedInName: string | null;
    signedInUnverified: boolean;
    options: StorefrontConfig["header"];
  };
  footer: {
    layout: StorefrontConfig["footer"]["layout"];
    showContact: boolean;
    /** The owner's own columns, with only the links that lead somewhere. */
    columns: Array<{ title: string; links: CommerceLink[] }>;
    about: string;
    shopLinks: CommerceLink[];
    infoLinks: CommerceLink[];
    social: Array<{ network: SocialNetwork; href: string }>;
    /** The owner's own line instead of the usual copyright notice. */
    copyright?: string;
  };
  hasPolicies: boolean;
  totalProducts: number;
}

const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
};
export function socialLabel(network: SocialNetwork): string {
  return SOCIAL_LABELS[network];
}

export function categoryHref(name: string): string {
  return `/products?category=${encodeURIComponent(name)}`;
}

/** Discount in whole percent, only for a real compare-at price above the price. */
export function discountPercent(product: Pick<StorefrontProduct, "price" | "compareAtPrice">): number | null {
  const compare = product.compareAtPrice;
  if (typeof compare !== "number" || !(compare > product.price) || compare <= 0) return null;
  const pct = Math.round(((compare - product.price) / compare) * 100);
  return pct >= 1 ? pct : null;
}

/** Default heading of a section type ("" for sections without a visible heading). */
export function defaultSectionTitle(type: HomeSectionType, businessName: string, featuredSelected = false): string {
  switch (type) {
    case "categories":
      return "Shop by category";
    case "featured":
      return featuredSelected ? "Featured products" : "Shop our products";
    case "bestSellers":
      return "Best sellers";
    case "newArrivals":
      return "New arrivals";
    case "sale":
      return "On sale";
    case "story":
      return `About ${businessName}`;
    default:
      return "";
  }
}

function uniqueCategories(products: StorefrontProduct[]): Map<string, { name: string; products: StorefrontProduct[] }> {
  const map = new Map<string, { name: string; products: StorefrontProduct[] }>();
  for (const product of products) {
    const name = product.category?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = map.get(key) ?? { name, products: [] };
    entry.products.push(product);
    map.set(key, entry);
  }
  return map;
}

function sameIds(a: StorefrontProduct[], b: StorefrontProduct[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id);
}

/** The readable business type above the hero; none for the catch-all types. */
function heroEyebrow(category: string): string {
  if (!category || category === "retail" || category === "other") return "";
  return BUSINESS_CATEGORIES.find((c) => c.key === category)?.name ?? category.replace(/-/g, " ");
}

/**
 * Sections to leave out because every product in them is already shown higher
 * up the page (a small store would otherwise show the same few products under
 * three headings). Only automatic rails: the owner's curated collections, and
 * the sale rail, which says something different, always stay.
 */
export function repeatedRailIds(sections: CommerceSection[]): Set<string> {
  const shown = new Set<string>();
  const repeated = new Set<string>();
  for (const section of sections) {
    if (!("products" in section)) continue;
    if ((section.type === "newArrivals" || section.type === "bestSellers") && section.products.every((product) => shown.has(product.id))) {
      repeated.add(section.id);
      continue;
    }
    for (const product of section.products) shown.add(product.id);
  }
  return repeated;
}

export function buildCommerceData(view: StorefrontView, configInput: unknown, extras: CommerceExtras = {}): CommerceData {
  const config: StorefrontConfig = readStorefrontConfig(configInput, view.category);
  const now = extras.now ?? new Date();
  const products = view.products;
  const showProducts = view.theme.showProducts !== false;
  const byId = new Map(products.map((p) => [p.id, p]));
  const categoriesMap = uniqueCategories(products);
  // A published page that already uses the /policies path keeps it (owner content wins).
  const policiesPathTaken = (extras.pageSlugs ?? []).includes("policies");
  const hasPolicies = Boolean(config.policies.shipping || config.policies.returns) && !policiesPathTaken;
  // Managed categories (by lower-cased name). Inactive ones are hidden.
  const managed = new Map((extras.managedCategories ?? []).map((c) => [c.name.toLowerCase(), c]));
  const visibleCategory = (key: string) => managed.get(key)?.active !== false;
  const hrefForCategory = (name: string) => {
    const m = managed.get(name.toLowerCase());
    return m && m.active ? `/category/${encodeURIComponent(m.slug)}` : categoryHref(name);
  };
  const targets: LinkTargets = {
    productSlugs: new Set(products.map((p) => p.slug)),
    categories: new Set(categoriesMap.keys()),
    categorySlugs: new Set(
      [...managed.values()].filter((m) => m.active && categoriesMap.has(m.name.toLowerCase())).map((m) => m.slug),
    ),
    pageSlugs: new Set(extras.pageSlugs ?? (view.navigation ? [...view.navigation.header, ...view.navigation.footer].map((n) => n.slug) : [])),
    hasPolicies,
  };
  const link = (label: string, href: string): CommerceLink | null => {
    const resolved = resolveInternalHref(href, targets);
    return label.trim() && resolved ? { label: label.trim(), href: resolved } : null;
  };
  const managedOrder = [...managed.values()]
    .filter((m) => m.active && categoriesMap.has(m.name.toLowerCase()))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  // ---- Shared, store-wide data ---------------------------------------------
  const categoriesFor = (chosen: Array<{ name: string; imageUrl: string }>, limit: number): CommerceCategory[] => {
    const configured = chosen
      .map((c) => ({ c, entry: categoriesMap.get(c.name.toLowerCase()) }))
      .filter((x): x is { c: { name: string; imageUrl: string }; entry: { name: string; products: StorefrontProduct[] } } => Boolean(x.entry))
      .filter((x) => visibleCategory(x.c.name.toLowerCase()));
    const source =
      configured.length > 0
        ? configured.map(({ c, entry }) => ({ name: entry.name, imageUrl: c.imageUrl, products: entry.products }))
        : managedOrder.length > 0
          ? managedOrder.map((m) => ({ name: m.name, imageUrl: "", products: categoriesMap.get(m.name.toLowerCase())!.products }))
          : [...categoriesMap.values()]
              .filter((entry) => visibleCategory(entry.name.toLowerCase()))
              .sort((a, b) => b.products.length - a.products.length || a.name.localeCompare(b.name))
              .map((entry) => ({ name: entry.name, imageUrl: "", products: entry.products }));
    return source.slice(0, limit).map((entry) => ({
      name: entry.name,
      href: hrefForCategory(entry.name),
      imageUrl: entry.imageUrl || managed.get(entry.name.toLowerCase())?.imageUrl || entry.products.find((p) => p.imageUrl)?.imageUrl || "",
      count: entry.products.length,
    }));
  };

  const bestSellersAll = (extras.bestSellerIds ?? []).map((id) => byId.get(id)).filter((p): p is StorefrontProduct => Boolean(p));
  const bestSellersFor = (limit: number) => (bestSellersAll.length >= MIN_BEST_SELLERS ? bestSellersAll.slice(0, limit) : []);
  const cutoff = now.getTime() - NEW_ARRIVAL_DAYS * 24 * 60 * 60 * 1000;
  const recentAll = products
    .filter((p) => p.createdAt && Date.parse(p.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string));
  const saleAll = products.filter((p) => discountPercent(p) !== null);
  const featuredFor = (productIds: string[], limit: number) => {
    const selected = productIds.map((id) => byId.get(id)).filter((p): p is StorefrontProduct => Boolean(p));
    return { selected: selected.length > 0, products: (selected.length > 0 ? selected : products).slice(0, limit) };
  };

  // Benefits: owner statements + facts the platform can back.
  const benefitsFor = (s: { shipping: string; returns: string; support: string; guarantee: string }): CommerceBenefit[] => {
    const out: CommerceBenefit[] = [];
    if (s.shipping) out.push({ key: "shipping", title: "Delivery", text: s.shipping });
    if (s.returns) out.push({ key: "returns", title: "Returns", text: s.returns });
    if (extras.onlinePayments) {
      out.push({ key: "secure", title: "Secure online payment", text: "Pay on Razorpay's secure payment page. Your order is confirmed once the payment is verified." });
    }
    if (extras.codAvailable) {
      out.push({ key: "cod", title: "Cash on delivery", text: "Signed-in customers can pay in cash when the order arrives." });
    }
    const supportText = s.support || [view.contactEmail, view.phone].filter(Boolean).join(" · ");
    if (supportText) out.push({ key: "support", title: "Customer support", text: supportText });
    if (s.guarantee) out.push({ key: "guarantee", title: "Our promise", text: s.guarantee });
    return out;
  };
  const businessStory = (view.about || view.theme.about || "").trim();

  const promotionsFor = (items: Extract<HomeSection, { type: "promotions" }>["items"]): CommercePromotion[] =>
    items
      .filter((p) => p.enabled && p.title)
      .map((p) => ({
        eyebrow: p.eyebrow,
        title: p.title,
        text: p.text,
        imageUrl: p.imageUrl,
        imageAlt: p.imageAlt,
        cta: p.cta.label ? link(p.cta.label, p.cta.href) : null,
      }));

  // ---- Sections, in the owner's order ----------------------------------------
  const sections: CommerceSection[] = [];
  const hiddenSections: Array<{ id: string; reason: string }> = [];
  let firstFeatured: StorefrontProduct[] | null = null;
  for (const section of config.sections) {
    if (!section.enabled) continue;
    const common: SectionCommon = { id: section.id, title: section.title, subtitle: section.subtitle, appearance: section.appearance };
    const hide = (reason: string) => hiddenSections.push({ id: section.id, reason });
    const productRail = ["featured", "bestSellers", "newArrivals", "sale"].includes(section.type);
    if (productRail && !showProducts) {
      hide("Products are hidden in your theme settings.");
      continue;
    }
    switch (section.type) {
      case "categories": {
        const list = categoriesFor(section.categories, section.limit);
        if (list.length < MIN_CATEGORIES) hide("Needs at least 2 categories that have products.");
        else sections.push({ ...common, title: section.title || defaultSectionTitle("categories", view.name), type: "categories", categories: list });
        break;
      }
      case "featured": {
        const rail = featuredFor(section.productIds, section.limit);
        if (rail.products.length === 0) hide("Add products to your store.");
        else {
          firstFeatured ??= rail.products;
          sections.push({
            ...common,
            title: section.title || defaultSectionTitle("featured", view.name, rail.selected),
            type: "featured",
            products: rail.products,
            viewAll: products.length > rail.products.length ? "/products" : null,
          });
        }
        break;
      }
      case "bestSellers": {
        const list = bestSellersFor(section.limit);
        if (list.length === 0) hide("Shown once at least 2 products have sold in paid orders.");
        else sections.push({ ...common, title: section.title || defaultSectionTitle("bestSellers", view.name), type: "bestSellers", products: list, viewAll: null });
        break;
      }
      case "newArrivals": {
        const list = recentAll.slice(0, section.limit);
        // Never repeat the same list twice on one page.
        const repeats = firstFeatured !== null && sameIds(list, firstFeatured);
        if (list.length === 0) hide(`No products added in the last ${NEW_ARRIVAL_DAYS} days.`);
        else if (repeats) hide("Same products as the collection above.");
        else sections.push({ ...common, title: section.title || defaultSectionTitle("newArrivals", view.name), type: "newArrivals", products: list, viewAll: "/products?sort=newest" });
        break;
      }
      case "sale": {
        const list = saleAll.slice(0, section.limit);
        if (list.length === 0) hide("No products with a reduced price.");
        else sections.push({ ...common, title: section.title || defaultSectionTitle("sale", view.name), type: "sale", products: list, viewAll: null });
        break;
      }
      case "promotions": {
        const list = promotionsFor(section.items);
        if (list.length === 0) hide("Add a banner with a title.");
        else sections.push({ ...common, type: "promotions", promotions: list });
        break;
      }
      case "benefits": {
        const list = benefitsFor(section);
        if (list.length === 0) hide("Add delivery, returns or contact information.");
        else sections.push({ ...common, type: "benefits", benefits: list });
        break;
      }
      case "block": {
        const block = section.block;
        if (!block.visible) hide("This section is hidden.");
        else sections.push({ ...common, type: "block", block });
        break;
      }
      case "story": {
        const storyText = section.text.trim() || businessStory;
        if (!storyText) hide("Add your story here or a business description in Business settings.");
        else sections.push({ ...common, title: section.title || defaultSectionTitle("story", view.name), type: "story", text: storyText });
        break;
      }
    }
  }

  // ---- Summary data (compatibility and other pages) ---------------------------
  type RailSection = Extract<CommerceSection, { products: StorefrontProduct[] }>;
  const rail = (type: RailSection["type"]) => sections.find((s) => s.type === type) as RailSection | undefined;
  const firstCategories = sections.find((s) => s.type === "categories") as Extract<CommerceSection, { type: "categories" }> | undefined;
  const firstPromotions = sections.find((s) => s.type === "promotions") as Extract<CommerceSection, { type: "promotions" }> | undefined;
  const firstConfigured = <T extends HomeSectionType>(type: T) => config.sections.find((s) => s.type === type) as Extract<HomeSection, { type: T }> | undefined;
  const featuredConfig = firstConfigured("featured");
  const featuredSummary = featuredFor(featuredConfig?.productIds ?? [], featuredConfig?.limit ?? RAIL_LIMIT);
  const recentSummary = recentAll.slice(0, RAIL_LIMIT);
  const benefitsConfig = firstConfigured("benefits");
  const benefits = benefitsFor(benefitsConfig ?? { shipping: "", returns: "", support: "", guarantee: "" });

  // ---- Hero ------------------------------------------------------------------
  const themeHeadline = view.theme.heroHeadline && view.theme.heroHeadline !== DEFAULT_HERO_HEADLINE ? view.theme.heroHeadline : "";
  const themeSubheadline = view.theme.heroSubheadline && view.theme.heroSubheadline !== DEFAULT_HERO_SUBHEADLINE ? view.theme.heroSubheadline : "";
  const headline = config.hero.headline || themeHeadline || view.name;
  const description = config.hero.description || themeSubheadline || (view.about || "").trim().slice(0, 300);
  const labels = storeVocabulary(view.category);
  const defaultPrimary = products.length > 0 ? { label: labels.heroCta, href: "/products" } : null;
  const hero = config.hero.enabled
    ? {
        eyebrow: config.hero.eyebrow || heroEyebrow(view.category),
        headline,
        description,
        imageUrl: config.hero.imageUrl,
        mobileImageUrl: config.hero.mobileImageUrl || config.hero.imageUrl,
        imageAlt: config.hero.imageAlt,
        align: config.hero.align,
        overlay: config.hero.overlay,
        primaryCta: config.hero.primaryCta.label ? link(config.hero.primaryCta.label, config.hero.primaryCta.href) : defaultPrimary,
        secondaryCta: config.hero.secondaryCta.label ? link(config.hero.secondaryCta.label, config.hero.secondaryCta.href) : null,
        collage: config.hero.imageUrl
          ? []
          : products.filter((p) => p.imageUrl).slice(0, 3).map((p) => ({ src: p.imageUrl, alt: p.name })),
      }
    : null;

  // ---- Header / footer --------------------------------------------------------
  const navLink = (item: ResolvedNavItem): CommerceLink => ({
    label: item.label,
    href: item.href ?? `/${item.slug}`,
    ...(item.external ? { external: true } : {}),
    ...(item.showOn ? { showOn: item.showOn } : {}),
    ...(item.children?.length ? { children: item.children.map(navLink) } : {}),
  });
  const navLinks: CommerceLink[] = (view.navigation?.header ?? []).map(navLink);
  const categoryLinks: CommerceLink[] = (managedOrder.length > 0
    ? managedOrder.map((m) => ({ name: m.name }))
    : [...categoriesMap.values()]
        .filter((entry) => visibleCategory(entry.name.toLowerCase()))
        .sort((a, b) => b.products.length - a.products.length || a.name.localeCompare(b.name))
        .map((entry) => ({ name: entry.name })))
    .slice(0, 8)
    .map((entry) => ({ label: entry.name, href: hrefForCategory(entry.name) }));
  // The footer shows its links flat: a dropdown has nothing to open there.
  const infoLinks: CommerceLink[] = (config.footer.showMenuLinks ? view.navigation?.footer ?? [] : []).flatMap((item) => {
    const own = item.href === "#" ? [] : [navLink({ ...item, children: undefined })];
    return [...own, ...(item.children ?? []).map(navLink)];
  });
  if (hasPolicies) infoLinks.push({ label: "Shipping & returns", href: "/policies" });
  const social = config.footer.showSocial ? SOCIAL_NETWORKS.filter((n) => config.footer.social[n]).map((network) => ({ network, href: config.footer.social[network] })) : [];
  // A link to something that no longer exists is left out, like every other store link.
  const footerColumns = config.footer.columns
    .map((column) => ({
      title: column.title,
      links: column.links.flatMap((link): CommerceLink[] => {
        if (!link.label || !link.href) return [];
        if (/^https:/i.test(link.href)) return [{ label: link.label, href: link.href, external: true }];
        const href = resolveInternalHref(link.href, targets);
        return href ? [{ label: link.label, href }] : [];
      }),
    }))
    .filter((column) => column.title && column.links.length > 0);
  const storySection = sections.find((s) => s.type === "story") as Extract<CommerceSection, { type: "story" }> | undefined;

  return {
    businessId: view.id,
    labels,
    announcement: config.announcement.enabled && config.announcement.text
      ? { text: config.announcement.text, href: config.announcement.href ? resolveInternalHref(config.announcement.href, targets) : null, tone: config.announcement.tone }
      : null,
    sectionResponsive: Object.fromEntries(config.sections.flatMap((section) => (section.responsive ? [[section.id, section.responsive]] : []))),
    hero,
    sections,
    hiddenSections,
    categories: firstCategories?.categories ?? categoriesFor([], 8),
    featured: rail("featured")?.products ?? (showProducts ? featuredSummary.products : []),
    featuredTitle: rail("featured")?.title ?? defaultSectionTitle("featured", view.name, featuredSummary.selected),
    bestSellers: rail("bestSellers")?.products ?? bestSellersFor(RAIL_LIMIT),
    newArrivals: rail("newArrivals")?.products ?? (recentSummary.length > 0 && !sameIds(recentSummary, featuredSummary.products) ? recentSummary : []),
    sale: rail("sale")?.products ?? saleAll.slice(0, RAIL_LIMIT),
    promotions: firstPromotions?.promotions ?? [],
    benefits,
    story: storySection?.text ?? businessStory,
    sectionOrder: sections.map((s) => s.type),
    header: {
      navLinks,
      categoryLinks,
      accountsEnabled: Boolean(extras.accountsEnabled),
      signedInName: extras.signedInName ?? null,
      signedInUnverified: Boolean(extras.signedInUnverified),
      options: config.header,
    },
    footer: {
      layout: config.footer.layout,
      showContact: config.footer.showContact,
      columns: footerColumns,
      about: config.footer.about || (businessStory.length > 240 ? `${businessStory.slice(0, 237)}…` : businessStory),
      shopLinks: products.length > 0 && config.footer.showShopLinks ? [{ label: labels.catalogTitle, href: "/products" }, ...categoryLinks.slice(0, 5)] : [],
      infoLinks,
      social,
      ...(config.footer.copyright ? { copyright: config.footer.copyright } : {}),
    },
    hasPolicies,
    totalProducts: products.length,
  };
}
