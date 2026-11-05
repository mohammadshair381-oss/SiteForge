import type { ClientSession } from "mongoose";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { liveDesign } from "@/lib/design-service";
import { designDraftSchema, readDesignDraft } from "@/lib/design-settings";
import type { StoredNavItem, StoredNavigation } from "@/lib/navigation";
import { getVisibleSections, resolvePublishedPageSections, sectionsArraySchema, type Section } from "@/lib/sections";
import { readStorefrontConfig } from "@/lib/storefront-config";
import { Business } from "@/models/Business";
import { Page, type PageDoc } from "@/models/Page";
import type { ClassicHomepage, WebsiteBase, WebsiteNavItem, WebsiteNavigation, WebsitePage, WebsiteState } from "./blueprint";

/**
 * A store's current DRAFT website, in the form proposals compare against (server-only). Callers
 * authorize first. Published copies are never read here: nothing in this workflow can change them.
 */
export interface LoadedWebsite {
  state: WebsiteState;
  base: WebsiteBase;
  business: { name: string; category: string; themeId: string; status: string };
  /** Page ids whose stored sections no longer parse: readable elsewhere, but not changed from here. */
  lockedPageIds: string[];
  /** The older custom homepage visitors see instead of the homepage settings, if any. */
  classicHomepage: ClassicHomepage | null;
}

function toWebsiteNav(items: StoredNavItem[] | undefined, slugOf: ReadonlyMap<string, string>): WebsiteNavItem[] {
  return [...(items ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .flatMap((item, order): WebsiteNavItem[] => {
      const children = item.children ? toWebsiteNav(item.children, slugOf).map(({ children: _nested, ...child }) => child) : undefined;
      const common = { label: item.label, order, ...(item.showOn ? { showOn: item.showOn } : {}), ...(children && children.length > 0 ? { children } : {}) };
      if (item.pageId) {
        const slug = slugOf.get(item.pageId);
        return slug ? [{ ...common, pageSlug: slug }] : [];
      }
      return [{ ...common, ...(item.href ? { href: item.href } : {}) }];
    });
}

export function storedNavigationFrom(navigation: WebsiteNavigation, idOf: ReadonlyMap<string, string>): StoredNavigation {
  const convert = (items: WebsiteNavItem[]): StoredNavItem[] =>
    items.flatMap((item, order): StoredNavItem[] => {
      const children = item.children ? convert(item.children) : undefined;
      const common = { label: item.label, order, ...(item.showOn ? { showOn: item.showOn } : {}), ...(children && children.length > 0 ? { children } : {}) };
      if (item.pageSlug) {
        const pageId = idOf.get(item.pageSlug);
        return pageId ? [{ ...common, pageId }] : [];
      }
      return [{ ...common, ...(item.href ? { href: item.href } : {}) }];
    });
  return { header: convert(navigation.header), footer: convert(navigation.footer) };
}

export async function loadWebsiteState(businessId: string, session?: ClientSession): Promise<LoadedWebsite> {
  await dbConnect();
  const business = await Business.findById(businessId)
    .select("name category themeId status themeSettings storefrontDraftVersion designDraftVersion navigationDraftVersion")
    .session(session ?? null)
    .lean<{ name: string; category: string; themeId: string; status: string; themeSettings?: Record<string, unknown>; storefrontDraftVersion?: number; designDraftVersion?: number; navigationDraftVersion?: number }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const docs = await Page.find({ business: businessId }).sort({ isHome: -1, createdAt: 1 }).session(session ?? null).lean<PageDoc[]>();

  const settings = business.themeSettings ?? {};
  const config = readStorefrontConfig(settings.storefront, business.category);
  const design = designDraftSchema.parse(readDesignDraft(settings.designDraft) ?? liveDesign(business));

  const lockedPageIds: string[] = [];
  const pages: WebsitePage[] = docs.map((doc) => {
    const parsed = sectionsArraySchema.safeParse(doc.sections ?? []);
    if (!parsed.success) lockedPageIds.push(String(doc._id));
    return {
      id: String(doc._id),
      title: doc.title,
      slug: doc.slug,
      status: doc.status === "published" ? "published" : "draft",
      isHome: Boolean(doc.isHome),
      version: doc.version ?? 0,
      description: doc.description ?? "",
      seoTitle: doc.seoTitle ?? "",
      seoDescription: doc.seoDescription ?? "",
      seoImage: doc.seoImage ?? "",
      sections: parsed.success ? (parsed.data as Section[]) : [],
    };
  });

  const slugOf = new Map(pages.map((page) => [page.id as string, page.slug]));
  const stored = (settings.navigation ?? {}) as StoredNavigation;
  const navigation: WebsiteNavigation = { header: toWebsiteNav(stored.header, slugOf), footer: toWebsiteNav(stored.footer, slugOf) };

  // The same rule as the public store (lib/storefront-pages.ts): a published Home page with visible
  // sections, or without one, sections kept in the settings. Otherwise `/` is the homepage settings.
  const homeDoc = docs.find((doc) => doc.isHome && doc.status === "published");
  const liveSections = getVisibleSections(homeDoc ? resolvePublishedPageSections(homeDoc) : settings.sections);
  const classicHomepage: ClassicHomepage | null = liveSections.length > 0 ? { kind: homeDoc ? "page" : "legacy", title: homeDoc?.title ?? "Your homepage", sections: liveSections } : null;

  return {
    state: { design, config, navigation, pages },
    base: {
      storefrontVersion: business.storefrontDraftVersion ?? 0,
      designVersion: business.designDraftVersion ?? 0,
      navigationVersion: business.navigationDraftVersion ?? 0,
      pageVersions: pages.map((page) => ({ pageId: page.id as string, version: page.version })),
    },
    business: { name: business.name, category: business.category, themeId: business.themeId, status: business.status },
    lockedPageIds,
    classicHomepage,
  };
}
