import { isSafeSectionHref } from "./sections";

/**
 * Header and footer menus (pure; safe in client components).
 *
 * A stored item points at one of the store's pages (`pageId`), or at any other
 * address (`href`): the catalog, a category, a product or an external https site.
 * One level of `children` makes a dropdown. A page link appears only while its
 * page is published; an item whose page is gone disappears with no broken link.
 */
export interface StoredNavItem {
  pageId?: string;
  href?: string;
  label: string;
  order: number;
  /** Only on larger screens, or only in the phone menu. Absent = everywhere. */
  showOn?: "desktop" | "mobile";
  children?: StoredNavItem[];
}

export interface StoredNavigation {
  header?: StoredNavItem[];
  footer?: StoredNavItem[];
}

export interface ResolvedNavItem {
  pageId: string;
  label: string;
  /** The page's address without the slash; empty for other links. */
  slug: string;
  /** Where the link goes; a page link without one goes to its slug. */
  href?: string;
  external?: boolean;
  showOn?: "desktop" | "mobile";
  children?: ResolvedNavItem[];
}

export interface NavPageInfo {
  title: string;
  slug: string;
  status: string;
}

function resolveOne(item: StoredNavItem, pages: ReadonlyMap<string, NavPageInfo>, publishedOnly: boolean): ResolvedNavItem | null {
  const children = (item.children ?? [])
    .map((child) => resolveOne(child, pages, publishedOnly))
    .filter((child): child is ResolvedNavItem => child !== null);
  const extra = { ...(children.length > 0 ? { children } : {}), ...(item.showOn ? { showOn: item.showOn } : {}) };
  if (item.pageId) {
    const page = pages.get(item.pageId);
    if (!page || (publishedOnly && page.status !== "published")) return null;
    return { pageId: item.pageId, label: item.label || page.title, slug: page.slug, href: `/${page.slug}`, ...extra };
  }
  if (item.href && isSafeSectionHref(item.href)) {
    return { pageId: "", label: item.label, slug: "", href: item.href, ...(/^https:/i.test(item.href) ? { external: true } : {}), ...extra };
  }
  // A heading with only a dropdown under it.
  return children.length > 0 && item.label ? { pageId: "", label: item.label, slug: "", href: "#", ...extra } : null;
}

export function resolveNavItems(items: StoredNavItem[] | undefined, pages: ReadonlyMap<string, NavPageInfo>, options: { publishedOnly: boolean }): ResolvedNavItem[] {
  return [...(items ?? [])]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((item) => resolveOne(item, pages, options.publishedOnly))
    .filter((item): item is ResolvedNavItem => item !== null);
}

/** Every page id a menu refers to, dropdowns included. */
export function navigationPageIds(navigation: StoredNavigation): string[] {
  const ids = new Set<string>();
  const walk = (items: StoredNavItem[] | undefined) => {
    for (const item of items ?? []) {
      if (item.pageId) ids.add(item.pageId);
      walk(item.children);
    }
  };
  walk(navigation.header);
  walk(navigation.footer);
  return [...ids];
}
