import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { ensureHomeMirror } from "@/lib/page-generation";
import { uniquePageSlug } from "@/lib/page-operations";
import { recordLiveCopyIfNoHistory } from "@/lib/website-revisions";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";

const isDuplicateKey = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;

const publishedCopy = (sections: unknown[]) => ({
  status: "published" as const,
  publishedSections: sections,
  publishedSeoTitle: "",
  publishedSeoDescription: "",
  publishedSeoImage: "",
  publishedNoindex: false,
});

/**
 * Brings a homepage kept only in `themeSettings.sections` into a Home page record,
 * so it gets drafts, autosave, version history, previews and explicit publishing
 * like every other page. Visitors see no change: the record's published copy is
 * exactly what the store shows now. A draft Home page keeps its own sections as
 * the draft. Safe to repeat: once the sections have moved, nothing happens.
 *
 * The old sections are renamed, not deleted, so they cannot reappear on the store
 * if the Home page is later unpublished, and nothing is lost. Callers authorise first.
 */
export async function adoptLegacyHomepage(businessId: string, createdBy?: unknown): Promise<{ pageId: string | null }> {
  await dbConnect();
  const business = await Business.findById(businessId).select("status themeSettings").lean<{ status: string; themeSettings?: { sections?: unknown } }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  const legacy = Array.isArray(business.themeSettings?.sections) ? (business.themeSettings.sections as unknown[]) : [];

  const findHome = () => Page.findOne({ business: businessId, isHome: true }).sort({ status: -1 }).lean();
  let home = await findHome();
  if (legacy.length === 0) return { pageId: home?.status === "published" ? String(home._id) : null };

  // A published Home page already wins over these sections on the store.
  if (home?.status !== "published") {
    try {
      if (home) {
        const ownDraft = Array.isArray(home.sections) && home.sections.length > 0;
        await Page.updateOne(
          { _id: home._id, business: businessId, status: "draft" },
          { $set: { ...publishedCopy(legacy), ...(ownDraft ? {} : { sections: legacy }) }, $inc: { version: 1 } },
        );
      } else if (!(await ensureHomeMirror(businessId))) {
        await Page.create({ business: businessId, title: "Home", slug: await uniquePageSlug(businessId, "home"), isHome: true, sections: legacy, seoTitle: "", seoDescription: "", ...publishedCopy(legacy) });
      }
    } catch (error) {
      // Another tab got there first: its copy is the same.
      if (!isDuplicateKey(error)) throw error;
    }
    home = await findHome();
    if (!home) throw new HttpError(500, "Your homepage could not be prepared for editing.", "internal_error");
    await recordLiveCopyIfNoHistory({
      businessId,
      target: "page",
      targetId: String(home._id),
      label: home.title,
      snapshot: { title: home.title, slug: home.slug, sections: legacy, seoTitle: "", seoDescription: "", seoImage: "", noindex: false, description: "" },
      createdBy,
    });
  }

  await Business.updateOne({ _id: businessId }, { $rename: { "themeSettings.sections": "themeSettings.legacySections" } });
  return { pageId: home ? String(home._id) : null };
}
