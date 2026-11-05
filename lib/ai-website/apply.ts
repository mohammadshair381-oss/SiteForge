import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { assertAiConsent } from "@/lib/ai-builder/consent";
import { assertProposalActor } from "@/lib/ai-planning/apply-approved-proposal";
import { assertCanUseTheme } from "@/lib/billing";
import { saveDesignDraft } from "@/lib/design-service";
import { assertMediaUrlsOwned, assertSectionMediaOwned } from "@/lib/media-references";
import { saveNavigationDraft } from "@/lib/navigation-draft";
import { assertBusinessNotSuspended } from "@/lib/publish-gates";
import type { Section } from "@/lib/sections";
import { saveStorefrontDraft } from "@/lib/storefront-settings";
import { assertCanAddPages } from "@/lib/usage-limits";
import { liveCopyToKeep, pageSnapshot } from "@/lib/website-publish";
import { recordRevision } from "@/lib/website-revisions";
import { Page, type PageDoc } from "@/models/Page";
import { Product } from "@/models/Product";
import type { WebsiteProposalDoc } from "@/models/WebsiteProposal";
import { websiteNavigationSchema, websitePageSchema, type WebsiteProposalData } from "./blueprint";
import { baseDiffers } from "./proposal";
import { loadWebsiteState, storedNavigationFrom } from "./state";

const pagesSchema = z.array(websitePageSchema);

/**
 * Applies an APPROVED website proposal the caller has just claimed inside `session`
 * (lib/ai-planning/proposal-service.ts applyProposal), all of it or none of it. Every write uses the
 * draft services the editors use, inside the one transaction. It never publishes: no published copy is
 * written here, so what visitors see cannot change. With no transaction support the claim itself fails
 * and nothing is written (`503 transactions_unavailable`).
 */
export async function applyApprovedWebsiteProposal(
  businessId: string,
  doc: Pick<WebsiteProposalDoc, "website" | "status">,
  options: { session: ClientSession; actorUserId: string },
): Promise<{ pages: Array<{ id: string; title: string; slug: string; created: boolean }> }> {
  const { session, actorUserId } = options;
  if (doc.status !== "applied" && doc.status !== "approved") throw new HttpError(409, "Only approved proposals can be applied.", "proposal_not_approved");
  const data = doc.website as WebsiteProposalData | undefined;
  if (!data) throw new HttpError(422, "This proposal no longer passes validation.", "validation_error");

  // Authorization, consent and the store's state, as they are now.
  await assertProposalActor(businessId, actorUserId);
  await assertAiConsent(businessId);
  await assertBusinessNotSuspended(businessId);

  // The proposal was checked when it was made; it is checked again now, as data that has been stored.
  const createPages = pagesSchema.parse(data.changes.createPages);
  const updatePages = pagesSchema.parse(data.changes.updatePages);
  const navigation = data.changes.navigation ? websiteNavigationSchema.parse(data.changes.navigation) : null;

  const loaded = await loadWebsiteState(businessId, session);
  const stale = () => new HttpError(409, "Your website changed after this proposal was prepared, so nothing was applied. Ask again for a fresh one.", "version_conflict");
  if (baseDiffers(data, loaded.base)) throw stale();
  if (createPages.some((page) => loaded.state.pages.some((existing) => existing.slug === page.slug))) {
    throw new HttpError(409, "A proposed page address is already in use, so nothing was applied. Ask again for a fresh proposal.", "page_slug_conflict");
  }
  if (updatePages.some((page) => loaded.lockedPageIds.includes(page.id ?? ""))) throw new HttpError(409, "A page has content this proposal cannot work with. Edit it in the website editor.", "page_not_supported");

  // Plan limits, as they are now.
  if (data.changes.design) await assertCanUseTheme(businessId, data.changes.design.themeId, loaded.business.themeId);
  if (createPages.length > 0) {
    await assertCanAddPages(businessId, createPages.length, session);
    const { ensureHomeMirror } = await import("@/lib/page-generation");
    await ensureHomeMirror(businessId, session, createPages.map((page) => page.slug));
  }

  // Products this proposal adds must still be for sale. Ones the owner chose earlier stay their choice.
  if (data.changes.config) {
    const featuredIds = (sections: typeof loaded.state.config.sections) => sections.flatMap((section) => (section.type === "featured" ? section.productIds : []));
    const already = new Set(featuredIds(loaded.state.config.sections));
    const added = [...new Set(featuredIds(data.changes.config.sections))].filter((id) => !already.has(id));
    if (added.length > 0 && (await Product.countDocuments({ _id: { $in: added }, business: businessId, status: "active" }).session(session)) !== added.length) {
      throw new HttpError(409, "A product in this proposal is no longer available, so nothing was applied. Ask the assistant again.", "invalid_featured_product");
    }
  }

  const allSections = [...createPages, ...updatePages].flatMap((page) => page.sections as Section[]);
  if (allSections.length > 0) await assertSectionMediaOwned(businessId, allSections);
  await assertMediaUrlsOwned(businessId, [...createPages, ...updatePages].map((page) => page.seoImage));

  const idOf = new Map(loaded.state.pages.map((page) => [page.slug, page.id as string]));

  // What is replaced stays in the history, so an applied proposal can be undone piece by piece.
  const label = "Before an AI website proposal";
  if (data.changes.config) await recordRevision({ businessId, target: "home", reason: "checkpoint", label, snapshot: loaded.state.config, createdBy: actorUserId });
  if (data.changes.design) await recordRevision({ businessId, target: "design", reason: "checkpoint", label, snapshot: loaded.state.design, createdBy: actorUserId });
  if (navigation) await recordRevision({ businessId, target: "navigation", reason: "checkpoint", label, snapshot: storedNavigationFrom(loaded.state.navigation, idOf), createdBy: actorUserId });

  // ---- Pages first, so menus can name the new ones.
  const applied: Array<{ id: string; title: string; slug: string; created: boolean }> = [];
  const now = new Date();
  for (const page of createPages) {
    const [created] = await Page.create(
      [
        {
          business: businessId,
          title: page.title,
          slug: page.slug,
          description: page.description || undefined,
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          seoImage: page.seoImage || undefined,
          sections: page.sections,
          status: "draft",
          isHome: false,
          version: 0,
          ...(page.aiWritten ? { generated: { key: `ai:${page.slug}`.slice(0, 80), source: "ai" as const, preset: "ai", needsReview: Boolean(page.needsReview), createdAt: now } } : {}),
        },
      ],
      { session },
    );
    idOf.set(created.slug, String(created._id));
    applied.push({ id: String(created._id), title: created.title, slug: created.slug, created: true });
  }
  for (const page of updatePages) {
    const current = await Page.findOne({ _id: page.id as string, business: businessId }).session(session).lean<PageDoc>();
    if (!current) throw stale();
    await recordRevision({ businessId, target: "page", targetId: String(current._id), reason: "checkpoint", label, snapshot: pageSnapshot(current), createdBy: actorUserId });
    const result = await Page.updateOne(
      { _id: new mongoose.Types.ObjectId(page.id as string), business: businessId, version: current.version },
      {
        $set: {
          // A page published before live copies existed: what visitors see is kept as its live copy.
          ...liveCopyToKeep(current),
          title: current.status === "published" ? current.title : page.title,
          description: page.description,
          sections: page.sections,
          seoTitle: page.seoTitle,
          seoDescription: page.seoDescription,
          seoImage: page.seoImage,
        },
        $inc: { version: 1 },
      },
      { session },
    );
    if (result.matchedCount === 0) throw stale();
    applied.push({ id: String(current._id), title: page.title, slug: page.slug, created: false });
  }

  // ---- The homepage, header and footer; the menus; the design. Each moves its own draft version on.
  if (data.changes.config) await saveStorefrontDraft(businessId, data.changes.config, { session, expectedVersion: data.base.storefrontVersion });
  if (navigation) {
    await saveNavigationDraft(businessId, storedNavigationFrom(navigation, idOf), { session, expectedVersion: data.base.navigationVersion });
  }
  if (data.changes.design) await saveDesignDraft(businessId, data.changes.design, { session, expectedVersion: data.base.designVersion });
  return { pages: applied };
}
