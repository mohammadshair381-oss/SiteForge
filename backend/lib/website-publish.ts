import { HttpError } from "@/lib/api";
import { assertCanPublish } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { getDesignState, publishDesignDraft } from "@/lib/design-service";
import { assertSectionMediaOwned } from "@/lib/media-references";
import { navigationPageIds, type StoredNavigation } from "@/lib/navigation";
import { findVisiblePlaceholders } from "@/lib/page-presets";
import { getVisibleSections, resolvePublishedPageSections, type Section } from "@/lib/sections";
import { getStorefrontSettings, publishStorefrontSettings } from "@/lib/storefront-settings";
import { recordLiveCopyIfNoHistory, recordRevision } from "@/lib/website-revisions";
import { Business } from "@/models/Business";
import { Page, type PageDoc } from "@/models/Page";

/**
 * What differs between the drafts and the live website, and publishing it
 * (server-only). Callers authorise first. Nothing here publishes on its own:
 * the owner chooses the items. A page that still has [[placeholders]] or needs
 * its policy review is listed but cannot be published from here.
 */
export interface PendingItem {
  key: string;
  label: string;
  detail: string;
  kind: "home" | "design" | "navigation" | "page";
  /** Why it cannot be published yet. */
  blocked?: string;
  /** Link to where it is edited (relative to the business's dashboard). */
  edit: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function pageDiffers(page: PageDoc): boolean {
  if (page.status !== "published") return false;
  return (
    !same(page.sections, resolvePublishedPageSections(page)) ||
    (page.seoTitle ?? "") !== (page.publishedSeoTitle ?? page.seoTitle ?? "") ||
    (page.seoDescription ?? "") !== (page.publishedSeoDescription ?? page.seoDescription ?? "") ||
    (page.seoImage ?? "") !== (page.publishedSeoImage ?? page.seoImage ?? "") ||
    Boolean(page.noindex) !== Boolean(page.publishedNoindex ?? page.noindex) ||
    (page.canonicalUrl ?? "") !== (page.publishedCanonicalUrl ?? "")
  );
}

function pageBlock(page: PageDoc): string | undefined {
  const left = findVisiblePlaceholders(page.sections).length;
  if (left > 0) return `Replace the ${left === 1 ? "text" : `${left} texts`} in [[double brackets]] first.`;
  if (page.generated?.needsReview && !page.generated.reviewedAt) return "Review this policy page in the editor and publish it there.";
  return undefined;
}

export async function websiteStatus(businessId: string): Promise<{ storeLive: boolean; items: PendingItem[]; draftPages: PendingItem[] }> {
  await dbConnect();
  const business = await Business.findById(businessId).select("status themeSettings").lean<{ status: string; themeSettings?: Record<string, unknown> }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const [storefront, design, pages] = await Promise.all([
    getStorefrontSettings(businessId),
    getDesignState(businessId),
    Page.find({ business: businessId }).select("title slug status isHome sections publishedSections seoTitle seoDescription publishedSeoTitle publishedSeoDescription seoImage publishedSeoImage noindex publishedNoindex canonicalUrl publishedCanonicalUrl generated version").lean<PageDoc[]>(),
  ]);
  const items: PendingItem[] = [];
  if (storefront.hasUnpublishedChanges) {
    // `/` shows a published Home page with sections, or sections kept in the settings, ahead of this.
    const liveHome = pages.find((page) => page.isHome && page.status === "published");
    const classicLive = getVisibleSections(liveHome ? resolvePublishedPageSections(liveHome) : business.themeSettings?.sections).length > 0;
    items.push(
      classicLive
        ? { key: "home", kind: "home", label: "Homepage settings", detail: "Announcement, header and footer go live from here. Your custom homepage stays until you publish the new one from the website editor.", edit: "editor?mode=store" }
        : { key: "home", kind: "home", label: "Homepage", detail: "Sections, hero, announcement or footer", edit: "editor" },
    );
  }
  if (design.hasUnpublishedChanges) {
    items.push({ key: "design", kind: "design", label: "Design", detail: design.draft.themeId !== design.live.themeId ? "Theme, colours or fonts" : "Colours, fonts or buttons", edit: "design" });
  }
  const settings = business.themeSettings ?? {};
  if (settings.navigation && !same(settings.navigation, settings.publishedNavigation)) {
    items.push({ key: "navigation", kind: "navigation", label: "Menus", detail: "Header and footer links", edit: "navigation" });
  }
  const pageItem = (page: PageDoc, detail: string): PendingItem => ({
    key: `page:${String(page._id)}`,
    kind: "page",
    label: page.title,
    detail,
    edit: `editor?page=${String(page._id)}`,
    ...(pageBlock(page) ? { blocked: pageBlock(page) } : {}),
  });
  for (const page of pages) if (pageDiffers(page)) items.push(pageItem(page, `Edited since it was published · /${page.slug}`));
  const draftPages = pages.filter((page) => page.status !== "published" && Array.isArray(page.sections) && page.sections.length > 0).map((page) => pageItem(page, `Not published yet · /${page.slug}`));
  return { storeLive: business.status === "published", items, draftPages };
}

/** Publishes one page's current draft (same result as publishing it in the editor). */
export async function publishPageDraft(businessId: string, page: PageDoc, createdBy: unknown): Promise<void> {
  const sections = Array.isArray(page.sections) ? (page.sections as Section[]) : [];
  await assertSectionMediaOwned(businessId, sections);
  if (page.status === "published") await recordLiveCopyIfNoHistory({ businessId, target: "page", targetId: String(page._id), label: page.title, snapshot: livePageSnapshot(page), createdBy });
  await Page.updateOne(
    { _id: page._id, business: businessId },
    {
      $set: {
        status: "published",
        publishedSections: [...sections],
        publishedSeoTitle: page.seoTitle ?? "",
        publishedSeoDescription: page.seoDescription ?? "",
        publishedSeoImage: page.seoImage ?? "",
        publishedNoindex: Boolean(page.noindex),
        publishedCanonicalUrl: page.canonicalUrl ?? "",
      },
      $inc: { version: 1 },
    },
  );
  await recordRevision({ businessId, target: "page", targetId: String(page._id), reason: "published", label: page.title, snapshot: pageSnapshot(page), createdBy });
}

export function pageSnapshot(page: Pick<PageDoc, "title" | "slug" | "sections" | "seoTitle" | "seoDescription" | "seoImage" | "noindex" | "description" | "canonicalUrl">) {
  return {
    title: page.title,
    slug: page.slug,
    sections: page.sections,
    seoTitle: page.seoTitle ?? "",
    seoDescription: page.seoDescription ?? "",
    seoImage: page.seoImage ?? "",
    noindex: Boolean(page.noindex),
    canonicalUrl: page.canonicalUrl ?? "",
    description: page.description ?? "",
  };
}

/** What visitors see on a published page, in the same shape as `pageSnapshot`. */
export function livePageSnapshot(page: Parameters<typeof pageSnapshot>[0] & Pick<PageDoc, "publishedSections" | "publishedSeoTitle" | "publishedSeoDescription" | "publishedSeoImage" | "publishedNoindex" | "publishedCanonicalUrl">) {
  return {
    ...pageSnapshot(page),
    sections: resolvePublishedPageSections(page),
    seoTitle: page.publishedSeoTitle ?? page.seoTitle ?? "",
    seoDescription: page.publishedSeoDescription ?? page.seoDescription ?? "",
    seoImage: page.publishedSeoImage ?? page.seoImage ?? "",
    noindex: Boolean(page.publishedNoindex ?? page.noindex),
    canonicalUrl: page.publishedCanonicalUrl ?? "",
  };
}

/**
 * A page published before live copies existed has none, so visitors see its saved fields. The
 * first draft edit keeps those as the live copy, or the edit would reach visitors at once.
 * Pass it the raw (lean) page, because the model fills in an absent `publishedSections`.
 */
export function liveCopyToKeep(page: Pick<PageDoc, "status" | "sections" | "seoTitle" | "seoDescription" | "seoImage" | "noindex" | "publishedSections" | "publishedSeoTitle" | "publishedSeoDescription" | "publishedSeoImage" | "publishedNoindex">): Record<string, unknown> {
  if (page.status !== "published") return {};
  return {
    ...(page.publishedSections === undefined ? { publishedSections: Array.isArray(page.sections) ? page.sections : [] } : {}),
    ...(page.publishedSeoTitle == null ? { publishedSeoTitle: page.seoTitle ?? "" } : {}),
    ...(page.publishedSeoDescription == null ? { publishedSeoDescription: page.seoDescription ?? "" } : {}),
    ...(page.publishedSeoImage == null ? { publishedSeoImage: page.seoImage ?? "" } : {}),
    ...(page.publishedNoindex == null ? { publishedNoindex: Boolean(page.noindex) } : {}),
  };
}

/** Copies the draft menus to the live store, after checking every page is this business's. */
export async function publishNavigationDraft(businessId: string, createdBy: unknown): Promise<void> {
  await dbConnect();
  const business = await Business.findById(businessId).select("themeSettings").lean<{ themeSettings?: Record<string, unknown> }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const navigation = (business.themeSettings?.navigation ?? null) as StoredNavigation | null;
  if (!navigation) return;
  const ids = navigationPageIds(navigation);
  if (ids.length > 0) {
    const found = await Page.countDocuments({ _id: { $in: ids }, business: businessId });
    if (found !== ids.length) throw new HttpError(400, "A menu links to a page that no longer exists. Remove it and try again.", "invalid_navigation_reference");
  }
  if (business.themeSettings?.publishedNavigation) {
    await recordRevision({ businessId, target: "navigation", reason: "published", label: "Menus before publishing", snapshot: business.themeSettings.publishedNavigation, createdBy });
  }
  await Business.updateOne({ _id: businessId, status: { $ne: "suspended" } }, { $set: { "themeSettings.publishedNavigation": navigation } });
}

export async function publishWebsiteItems(businessId: string, keys: string[], createdBy: unknown): Promise<{ published: string[]; failed: Array<{ key: string; error: string }> }> {
  await dbConnect();
  const business = await Business.findById(businessId).select("status").lean<{ status: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  await assertCanPublish(businessId);

  const published: string[] = [];
  const failed: Array<{ key: string; error: string }> = [];
  for (const key of keys) {
    try {
      if (key === "home") await publishStorefrontSettings(businessId, { createdBy });
      else if (key === "design") await publishDesignDraft(businessId, { createdBy });
      else if (key === "navigation") await publishNavigationDraft(businessId, createdBy);
      else if (key.startsWith("page:")) {
        const page = await Page.findOne({ _id: key.slice(5), business: businessId }).lean<PageDoc>();
        if (!page) throw new HttpError(404, "This page no longer exists.", "not_found");
        const blocked = pageBlock(page);
        if (blocked) throw new HttpError(409, blocked, "page_not_ready");
        await publishPageDraft(businessId, page, createdBy);
      } else throw new HttpError(400, "Unknown item.", "invalid_item");
      published.push(key);
    } catch (error) {
      failed.push({ key, error: error instanceof HttpError ? error.message : "This could not be published. Please try again." });
    }
  }
  return { published, failed };
}
