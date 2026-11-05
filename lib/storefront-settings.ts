import mongoose, { type ClientSession } from "mongoose";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { assertCanPublish } from "@/lib/billing";
import { draftConflict, draftVersionFilter } from "@/lib/draft-version";
import { assertMediaUrlsOwned, getSectionImageUrls } from "@/lib/media-references";
import { findPlaceholders, findVisiblePlaceholders } from "@/lib/page-presets";
import {
  readStorefrontConfig,
  storefrontConfigSchema,
  type StorefrontConfig,
  type StorefrontConfigInput,
  storedConfigIsReadable,
} from "@/lib/storefront-config";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { recordLiveCopyIfNoHistory, recordRevision } from "@/lib/website-revisions";

/**
 * Server-only service behind the storefront homepage settings and the
 * website editor's store homepage. Callers must have authorised the user for
 * `businessId` with `requireBusinessRole` (owner or manager) first; this
 * module never trusts a business id on its own.
 *
 * - Draft: `themeSettings.storefront` (what the editor and preview show).
 * - Published: `themeSettings.publishedStorefront` (what the public store
 *   renders), written only by `publishStorefrontSettings` and the store
 *   publish route.
 * Only those two keys are written, with `$set`, so other theme settings
 * (colours, sections, navigation, design tokens) are never touched. A store
 * without stored settings uses the preset for its business type.
 */

function storedSettings(business: { themeSettings?: unknown }): Record<string, unknown> {
  return (business.themeSettings ?? {}) as Record<string, unknown>;
}

/** Every image URL a config references (hero, categories, promotions). */
export function storefrontImageUrls(config: Pick<StorefrontConfigInput, "hero" | "sections" | "seo">): string[] {
  const urls = [config.hero.imageUrl, config.hero.mobileImageUrl, config.seo?.imageUrl ?? ""];
  for (const section of config.sections ?? []) {
    if (section.type === "categories") urls.push(...section.categories.map((c) => c.imageUrl));
    if (section.type === "promotions") urls.push(...section.items.map((p) => p.imageUrl));
    if (section.type === "block") urls.push(...getSectionImageUrls([section.block]));
  }
  return urls.filter(Boolean);
}

/** Text still to be written, in what visitors would see. Publishing refuses it (lib/section-library.ts). */
export function assertNoHomePlaceholders(config: Pick<StorefrontConfig, "hero" | "sections">): void {
  const left = [...(config.hero.enabled ? findPlaceholders(config.hero) : []), ...findVisiblePlaceholders(config.sections)];
  if (left.length > 0) {
    throw new HttpError(422, `Replace ${left.length === 1 ? "the placeholder" : `all ${left.length} placeholders`} in [[double brackets]] on your homepage before publishing, for example ${left[0]}.`, "placeholders_remaining");
  }
}

/** The same rule for a homepage still kept in `themeSettings.sections`. */
export function assertNoLegacyHomePlaceholders(sections: unknown): void {
  const left = findVisiblePlaceholders(sections);
  if (left.length > 0) {
    throw new HttpError(422, `Replace ${left.length === 1 ? "the placeholder" : `all ${left.length} placeholders`} in [[double brackets]] on your homepage before publishing, for example ${left[0]}.`, "placeholders_remaining");
  }
}

export async function getStorefrontSettings(businessId: string): Promise<{
  draft: StorefrontConfig;
  published: StorefrontConfig | null;
  hasUnpublishedChanges: boolean;
  /** What a save names, so it cannot overwrite a newer one. */
  draftVersion: number;
}> {
  await dbConnect();
  const business = await Business.findById(businessId).select("themeSettings category storefrontDraftVersion").lean<{ themeSettings?: unknown; category?: string; storefrontDraftVersion?: number }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const settings = storedSettings(business);
  const draft = readStorefrontConfig(settings.storefront, business.category);
  const published = settings.publishedStorefront ? readStorefrontConfig(settings.publishedStorefront, business.category) : null;
  return {
    draft,
    published,
    hasUnpublishedChanges: JSON.stringify(draft) !== JSON.stringify(published ?? readStorefrontConfig(undefined, business.category)),
    draftVersion: business.storefrontDraftVersion ?? 0,
  };
}

/**
 * Validates and stores the DRAFT config. Returns the resolved config. With a
 * `session`, the checks and the write run inside that transaction (applying an
 * approved proposal uses the same path as the editor).
 */
export async function saveStorefrontDraft(businessId: string, input: unknown, options: { session?: ClientSession; expectedVersion?: number } = {}): Promise<StorefrontConfig> {
  const config = storefrontConfigSchema.parse(input);
  await dbConnect();

  // Featured products (in every collection section) must be this business's
  // own, non-archived products.
  const featuredIds = new Set<string>();
  for (const section of config.sections ?? []) {
    if (section.type === "featured") {
      section.productIds = [...new Set(section.productIds)];
      section.productIds.forEach((id) => featuredIds.add(id));
    }
  }
  if (featuredIds.size > 0) {
    const ids = [...featuredIds];
    const found = await Product.countDocuments({ _id: { $in: ids }, business: businessId, status: { $ne: "archived" } }).session(options.session ?? null);
    if (found !== ids.length) {
      throw new HttpError(422, "Choose featured products from your own catalog", "invalid_featured_product");
    }
  }

  // Images must be this business's media (external HTTPS images stay allowed,
  // as for products and sections).
  await assertMediaUrlsOwned(businessId, storefrontImageUrls(config));

  // A stored draft this version cannot read looks like the starting layout in the editor. Saving
  // over it replaces it, so what was stored goes to the history first.
  const current = await Business.findById(businessId).select("themeSettings.storefront").session(options.session ?? null).lean<{ themeSettings?: { storefront?: unknown } }>();
  if (current && !storedConfigIsReadable(current.themeSettings?.storefront)) {
    await recordRevision({ businessId, target: "home", reason: "before_restore", label: "Homepage draft that could not be read", snapshot: current.themeSettings?.storefront });
  }

  const business = await Business.findOneAndUpdate(
    { _id: businessId, ...draftVersionFilter("storefrontDraftVersion", options.expectedVersion) },
    { $set: { "themeSettings.storefront": config }, $inc: { storefrontDraftVersion: 1 } },
    { new: true, projection: { category: 1 }, session: options.session },
  ).lean<{ category?: string }>();
  if (!business) {
    if (options.expectedVersion !== undefined && (await Business.exists({ _id: businessId }))) throw draftConflict();
    throw new HttpError(404, "Business not found", "not_found");
  }
  return readStorefrontConfig(config, business.category);
}

/**
 * Copies the current draft to the published config. Same gates as publishing
 * the store: an active plan that allows publishing, and never while
 * suspended (the write itself is conditional, so a suspension that lands in
 * between wins). The published copy always has its sections materialised.
 */
export async function publishStorefrontSettings(businessId: string, options: { createdBy?: unknown } = {}): Promise<StorefrontConfig> {
  await dbConnect();
  const business = await Business.findById(businessId)
    .select("status themeSettings category")
    .lean<{ status: string; themeSettings?: unknown; category?: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  await assertCanPublish(businessId);
  if (!storedConfigIsReadable(storedSettings(business).storefront)) {
    throw new HttpError(409, "Your saved homepage draft could not be read, so nothing was published. Save it again in the website editor first.", "draft_unreadable");
  }
  const draft = readStorefrontConfig(storedSettings(business).storefront, business.category);
  assertNoHomePlaceholders(draft);
  // Re-check references at publish time (media could have been reassigned).
  await assertMediaUrlsOwned(businessId, storefrontImageUrls(draft));
  const live = storedSettings(business).publishedStorefront;
  if (live) await recordLiveCopyIfNoHistory({ businessId, target: "home", label: "Published homepage", snapshot: readStorefrontConfig(live, business.category), createdBy: options.createdBy });
  await recordRevision({ businessId, target: "home", reason: "published", label: "Published homepage", snapshot: draft, createdBy: options.createdBy });
  const result = await Business.updateOne(
    { _id: new mongoose.Types.ObjectId(businessId), status: { $ne: "suspended" } },
    { $set: { "themeSettings.publishedStorefront": draft } },
  );
  if (result.matchedCount === 0) {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  return draft;
}

/**
 * Replaces the draft with what visitors see now. What it replaces stays in the
 * history. A store that never published goes back to its starting layout.
 */
export async function revertStorefrontDraft(businessId: string, options: { createdBy?: unknown } = {}): Promise<StorefrontConfig> {
  const { draft, published } = await getStorefrontSettings(businessId);
  await recordRevision({ businessId, target: "home", reason: "before_revert", label: "Draft before going back", snapshot: draft, createdBy: options.createdBy });
  if (!published) {
    await Business.updateOne({ _id: businessId }, { $unset: { "themeSettings.storefront": "" }, $inc: { storefrontDraftVersion: 1 } });
    return (await getStorefrontSettings(businessId)).draft;
  }
  return saveStorefrontDraft(businessId, published);
}

/** Snapshot used by the main publish route (same object, never a reference). */
export function storefrontSnapshot(themeSettings: unknown, businessType?: string | null): StorefrontConfig | null {
  const settings = (themeSettings ?? {}) as Record<string, unknown>;
  // An unreadable draft is left out, so the published homepage stays as it is.
  return settings.storefront && storedConfigIsReadable(settings.storefront) ? readStorefrontConfig(settings.storefront, businessType) : null;
}
