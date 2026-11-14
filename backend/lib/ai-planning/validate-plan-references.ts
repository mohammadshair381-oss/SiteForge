import type { ClientSession } from "mongoose";
import { HttpError } from "@/lib/api";
import { assertSectionMediaOwned } from "@/lib/media-references";
import type { WebsitePlan } from "@/lib/ai-planning/plan";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";

export async function validateWebsitePlanReferences(
  businessId: string,
  plan: WebsitePlan,
  session?: ClientSession,
): Promise<Array<{ _id: unknown; status: string; version: number }>> {
  let pagesQuery = Page.find({ business: businessId }).select(
    "_id slug status version isHome",
  );
  let productsQuery = Product.find({
    business: businessId,
    _id: { $in: plan.productIds },
    status: "active",
  }).select("_id");

  if (session) {
    pagesQuery = pagesQuery.session(session);
    productsQuery = productsQuery.session(session);
  }

  const [existingPages, products] = session
    ? [await pagesQuery.lean(), await productsQuery.lean()]
    : await Promise.all([pagesQuery.lean(), productsQuery.lean()]);
  const pagesById = new Map(
    existingPages.map((page) => [String(page._id).toLowerCase(), page]),
  );
  const pagesBySlug = new Map(existingPages.map((page) => [page.slug, page]));

  for (const page of plan.pages) {
    const target = page.existingPageId
      ? pagesById.get(page.existingPageId.toLowerCase())
      : undefined;
    if (page.existingPageId && !target) {
      throw new HttpError(
        400,
        "A selected existing page does not belong to this business.",
        "invalid_plan_page_reference",
      );
    }
    if (target) {
      if (target.status !== "draft") {
        throw new HttpError(
          409,
          "Only existing draft pages can be replaced.",
          "page_not_replaceable",
        );
      }
      if (target.version !== page.expectedVersion) {
        throw new HttpError(
          409,
          "A selected draft page has changed. Refresh the planner and review it again.",
          "version_conflict",
        );
      }
    }

    const slugOwner = pagesBySlug.get(page.slug);
    if (
      slugOwner &&
      String(slugOwner._id).toLowerCase() !== page.existingPageId?.toLowerCase()
    ) {
      throw new HttpError(
        409,
        `The slug "${page.slug}" is already in use by this business.`,
        "page_slug_conflict",
      );
    }
  }

  if (products.length !== plan.productIds.length) {
    throw new HttpError(
      400,
      "A selected product is unavailable in this business.",
      "invalid_plan_product_reference",
    );
  }

  await assertSectionMediaOwned(
    businessId,
    plan.pages.flatMap((page) => page.sections),
  );

  return existingPages.map((page) => ({
    _id: page._id,
    status: page.status,
    version: page.version,
  }));
}
