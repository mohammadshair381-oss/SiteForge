import type { Metadata, MetadataRoute } from "next";
import { dbConnect } from "./db";
import { isProduction } from "./env";
import { getRootDomains, isRootHost, normalizeHost } from "./host";
import { getVisibleSections, resolvePublishedPageSections } from "./sections";
import { getPublicStorefront } from "./tenant";
import { RESERVED_PAGE_SLUGS } from "./validation";
import { Page } from "@/models/Page";
import { loadPublicCategories } from "./categories";
import { readStorefrontConfig } from "./storefront-config";
import { pageDescriptionFrom, pageImageFrom } from "./page-seo-defaults";
import { absolutize } from "./structured-data";

/**
 * Page SEO for public storefronts.
 *
 * SEO text follows the same draft/published split as page sections: owners edit
 * `seoTitle` / `seoDescription` (draft) and the values are copied to
 * `publishedSeoTitle` / `publishedSeoDescription` when the page is published.
 * Public pages only ever read the published snapshot. Pages published before
 * the snapshot existed (fields absent) fall back to the draft values so legacy
 * data keeps its existing behavior.
 */

export const SEO_TITLE_MAX = 160;
export const SEO_DESCRIPTION_MAX = 320;
/** Search engines truncate long fallback descriptions; keep generated ones short. */
const FALLBACK_DESCRIPTION_MAX = 160;

export interface PageSeoFields {
  title: string;
  isHome?: boolean;
  seoTitle?: string | null;
  seoDescription?: string | null;
  publishedSeoTitle?: string | null;
  publishedSeoDescription?: string | null;
  seoImage?: string | null;
  publishedSeoImage?: string | null;
  noindex?: boolean | null;
  publishedNoindex?: boolean | null;
  /** The published copy only: a draft never reaches these defaults. */
  publishedSections?: unknown;
  publishedCanonicalUrl?: string | null;
}

export interface BusinessSeoFields {
  name: string;
  /** The store's logo, used as its browser icon. */
  logoUrl?: string | null;
  /** The homepage's own search settings (published). */
  homeSeo?: { title?: string; description?: string; imageUrl?: string } | null;
  description?: string | null;
  aboutFallback?: string | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** The SEO text visitors may see: the published snapshot, or the legacy draft. */
export function resolvePublishedSeoText(page: PageSeoFields): {
  title: string;
  description: string;
} {
  const title =
    page.publishedSeoTitle !== undefined && page.publishedSeoTitle !== null
      ? page.publishedSeoTitle
      : page.seoTitle;
  const description =
    page.publishedSeoDescription !== undefined &&
    page.publishedSeoDescription !== null
      ? page.publishedSeoDescription
      : page.seoDescription;
  return { title: clean(title), description: clean(description) };
}

export function buildPageMetadata(
  business: BusinessSeoFields,
  page: PageSeoFields | null,
  canonicalUrl?: string,
): Metadata {
  const seo = page ? resolvePublishedSeoText(page) : { title: "", description: "" };
  const onHome = !page || page.isHome;
  // Only sections the page actually renders, from its published copy.
  const liveSections = getVisibleSections(page?.publishedSections);
  const image = (page?.publishedSeoImage ?? page?.seoImage ?? "") || (onHome ? business.homeSeo?.imageUrl ?? "" : "") || pageImageFrom(liveSections);
  const canonical = page?.publishedCanonicalUrl || canonicalUrl;
  const hidden = page ? page.publishedNoindex ?? page.noindex ?? false : false;

  const fallbackTitle =
    !page || page.isHome ? business.name : `${clean(page.title)} | ${business.name}`;
  const fallbackDescription = truncate(
    clean(business.description) || clean(business.aboutFallback),
    FALLBACK_DESCRIPTION_MAX,
  );

  const title = seo.title || (onHome ? clean(business.homeSeo?.title) : "") || fallbackTitle;
  const description = seo.description || (onHome ? clean(business.homeSeo?.description) : "") || pageDescriptionFrom(liveSections) || fallbackDescription;

  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    ...(canonical ? { alternates: { canonical } } : {}),
    ...(hidden ? { robots: { index: false, follow: true } } : {}),
    ...(business.logoUrl ? { icons: { icon: business.logoUrl } } : {}),
    openGraph: {
      title,
      ...(image ? { images: [{ url: image }] } : {}),
      ...(description ? { description } : {}),
      siteName: business.name,
      type: "website",
      ...(canonical ? { url: canonical } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Canonical origins (pilot: tenant subdomains are canonical)
// ---------------------------------------------------------------------------

/**
 * The platform root used to build tenant subdomain URLs: `NEXT_PUBLIC_ROOT_DOMAIN`
 * when it is one of the configured `ROOT_DOMAINS` (so the canonical host is one
 * the middleware actually serves), otherwise the first configured root.
 */
export function canonicalRootDomain(
  roots: string[] = getRootDomains(),
  preferred: string | undefined = process.env.NEXT_PUBLIC_ROOT_DOMAIN,
): string {
  const normalizedPreferred = normalizeHost(preferred);
  if (normalizedPreferred && roots.includes(normalizedPreferred)) return normalizedPreferred;
  return roots[0] ?? "localhost:3000";
}

/**
 * Canonical origin of a tenant storefront. During the pilot the tenant
 * subdomain is always canonical, even when a custom domain is active: custom
 * domains are not provisioned on the hosting platform yet, and pointing search
 * engines at an unserved host would be worse than a subdomain canonical.
 */
export function storefrontOrigin(
  subdomain: string,
  options: { root?: string; production?: boolean } = {},
): string {
  const root = options.root ?? canonicalRootDomain();
  const production = options.production ?? isProduction();
  return `${production ? "https" : "http"}://${subdomain.toLowerCase()}.${root}`;
}

/** Joins an origin and a storefront path into an absolute URL. */
export function absoluteUrl(origin: string, path: string): string {
  return path === "/" ? `${origin}/` : `${origin}${path}`;
}

// ---------------------------------------------------------------------------
// robots.txt / sitemap.xml (host-aware, tenant-isolated)
// ---------------------------------------------------------------------------

/** Robots policy that blocks everything (unknown or ineligible hosts). */
export const CLOSED_ROBOTS: MetadataRoute.Robots = {
  rules: { userAgent: "*", disallow: "/" },
};

/** Storefront paths that must never be crawled (private or per-visitor). */
const STOREFRONT_DISALLOW = ["/cart", "/order/", "/account", "/api/"];

/** Platform paths that must never be crawled. */
const PLATFORM_DISALLOW = [
  "/dashboard",
  "/admin",
  "/api/",
  "/store",
  "/verify-email",
  "/reset-password",
];

/** Public, indexable platform pages. */
const PLATFORM_SITEMAP_PATHS = ["/", "/themes", "/pricing", "/register", "/terms", "/privacy"];

interface SitemapPageInput {
  slug: string;
  isHome: boolean;
  sections?: unknown[] | null;
  publishedSections?: unknown[] | null;
}

/**
 * The published content of a page, using the same rule as the storefront
 * renderer (`resolvePublishedPageSections`) so the sitemap lists exactly the
 * pages that render visible published content.
 */
function publishedContent(page: SitemapPageInput): unknown[] {
  return resolvePublishedPageSections(page);
}

/**
 * Pure: builds sitemap entries for one eligible storefront. Callers pass only
 * data that already passed the public storefront gate (published pages and
 * active products of THIS business).
 *
 * - Legacy storefronts (no Page documents) list only `/`.
 * - The homepage is listed as `/` when a published homepage exists (it renders
 *   even without sections); its own slug is not listed separately.
 * - Other pages are listed only if they render visible published sections and
 *   their slug is not shadowed by a storefront route (`cart`, `product`, ...).
 * - No `lastModified`: `updatedAt` also moves on draft edits and would reveal
 *   unpublished activity.
 */
export function buildStorefrontSitemapEntries(input: {
  origin: string;
  hasPageDocuments: boolean;
  publishedPages: SitemapPageInput[];
  productSlugs: string[];
  /** Slugs of active managed categories that have public products. */
  categorySlugs?: string[];
  /** The store publishes shipping/returns text at /policies. */
  hasPolicies?: boolean;
}): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  const seen = new Set<string>();
  const add = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    entries.push({ url: absoluteUrl(input.origin, path) });
  };

  // `/` always renders: the published Home page, or the commerce homepage.
  add("/");
  if (input.hasPageDocuments) {
    for (const page of input.publishedPages) {
      if (page.isHome) continue;
      const slug = (page.slug ?? "").toLowerCase();
      if (!slug || RESERVED_PAGE_SLUGS.has(slug)) continue;
      // The owner asked search engines to skip this page.
      if ((page as { publishedNoindex?: boolean; noindex?: boolean }).publishedNoindex ?? (page as { noindex?: boolean }).noindex) continue;
      if (getVisibleSections(publishedContent(page)).length === 0) continue;
      add(`/${encodeURIComponent(slug)}`);
    }
  }

  // The public catalog (app/store/products) exists for every store; it is
  // listed only when the store has at least one public product to show.
  if (input.productSlugs.some(Boolean)) add("/products");
  for (const slug of input.productSlugs) {
    if (slug) add(`/product/${encodeURIComponent(slug)}`);
  }
  for (const slug of input.categorySlugs ?? []) {
    if (slug) add(`/category/${encodeURIComponent(slug)}`);
  }
  if (input.hasPolicies) add("/policies");
  return entries;
}

function requestOrigin(host: string): string {
  return `${isProduction() ? "https" : "http"}://${normalizeHost(host)}`;
}

/**
 * robots.txt for the request host. Platform hosts get the platform policy;
 * storefront hosts get an open policy only when the storefront passes the same
 * public gate as its pages (`getPublicStorefront`: published, not suspended,
 * entitled, custom domain verified and fresh). Everything else is closed.
 */
export async function getRobotsForHost(
  host: string | null | undefined,
): Promise<MetadataRoute.Robots> {
  const normalized = normalizeHost(host);
  if (!normalized) return CLOSED_ROBOTS;

  if (isRootHost(normalized)) {
    return {
      rules: { userAgent: "*", allow: "/", disallow: PLATFORM_DISALLOW },
      sitemap: `${requestOrigin(normalized)}/sitemap.xml`,
    };
  }

  const result = await getPublicStorefront(normalized);
  if (!result) return CLOSED_ROBOTS;

  const origin = storefrontOrigin(result.business.subdomain);
  return {
    rules: { userAgent: "*", allow: "/", disallow: STOREFRONT_DISALLOW },
    sitemap: `${origin}/sitemap.xml`,
  };
}

/**
 * sitemap.xml for the request host. The tenant is resolved from the host only
 * (never from a parameter), every query is scoped to that tenant id, and the
 * sitemap is served only on the canonical subdomain host so it never lists URLs
 * for a different host. Ineligible or unknown hosts get an empty sitemap.
 */
export async function getSitemapForHost(
  host: string | null | undefined,
): Promise<MetadataRoute.Sitemap> {
  const normalized = normalizeHost(host);
  if (!normalized) return [];

  if (isRootHost(normalized)) {
    const origin = requestOrigin(normalized);
    return PLATFORM_SITEMAP_PATHS.map((path) => ({ url: absoluteUrl(origin, path) }));
  }

  const result = await getPublicStorefront(normalized);
  if (!result) return [];
  const { business, products } = result;

  const origin = storefrontOrigin(business.subdomain);
  if (requestOrigin(normalized) !== origin) return [];

  await dbConnect();
  const [pageCount, publishedPages, categories] = await Promise.all([
    Page.countDocuments({ business: business._id }),
    Page.find({ business: business._id, status: "published" })
      .select("slug isHome sections publishedSections noindex publishedNoindex")
      .lean(),
    loadPublicCategories(business._id),
  ]);
  const productCategories = new Set(products.map((p) => (p.category ?? "").trim().toLowerCase()).filter(Boolean));
  const storefront = readStorefrontConfig((business.themeSettings as unknown as Record<string, unknown> | undefined)?.publishedStorefront);
  const pageSlugs = new Set(publishedPages.map((p) => p.slug));

  return buildStorefrontSitemapEntries({
    origin,
    hasPageDocuments: pageCount > 0,
    publishedPages: publishedPages.map((page) => ({
      slug: page.slug,
      isHome: page.isHome,
      sections: page.sections,
      publishedSections: page.publishedSections,
    })),
    productSlugs: products.map((product) => product.slug),
    categorySlugs: categories.filter((c) => c.active && productCategories.has(c.name.toLowerCase())).map((c) => c.slug),
    // Same rule as the storefront: policy text exists and no page owns the path.
    hasPolicies: Boolean(storefront.policies.shipping || storefront.policies.returns) && !pageSlugs.has("policies"),
  });
}

/**
 * Metadata for a public storefront route. Resolves through the same
 * `getPublicStorefront` gate as the page itself, so an unpublished, suspended
 * or unentitled tenant leaks nothing (returns empty metadata; the page 404s).
 */
export async function getStorefrontPageMetadata(
  host: string | null | undefined,
  pageSlug: string | null,
): Promise<Metadata> {
  const result = await getPublicStorefront(host);
  if (!result) return {};
  const { business } = result;
  const publishedHome = (business.themeSettings as { publishedStorefront?: { seo?: BusinessSeoFields["homeSeo"] } } | undefined)?.publishedStorefront?.seo;
  const businessSeo: BusinessSeoFields = {
    name: business.name,
    description: business.description,
    aboutFallback: business.themeSettings?.about,
    logoUrl: business.logoUrl,
    homeSeo: publishedHome ?? null,
  };

  await dbConnect();
  const filter = pageSlug
    ? { business: business._id, slug: pageSlug, status: "published" as const }
    : { business: business._id, isHome: true, status: "published" as const };
  const page = await Page.findOne(filter)
    .select(
      "title isHome seoTitle seoDescription publishedSeoTitle publishedSeoDescription seoImage publishedSeoImage noindex publishedNoindex publishedCanonicalUrl publishedSections",
    )
    .lean();

  // Canonical URL on the tenant subdomain, only for a page that exists (or
  // the commerce homepage). A slug that 404s gets no canonical.
  let canonicalPath: string | null = null;
  if (page) {
    canonicalPath = page.isHome ? "/" : `/${encodeURIComponent(pageSlug ?? "")}`;
  } else if (!pageSlug) {
    canonicalPath = "/";
  }
  const canonicalUrl = canonicalPath
    ? absoluteUrl(storefrontOrigin(business.subdomain), canonicalPath)
    : undefined;

  return buildPageMetadata(businessSeo, page, canonicalUrl);
}

/** Canonical URL of a storefront product page (tenant subdomain). */
export function productCanonicalUrl(subdomain: string, productSlug: string): string {
  return absoluteUrl(storefrontOrigin(subdomain), `/product/${encodeURIComponent(productSlug)}`);
}

/**
 * Metadata for a public product page. Uses the same gate and product list as
 * the page (`getPublicStorefront`: active products of an eligible store), so a
 * draft/archived product or an ineligible store yields empty metadata.
 */
export async function getProductMetadata(
  host: string | null | undefined,
  productSlug: string,
): Promise<Metadata> {
  const result = await getPublicStorefront(host);
  const product = result?.products.find((item) => item.slug === productSlug);
  if (!result || !product) return {};

  // Owner-written SEO text wins; otherwise derived from the product itself.
  const seo = product as { seoTitle?: string; seoDescription?: string; imageAlt?: string };
  const description = (clean(seo.seoDescription ?? "") || clean(product.description)).slice(0, FALLBACK_DESCRIPTION_MAX);
  const title = seo.seoTitle?.trim() ? seo.seoTitle.trim() : `${product.name} | ${result.business.name}`;
  const canonicalUrl = productCanonicalUrl(result.business.subdomain, product.slug);
  const image = product.imageUrl || product.images?.[0] || "";
  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title,
      ...(description ? { description } : {}),
      siteName: result.business.name,
      url: canonicalUrl,
      ...(image ? { images: [{ url: absolutize(storefrontOrigin(result.business.subdomain), image), alt: seo.imageAlt?.trim() || product.name }] } : {}),
    },
  };
}

/**
 * Metadata for an ACTIVE managed category page that has public products
 * (same gate as the page). Anything else yields empty metadata (the page 404s).
 */
export async function getCategoryMetadata(
  host: string | null | undefined,
  categorySlug: string,
): Promise<Metadata> {
  const result = await getPublicStorefront(host);
  if (!result) return {};
  const category = (await loadPublicCategories(result.business._id)).find((c) => c.slug === categorySlug && c.active);
  if (!category) return {};
  const hasProducts = result.products.some((p) => (p.category ?? "").trim().toLowerCase() === category.name.toLowerCase());
  if (!hasProducts) return {};
  const origin = storefrontOrigin(result.business.subdomain);
  const canonicalUrl = absoluteUrl(origin, `/category/${encodeURIComponent(category.slug)}`);
  const title = category.seoTitle?.trim() ? category.seoTitle.trim() : `${category.name} | ${result.business.name}`;
  const description = (clean(category.seoDescription ?? "") || clean(category.description)).slice(0, FALLBACK_DESCRIPTION_MAX) || `Shop ${category.name} at ${result.business.name}.`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: canonicalUrl },
    openGraph: {
      title,
      description,
      siteName: result.business.name,
      url: canonicalUrl,
      ...(category.imageUrl ? { images: [{ url: absolutize(origin, category.imageUrl), alt: category.name }] } : {}),
    },
  };
}
