import { HttpError } from "./api";
import {
  localMediaServable,
  mediaPublicBaseUrls,
  parseMediaStorageUrlFromBases,
  type MediaStorageUrl,
} from "./media";
import type { Section } from "./sections";
import { Media } from "@/models/Media";
import { Business } from "@/models/Business";
import { Order } from "@/models/Order";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import { ProductCategory } from "@/models/ProductCategory";

/** Local media serving URL pattern: /api/businesses/{id}/local-media?key={base64} */
const LOCAL_MEDIA_URL_PATTERN = /^\/api\/businesses\/([^/]+)\/local-media/i;

/** The path of a local media address, written with or without a host. Null for anything else. */
function localMediaPath(value: string): string | null {
  const path = value.trim().replace(/^https?:\/\/[^/]+(?=\/api\/businesses\/)/i, "");
  return LOCAL_MEDIA_URL_PATTERN.test(path) ? path : null;
}

/**
 * Tries to parse a URL that may be a bucket media URL or a local media serving
 * URL. A local media address is parsed as one. Anything else is checked against
 * the public base URLs (current, plus an optional legacy one during a storage migration).
 */
export function parseMediaStorageUrlOrLocal(
  value: string,
  publicBaseUrls: string | readonly string[] | null | undefined,
): MediaStorageUrl | null {
  const bases = (Array.isArray(publicBaseUrls) ? publicBaseUrls : [publicBaseUrls]).filter(
    (base): base is string => typeof base === "string" && base.length > 0,
  );
  // A local media address always names a store, so it always gets the ownership check.
  const local = localMediaPath(value);
  if (!local) return bases.length > 0 ? parseMediaStorageUrlFromBases(value, bases) : null;
  // Format: /api/businesses/{businessId}/local-media?key={base64}
  const match = local.match(LOCAL_MEDIA_URL_PATTERN);
  if (!match) return null;
  const urlBusinessId = match[1].toLowerCase();
  // The storage key is the base64 `key` parameter (see localMediaUrl). It must
  // sit under this business's prefix without traversal; anything else keeps an
  // unresolvable key, so the Media lookup in assertMediaUrlsOwned rejects it.
  let storageKey = `media/${urlBusinessId}/`;
  try {
    const encoded = new URL(local, "http://local.invalid").searchParams.get("key") ?? "";
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (decoded.toLowerCase().startsWith(storageKey) && !decoded.includes("..") && !decoded.includes("\\")) {
      storageKey = decoded;
    }
  } catch {
    // Malformed URL or key: keep the unresolvable prefix.
  }
  return { businessId: urlBusinessId, storageKey };
}

/**
 * Server-only ownership checks for media-library references.
 *
 * Products and sections still store plain image URLs so legacy/external HTTPS
 * URLs keep working. When a URL points at this deployment's media bucket, the
 * URL alone is not proof of ownership: the referenced Media record must exist
 * for the *current* business. This runs in the API routes, never in the UI.
 */

const INVALID_MEDIA_MESSAGE =
  "That image is not available in this business's media library.";

function invalidMediaReference(): HttpError {
  return new HttpError(400, INVALID_MEDIA_MESSAGE, "invalid_media_reference");
}

/** Stored on a development machine, so visitors of this site would only ever see a broken image. */
function unservableLocalMedia(): HttpError {
  return new HttpError(400, "That image was stored on a development machine, so this site can't show it. Upload it to your media library and choose it again, or remove it.", "invalid_media_reference");
}

/**
 * Rejects platform-media URLs owned by another business (or by no business), and
 * local media addresses wherever this deployment does not serve them. The section and
 * homepage schemas only check an address's format, because they also read stored data:
 * this is the check every write and publish goes through.
 * External HTTPS URLs are deliberately left alone to preserve existing data.
 *
 * Callers must have established the tenant from the authenticated route (for
 * example via `requireBusinessRole`) and called `dbConnect()` first.
 */
export async function assertMediaUrlsOwned(
  businessId: string,
  values: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  // Current base plus the optional legacy base (S3_LEGACY_PUBLIC_URL). A URL
  // under either is a platform media reference and gets the same checks: the
  // key's business id must match AND a Media record must exist for it.
  const publicBaseUrls = mediaPublicBaseUrls();
  const expectedBusinessId = businessId.toLowerCase();
  const references: MediaStorageUrl[] = [];

  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (localMediaPath(value) && !localMediaServable()) throw unservableLocalMedia();
    const reference = parseMediaStorageUrlOrLocal(value, publicBaseUrls);
    if (!reference) continue; // legacy/external URL, not a platform media URL
    if (reference.businessId !== expectedBusinessId) {
      throw invalidMediaReference();
    }
    references.push(reference);
  }

  if (references.length === 0) return;

  const storageKeys = Array.from(
    new Set(references.map((ref) => ref.storageKey)),
  );
  // Soft-deleted rows are included on purpose: removing an image after it was
  // attached must not make existing product/page edits unsaveable. The picker
  // already hides deleted rows, so they cannot be newly selected through the UI.
  const found = await Media.find({
    business: businessId,
    storageKey: { $in: storageKeys },
  })
    .select("storageKey")
    .lean<{ storageKey: string }[]>();

  const foundKeys = new Set(found.map((item) => item.storageKey));
  if (storageKeys.some((key) => !foundKeys.has(key))) {
    throw invalidMediaReference();
  }
}

/**
 * Validates every image URL stored in section settings. Section schemas strip
 * unknown fields, so only section types that actually allow `imageUrl` can
 * contribute a value here.
 */
export async function assertSectionMediaOwned(
  businessId: string,
  sections: ReadonlyArray<Section>,
): Promise<void> {
  await assertMediaUrlsOwned(businessId, getSectionImageUrls(sections));
}

/**
 * Returns only image URL fields supported by the section schemas. Callers
 * should first validate the sections with `sectionsArraySchema`.
 */
export function getSectionImageUrls(
  sections: ReadonlyArray<Section>,
): string[] {
  const urls: string[] = [];
  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const settings = (section as { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object") continue;
    const sectionSettings = settings as Record<string, unknown>;
    const imageUrl = sectionSettings.imageUrl;
    if (typeof imageUrl === "string") urls.push(imageUrl);

    const nestedImageArrays = [
      section.type === "testimonials" ? sectionSettings.items : undefined,
      section.type === "gallery" ? sectionSettings.images : undefined,
      section.type === "team" || section.type === "logos" ? sectionSettings.items : undefined,
    ];
    for (const images of nestedImageArrays) {
      if (!Array.isArray(images)) continue;
      for (const image of images) {
        if (!image || typeof image !== "object") continue;
        const nestedUrl = (image as Record<string, unknown>).imageUrl ??
          (image as Record<string, unknown>).url;
        if (typeof nestedUrl === "string") urls.push(nestedUrl);
      }
    }
  }
  return urls;
}

export interface MediaReferenceCounts {
  products: number;
  pages: number;
  business: number;
  /** Orders showing this image in their history, which must keep working. */
  orders: number;
  categories: number;
  total: number;
}

/**
 * Validates that a media URL is referenced by the given business's products,
 * pages, and business settings (logo/theme). Returns per-category counts.
 *
 * External HTTPS URLs are deliberately left alone to preserve existing data.
 *
 * Callers must have established the tenant from the authenticated route (for
 * example via `requireBusinessRole`) and called `dbConnect()` first.
 */
type StoredHome = { sections?: Array<{ type?: string; block?: unknown }>; seo?: { imageUrl?: unknown } };

export async function countMediaReferences(
  businessId: string,
  urlOrUrls: string | readonly string[],
): Promise<MediaReferenceCounts> {
  // Every URL form of the same object (current base, and the legacy base
  // during a storage migration) counts as a reference.
  const urls = Array.from(
    new Set((Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).filter((value) => !!value)),
  );
  if (urls.length === 0) {
    return { products: 0, pages: 0, business: 0, orders: 0, categories: 0, total: 0 };
  }
  const urlSet = new Set(urls);
  const anyUrl = { $in: urls };

  // When no media public base URL is set (local development mode), the url may be
  // a local media serving URL. The existing MongoDB queries match on the exact
  // imageUrl field value, so as long as the URL format is consistent (local vs S3)
  // the queries work correctly without modification.
  const [productCount, orderCount, categoryCount, pageCount, business] = await Promise.all([
    Product.countDocuments({
      business: businessId,
      $or: [{ imageUrl: anyUrl }, { images: anyUrl }, { "variants.imageUrl": anyUrl }],
    }),
    Order.countDocuments({ business: businessId, "items.imageUrl": anyUrl }),
    ProductCategory.countDocuments({ business: businessId, imageUrl: anyUrl }),
    Page.countDocuments({
      business: businessId,
      $or: [
        { "sections.settings.imageUrl": anyUrl },
        { "publishedSections.settings.imageUrl": anyUrl },
        { "sections.settings.items.imageUrl": anyUrl },
        { "publishedSections.settings.items.imageUrl": anyUrl },
        { "sections.settings.images.url": anyUrl },
        { "publishedSections.settings.images.url": anyUrl },
        { seoImage: anyUrl },
        { publishedSeoImage: anyUrl },
      ],
    }),
    Business.findById(businessId).select("logoUrl themeSettings").lean(),
  ]);

  let businessCount = 0;
  if (typeof business?.logoUrl === "string" && urlSet.has(business.logoUrl)) businessCount += 1;

  const themeSettings = business?.themeSettings as
    | { sections?: unknown; storefront?: StoredHome; publishedStorefront?: StoredHome }
    | undefined;
  const sections = [
    ...(Array.isArray(themeSettings?.sections) ? themeSettings.sections : []),
    // Content blocks on the homepage, draft and live.
    ...[themeSettings?.storefront, themeSettings?.publishedStorefront].flatMap((home) =>
      Array.isArray(home?.sections) ? home.sections.flatMap((item) => (item?.type === "block" && item.block ? [item.block] : [])) : [],
    ),
  ];
  for (const home of [themeSettings?.storefront, themeSettings?.publishedStorefront]) {
    if (typeof home?.seo?.imageUrl === "string" && urlSet.has(home.seo.imageUrl)) businessCount += 1;
  }
  if (sections.length > 0) {
    for (const section of sections) {
      const settings = (section as { settings?: Record<string, unknown> })
        ?.settings;
      if (!settings) continue;
      if (typeof settings.imageUrl === "string" && urlSet.has(settings.imageUrl)) businessCount += 1;
      const nestedImageArrays = [settings.items, settings.images];
      for (const images of nestedImageArrays) {
        if (!Array.isArray(images)) continue;
        for (const image of images) {
          if (!image || typeof image !== "object") continue;
          const imageData = image as Record<string, unknown>;
          if (
            (typeof imageData.imageUrl === "string" && urlSet.has(imageData.imageUrl)) ||
            (typeof imageData.url === "string" && urlSet.has(imageData.url))
          ) {
            businessCount += 1;
          }
        }
      }
    }
  }

  // Hero images, banners and anything else in the theme settings, draft or live: an
  // unrecognised place must keep an image rather than lose it.
  if (businessCount === 0 && themeSettings) {
    const stored = JSON.stringify(themeSettings);
    if (urls.some((url) => stored.includes(url))) businessCount = 1;
  }

  return {
    products: productCount,
    pages: pageCount,
    business: businessCount,
    orders: orderCount,
    categories: categoryCount,
    total: productCount + pageCount + businessCount + orderCount + categoryCount,
  };
}