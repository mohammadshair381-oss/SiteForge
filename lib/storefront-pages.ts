import type { Types } from "mongoose";
import { dbConnect } from "./db";
import { getVisibleSections, resolvePublishedPageSections, type Section } from "./sections";
import { Page } from "@/models/Page";

/**
 * Server-only: decides what the public storefront renders for a path, using
 * published data only. Kept separate from `lib/storefront.ts` and
 * `lib/sections.ts`, which client components import.
 *
 * - `legacy-business`: `/` has no published Home page (no Page documents yet, or
 *   Home is still a draft or missing); the homepage renders from business theme
 *   settings, which is the commerce homepage when they hold no sections. `/`
 *   never 404s on a store that is otherwise public.
 * - `not-found`: no published page for this path (never for `/`).
 * - `page`: the visible sections of the page's PUBLISHED content (see
 *   `resolvePublishedPageSections`); an empty list renders the theme default.
 */
export type StorefrontPageResolution =
  | { kind: "legacy-business" }
  | { kind: "not-found" }
  | { kind: "page"; title: string; sections: Section[] };

/** Where an old address of a published page now lives, or null. Scoped to this store. */
export async function findPageRedirect(businessId: Types.ObjectId | string, oldSlug: string): Promise<string | null> {
  await dbConnect();
  const page = await Page.findOne({ business: businessId, previousSlugs: oldSlug, status: "published" }).select("slug").lean();
  return page ? `/${page.slug}` : null;
}

export async function resolveStorefrontPage(
  businessId: Types.ObjectId | string,
  pageSlug: string | null,
): Promise<StorefrontPageResolution> {
  await dbConnect();

  // `.lean()` keeps an absent `publishedSections` field as `undefined`, which
  // is how legacy records are told apart from published-but-empty pages.
  const page = await Page.findOne(
    pageSlug
      ? { business: businessId, slug: pageSlug, status: "published" }
      : { business: businessId, isHome: true, status: "published" },
  )
    .select("title sections publishedSections")
    .lean();
  if (!page) return pageSlug ? { kind: "not-found" } : { kind: "legacy-business" };

  return { kind: "page", title: page.title, sections: getVisibleSections(resolvePublishedPageSections(page)) };
}
