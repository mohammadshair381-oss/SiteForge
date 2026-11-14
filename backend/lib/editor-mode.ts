/**
 * Which editor the website editor opens (pure; tested).
 *
 * - The HOMEPAGE (no page selected, or the page marked `isHome`) opens the
 *   store homepage editor, which edits the commerce homepage with the same
 *   renderer and data as the public storefront.
 * - A homepage that still has classic custom sections (draft or published)
 *   opens the section editor, with an offer to switch; `mode=store` opens the
 *   store homepage editor for it (publishing retires the classic sections).
 * - Every other page opens the section editor.
 */
export interface EditorPageInfo {
  isHome?: boolean;
  status?: string;
  sections?: unknown;
  publishedSections?: unknown;
}

const list = (value: unknown) => (Array.isArray(value) ? value : []);

/**
 * The page the editor works on. `undefined` means the homepage `/` shows when
 * there is no published Home page (lib/storefront-pages.ts), saved in the theme
 * settings. Without `pageId` the editor opens the published Home page or that
 * fallback, never an unrelated page. A draft Home page with sections stays
 * reachable by id; an empty one holds nothing to edit, so it opens the fallback.
 */
export function selectEditorPage<T extends EditorPageInfo & { _id: unknown }>(pages: readonly T[], pageId?: string | null): T | undefined {
  if (!pageId) return pages.find((page) => page.isHome && page.status === "published");
  const page = pages.find((item) => String(item._id) === pageId);
  return page?.isHome && page.status !== "published" && list(page.sections).length === 0 ? undefined : page;
}

export function chooseEditorMode(input: {
  selectedPage: EditorPageInfo | null | undefined;
  legacySections: unknown;
  mode?: string | null;
}): { editingHome: boolean; hasClassicHomepage: boolean; useStoreEditor: boolean } {
  const editingHome = !input.selectedPage || Boolean(input.selectedPage.isHome);
  const homeSections = !editingHome
    ? []
    : !input.selectedPage
      ? list(input.legacySections)
      : [...list(input.selectedPage.sections), ...list(input.selectedPage.publishedSections)];
  const hasClassicHomepage = editingHome && homeSections.length > 0;
  return { editingHome, hasClassicHomepage, useStoreEditor: editingHome && (!hasClassicHomepage || input.mode === "store") };
}
