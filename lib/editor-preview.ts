import type { ThemeSettings } from "@/models/Business";
import { resolveNavItems } from "@/lib/navigation";
import type { StorefrontNavigation } from "@/lib/storefront";

export interface EditorPreviewPage {
  _id: string;
  title: string;
  slug: string;
  status: string;
}

/** Menus as the editor shows them: unpublished pages included, so links can be checked. */
export function resolveEditorNavigation(
  navigation: ThemeSettings["navigation"],
  pages: EditorPreviewPage[],
): StorefrontNavigation | undefined {
  if (!navigation) return undefined;
  const pageMap = new Map(pages.map((page) => [page._id, { title: page.title, slug: page.slug, status: page.status }]));
  const header = resolveNavItems(navigation.header, pageMap, { publishedOnly: false });
  const footer = resolveNavItems(navigation.footer, pageMap, { publishedOnly: false });
  return header.length === 0 && footer.length === 0 ? undefined : { header, footer };
}
