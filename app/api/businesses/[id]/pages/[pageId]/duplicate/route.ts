import { HttpError, created, handle } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { dbConnect } from "@/lib/db";
import { assertObjectId } from "@/lib/ids";
import { findPlaceholders } from "@/lib/page-presets";
import { uniquePageSlug } from "@/lib/page-operations";
import { assertCanAddPages, withPageCapacity } from "@/lib/usage-limits";
import { Page } from "@/models/Page";

type RouteContext = { params: Promise<{ id: string; pageId: string }> };

/**
 * `POST` — copies a page's DRAFT into a new draft page, never the home page and
 * never published. A copy that still has [[placeholders]] or an unreviewed policy
 * template keeps those publish checks.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, pageId } = await context.params;
    assertObjectId(pageId, "page id");
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    const page = await Page.findOne({ _id: pageId, business: id }).lean();
    if (!page) throw new HttpError(404, "Page not found", "not_found");

    await assertCanAddPages(id);

    const needsChecks = page.generated && (page.generated.needsReview || findPlaceholders(page.sections).length > 0);
    const slug = await uniquePageSlug(id, `${page.slug}-copy`);
    const fields = {
      business: id,
      title: `${page.title} (copy)`.slice(0, 140),
      slug,
      sections: page.sections,
      seoTitle: page.seoTitle ?? "",
      seoDescription: page.seoDescription ?? "",
      ...(page.seoImage ? { seoImage: page.seoImage } : {}),
      ...(page.noindex ? { noindex: true } : {}),
      ...(page.description ? { description: page.description } : {}),
      ...(needsChecks && page.generated
        ? { generated: { key: `copy-${page.generated.key}`.slice(0, 80), source: page.generated.source, preset: page.generated.preset, needsReview: page.generated.needsReview, createdAt: new Date() } }
        : {}),
      status: "draft",
      isHome: false,
    };
    const [copy] = await withPageCapacity(id, 1, (session) => Page.create([fields], { session }));
    return created({ page: copy.toJSON() });
  });
}
