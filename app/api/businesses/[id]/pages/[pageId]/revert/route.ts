import { HttpError, handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { dbConnect } from "@/lib/db";
import { assertObjectId } from "@/lib/ids";
import { resolvePublishedPageSections } from "@/lib/sections";
import { pageSnapshot } from "@/lib/website-publish";
import { recordRevision } from "@/lib/website-revisions";
import { Page } from "@/models/Page";

type RouteContext = { params: Promise<{ id: string; pageId: string }> };

/** `POST` — throws away a published page's draft edits: the draft becomes what visitors see. The draft is kept in the history. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, pageId } = await context.params;
    assertObjectId(pageId, "page id");
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    const page = await Page.findOne({ _id: pageId, business: id }).lean();
    if (!page) throw new HttpError(404, "Page not found", "not_found");
    if (page.status !== "published") throw new HttpError(409, "This page has not been published, so there is no published version to go back to.", "not_published");

    await recordRevision({ businessId: id, target: "page", targetId: pageId, reason: "before_revert", label: page.title, snapshot: pageSnapshot(page), createdBy: user._id });
    await Page.updateOne(
      { _id: pageId, business: id },
      {
        $set: {
          // A page published before live copies existed shows its saved sections.
          sections: resolvePublishedPageSections(page),
          seoTitle: page.publishedSeoTitle ?? page.seoTitle ?? "",
          seoDescription: page.publishedSeoDescription ?? page.seoDescription ?? "",
          seoImage: page.publishedSeoImage ?? page.seoImage ?? "",
          noindex: Boolean(page.publishedNoindex ?? page.noindex),
          canonicalUrl: page.publishedCanonicalUrl ?? "",
        },
        $inc: { version: 1 },
      },
    );
    return ok({ page: await Page.findOne({ _id: pageId, business: id }).lean() });
  });
}
