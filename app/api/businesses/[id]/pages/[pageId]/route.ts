import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { isEmailVerified, requireBusinessRole } from "@/lib/auth/guards";
import { draftVersionFilter } from "@/lib/draft-version";
import { assertNotInMaintenance } from "@/lib/platform-settings";
import { assertCanChangeLiveWebsite } from "@/lib/publish-gates";
import { Business } from "@/models/Business";
import { Page, type PageDoc } from "@/models/Page";
import { pageUpdateSchema, normalizePageSlug } from "@/lib/validation";
import { assertMediaUrlsOwned, assertSectionMediaOwned } from "@/lib/media-references";
import { liveCopyToKeep, livePageSnapshot, pageSnapshot } from "@/lib/website-publish";
import { recordCheckpointIfDue, recordLiveCopyIfNoHistory, recordRevision } from "@/lib/website-revisions";
import type { Section } from "@/lib/sections";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { findVisiblePlaceholders } from "@/lib/page-presets";

const PAGE_WRITE_WINDOW_MS = 15 * 60 * 1000;
/** Publishing, addresses, the homepage choice and every other change that is not just draft sections. */
const PAGE_WRITE_MAX_PER_IP = 20;
/**
 * Every write by one person to one store, counted before the body is read. Interactive editing autosaves
 * at most once every 5 seconds, which is 180 in this window, so this leaves room for manual saves and a
 * second tab, and still stops a client sending as fast as it can.
 */
const PAGE_EDITING_MAX_PER_PERSON = 240;

/** All the editor's saves send. Nothing here shows on the live store: the published copy stays as it is. */
const onlyDraftSections = (body: Record<string, unknown>) =>
  body.sections !== undefined && Object.entries(body).every(([field, value]) => value === undefined || field === "sections" || field === "expectedVersion");

interface RouteContext { params: Promise<{ id: string; pageId: string }>; }

export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, pageId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();
    const page = await Page.findOne({ _id: pageId, business: id }).lean();
    if (!page) throw new HttpError(404, "Page not found", "not_found");
    return ok({ page });
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, pageId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    const ip = getClientIp(request);
    await enforceRateLimit({
      key: `pages:editing:${id}:${String(user._id)}`,
      windowMs: PAGE_WRITE_WINDOW_MS,
      limit: PAGE_EDITING_MAX_PER_PERSON,
    });

    const body = pageUpdateSchema.parse(await readJson(request));
    // Decided from what was validated, never from anything the client says about itself.
    if (!onlyDraftSections(body)) {
      await enforceRateLimit({
        key: `pages:update:${id}:${ip ?? "shared"}`,
        windowMs: PAGE_WRITE_WINDOW_MS,
        limit: PAGE_WRITE_MAX_PER_IP,
      });
    }
    if (body.status === "published" && !isEmailVerified(user)) {
      throw new HttpError(403, "Verify your email address to continue", "email_unverified");
    }
    if (body.status === "published") await assertNotInMaintenance();
    // Lean: the model would fill in an absent live copy, which is how older pages are told apart.
    const page = await Page.findOne({ _id: pageId, business: id }).lean<PageDoc>();
    if (!page) throw new HttpError(404, "Page not found", "not_found");

    // Optimistic concurrency: reject stale writes atomically
    const expectedVersion = body.expectedVersion;
    if (expectedVersion !== undefined && expectedVersion !== (page.version ?? 0)) {
      throw new HttpError(409, "Page was modified by another save. Reload and retry.", "version_conflict");
    }

    // Publishing, choosing the homepage and renaming or moving a live page all
    // show at once, so they pass the same checks. Unpublishing only needs the
    // business not to be suspended.
    const owningBusiness = await Business.findById(id).select("status").lean<{ _id: unknown; status: string }>();
    if (!owningBusiness) throw new HttpError(404, "Business not found", "not_found");
    const isLive = page.status === "published";
    const nextSlug = body.slug !== undefined ? normalizePageSlug(body.slug) : page.slug;
    const changesHome = body.isHome === true || (body.isHome === false && page.isHome && isLive);
    if (body.status === "published" || changesHome || (isLive && ((body.title !== undefined && body.title !== page.title) || nextSlug !== page.slug))) {
      await assertCanChangeLiveWebsite(owningBusiness, user);
    } else if (body.status === "draft" && owningBusiness.status === "suspended") {
      throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
    }

    // Any page goes live only after the owner has replaced every [[placeholder]] in
    // what visitors would see (generated pages and section library templates use them).
    // Policy and legal templates also need a confirmed review.
    let markReviewed = false;
    if (body.status === "published") {
      const placeholders = findVisiblePlaceholders(body.sections ?? page.sections);
      if (placeholders.length > 0) {
        throw new HttpError(
          422,
          `Replace ${placeholders.length === 1 ? "the placeholder" : `all ${placeholders.length} placeholders`} in [[double brackets]] before publishing, for example ${placeholders[0]}.`,
          "placeholders_remaining",
        );
      }
    }
    if (body.status === "published" && page.generated) {
      if (page.generated.needsReview && !page.generated.reviewedAt) {
        if (body.confirmReviewed !== true) {
          throw new HttpError(409, "This page was prepared from a policy template. Confirm that you reviewed it before publishing.", "review_required");
        }
        markReviewed = true;
      }
    }

    // Validate media ownership for the incoming draft and, when publishing,
    // for the snapshot that is about to become public.
    const sectionsToValidate: Section[] = [];
    if (body.sections) {
      sectionsToValidate.push(...body.sections);
    }
    if (body.status === "published" && !body.sections && Array.isArray(page.sections)) {
      sectionsToValidate.push(...(page.sections as Section[]));
    }
    if (sectionsToValidate.length > 0) {
      await assertSectionMediaOwned(id, sectionsToValidate);
    }

    // Build update
    const update: Record<string, unknown> = {};
    if (body.status !== "published" && (body.sections !== undefined || body.seoTitle !== undefined || body.seoDescription !== undefined || body.seoImage !== undefined || body.noindex !== undefined)) {
      Object.assign(update, liveCopyToKeep(page));
    }
    if (body.title !== undefined) update.title = body.title;
    if (body.slug !== undefined) {
      const slug = normalizePageSlug(body.slug);
      if (slug !== page.slug) {
        if (await Page.exists({ business: id, slug, _id: { $ne: page._id } })) {
          throw new HttpError(409, `Another page already uses the address /${slug}.`, "slug_taken");
        }
        update.slug = slug;
        // Links people already have keep working: the old address redirects here.
        const wasPublic = page.status === "published";
        const previous = (page.previousSlugs ?? []).filter((old) => old !== slug);
        update.previousSlugs = (wasPublic ? [page.slug, ...previous.filter((old) => old !== page.slug)] : previous).slice(0, 10);
        // A freed address now belongs to this page, not to an older redirect.
        await Page.updateMany({ business: id, previousSlugs: slug, _id: { $ne: page._id } }, { $pull: { previousSlugs: slug } });
      }
    }
    if (body.sections !== undefined) update.sections = body.sections;
    if (body.seoTitle !== undefined) update.seoTitle = body.seoTitle;
    if (body.seoDescription !== undefined) update.seoDescription = body.seoDescription;
    if (body.seoImage !== undefined) {
      await assertMediaUrlsOwned(id, [body.seoImage]);
      update.seoImage = body.seoImage;
    }
    if (body.noindex !== undefined) update.noindex = body.noindex;
    if (body.canonicalUrl !== undefined) update.canonicalUrl = body.canonicalUrl;
    if (body.description !== undefined) update.description = body.description;
    if (markReviewed) {
      update["generated.needsReview"] = false;
      update["generated.reviewedAt"] = new Date();
      update["generated.reviewedBy"] = user._id;
    }
    if (body.isHome === true) {
      await Page.updateMany({ business: id, isHome: true, _id: { $ne: page._id } }, { $set: { isHome: false } });
      update.isHome = true;
    } else if (body.isHome === false && page.isHome) {
      const otherHomes = await Page.countDocuments({ business: id, isHome: true, _id: { $ne: page._id } });
      if (otherHomes === 0) {
        throw new HttpError(400, "Cannot remove the only homepage", "last_homepage");
      }
      update.isHome = false;
    }
    if (body.status !== undefined) {
      update.status = body.status;
      if (body.status === "published") {
        const sectionsToPublish = body.sections ?? page.sections;
        update.publishedSections = Array.isArray(sectionsToPublish)
          ? [...sectionsToPublish]
          : [];
        // Snapshot SEO text together with the sections it describes.
        update.publishedSeoTitle = body.seoTitle ?? page.seoTitle ?? "";
        update.publishedSeoDescription =
          body.seoDescription ?? page.seoDescription ?? "";
        update.publishedSeoImage = body.seoImage ?? page.seoImage ?? "";
        update.publishedNoindex = body.noindex ?? page.noindex ?? false;
        update.publishedCanonicalUrl = body.canonicalUrl ?? page.canonicalUrl ?? "";
      }
    }

    // Atomic conditional update using version filter
    const filter: Record<string, unknown> = { _id: pageId, business: id, ...draftVersionFilter("version", expectedVersion) };
    const result = await Page.updateOne(filter, {
      $set: update,
      $inc: { version: 1 },
    });

    if (result.matchedCount === 0) {
      throw new HttpError(409, "Page was modified by another save. Reload and retry.", "version_conflict");
    }

    const updated = await Page.findOne({ _id: pageId, business: id }).lean();
    if (updated && body.status === "published") {
      if (page.status === "published") await recordLiveCopyIfNoHistory({ businessId: id, target: "page", targetId: pageId, label: page.title, snapshot: livePageSnapshot(page), createdBy: user._id });
      await recordRevision({ businessId: id, target: "page", targetId: pageId, reason: "published", label: updated.title, snapshot: pageSnapshot(updated), createdBy: user._id });
    } else if (body.sections !== undefined) {
      // Long editing sessions keep a copy of what they replace, now and then.
      await recordCheckpointIfDue({ businessId: id, target: "page", targetId: pageId, label: page.title, snapshot: pageSnapshot(page), createdBy: user._id });
    }
    return ok({ page: updated });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, pageId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    const page = await Page.findOne({ _id: pageId, business: id });
    if (!page) throw new HttpError(404, "Page not found", "not_found");

    // A suspended store is frozen: its content stays as it is for the platform's
    // review. Otherwise taking a page down never needs a plan or a verified email,
    // like unpublishing, so an owner can always remove something from their store.
    const owningBusiness = await Business.findById(id).select("status").lean<{ status: string }>();
    if (owningBusiness?.status === "suspended") {
      throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
    }

    if (page.isHome) {
      const otherHomes = await Page.countDocuments({ business: id, isHome: true, _id: { $ne: page._id } });
      if (otherHomes === 0) {
        throw new HttpError(400, "Cannot delete the only homepage", "last_homepage");
      }
    }

    // Kept so the page can be brought back from "Recently deleted".
    await recordRevision({ businessId: id, target: "page", targetId: pageId, reason: "deleted", label: page.title, snapshot: pageSnapshot(page), createdBy: user._id });
    await page.deleteOne();
    return ok({ deleted: true });
  });
}