import { HttpError, handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { getDesignState, saveDesignDraft } from "@/lib/design-service";
import { assertSectionMediaOwned } from "@/lib/media-references";
import { navigationPageIds, type StoredNavigation } from "@/lib/navigation";
import { saveNavigationDraft } from "@/lib/navigation-draft";
import { uniquePageSlug } from "@/lib/page-operations";
import { sectionsArraySchema, type Section } from "@/lib/sections";
import { getStorefrontSettings, saveStorefrontDraft } from "@/lib/storefront-settings";
import { assertCanAddPages, withPageCapacity } from "@/lib/usage-limits";
import { liveCopyToKeep, pageSnapshot } from "@/lib/website-publish";
import { deleteRevision, getRevision, recordRevision } from "@/lib/website-revisions";
import { Business } from "@/models/Business";
import { Page, type PageDoc } from "@/models/Page";

interface RouteContext {
  params: Promise<{ id: string; revisionId: string }>;
}

/**
 * `POST` — brings a saved version back INTO THE DRAFT. It never publishes: the
 * owner reviews it and publishes as usual. What it replaces is kept first, so a
 * restore can itself be undone. Old content is validated again, because the
 * rules may have tightened since it was saved.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, revisionId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    const revision = await getRevision(id, revisionId);
    if (!revision) throw new HttpError(404, "This version no longer exists.", "not_found");

    if (revision.target === "home") {
      const { draft } = await getStorefrontSettings(id);
      await recordRevision({ businessId: id, target: "home", reason: "before_restore", label: "Draft before restoring", snapshot: draft, createdBy: user._id });
      await saveStorefrontDraft(id, revision.snapshot);
      return ok({ restored: "home" });
    }

    if (revision.target === "design") {
      const { draft } = await getDesignState(id);
      await recordRevision({ businessId: id, target: "design", reason: "before_restore", label: "Design draft before restoring", snapshot: draft, createdBy: user._id });
      await saveDesignDraft(id, revision.snapshot);
      return ok({ restored: "design" });
    }

    if (revision.target === "navigation") {
      const navigation = revision.snapshot as StoredNavigation;
      const ids = navigationPageIds(navigation);
      const existing = ids.length > 0 ? await Page.find({ _id: { $in: ids }, business: id }).select("_id").lean() : [];
      const keep = new Set(existing.map((page) => String(page._id)));
      // A page deleted since then simply drops out of the restored menu.
      const clean = (items: StoredNavigation["header"]): StoredNavigation["header"] =>
        (items ?? []).filter((item) => !item.pageId || keep.has(item.pageId)).map((item) => ({ ...item, ...(item.children ? { children: clean(item.children) } : {}) }));
      const stored = await Business.findById(id).select("themeSettings.navigation").lean<{ themeSettings?: { navigation?: unknown } }>();
      if (stored?.themeSettings?.navigation) {
        await recordRevision({ businessId: id, target: "navigation", reason: "before_restore", label: "Menus before restoring", snapshot: stored.themeSettings.navigation, createdBy: user._id });
      }
      await saveNavigationDraft(id, { header: clean(navigation.header), footer: clean(navigation.footer) });
      return ok({ restored: "navigation" });
    }

    const snapshot = revision.snapshot as ReturnType<typeof pageSnapshot>;
    const sections = sectionsArraySchema.parse(snapshot.sections ?? []) as Section[];
    await assertSectionMediaOwned(id, sections);
    const page = await Page.findOne({ _id: revision.targetId, business: id }).lean<PageDoc>();

    // The page was deleted: bring it back as a new draft.
    if (!page) {
      await assertCanAddPages(id);
      const slug = await uniquePageSlug(id, snapshot.slug);
      const [created] = await withPageCapacity(id, 1, (session) =>
          Page.create(
            [
              {
                business: id,
                title: snapshot.title,
                slug,
                sections,
                seoTitle: snapshot.seoTitle,
                seoDescription: snapshot.seoDescription,
                seoImage: snapshot.seoImage,
                noindex: snapshot.noindex,
                canonicalUrl: snapshot.canonicalUrl,
                description: snapshot.description || undefined,
                status: "draft",
                isHome: false,
              },
            ],
            { session },
          ),
      );
      await deleteRevision(id, revisionId);
      return ok({ restored: "page", page: created.toJSON() });
    }

    await recordRevision({ businessId: id, target: "page", targetId: String(page._id), reason: "before_restore", label: page.title, snapshot: pageSnapshot(page), createdBy: user._id });
    await Page.updateOne(
      { _id: page._id, business: id },
      {
        // A revision from before canonical addresses existed leaves the current one alone.
        $set: { ...liveCopyToKeep(page), sections, seoTitle: snapshot.seoTitle, seoDescription: snapshot.seoDescription, seoImage: snapshot.seoImage, noindex: snapshot.noindex, ...(snapshot.canonicalUrl !== undefined ? { canonicalUrl: snapshot.canonicalUrl } : {}) },
        $inc: { version: 1 },
      },
    );
    return ok({ restored: "page", page: await Page.findOne({ _id: page._id, business: id }).lean() });
  });
}
