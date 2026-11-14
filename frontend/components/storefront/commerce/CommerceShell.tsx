import React from "react";
import type { ThemeProps } from "@/themes/types";
import SectionRenderer from "@/components/storefront/SectionRenderer";
import { buildCommerceData } from "@/lib/storefront-home";
import { storeRootProps, type StoreSkin } from "./skins";
import StoreHeader from "./StoreHeader";
import StoreFooter from "./StoreFooter";
import CommerceHome from "./CommerceHome";
import PreviewLinkGuard from "./PreviewLinkGuard";
import MotionRoot from "./MotionRoot";
import MobileDock from "./MobileDock";

/**
 * Page frame shared by every theme: the commerce header, then either the
 * owner's configured sections (pages built in the editor) or the commerce
 * homepage, then the footer (unless a configured footer section exists).
 * `commerce` is built on the server for the public store; editor and preview
 * callers that do not pass it get the same data built from the view alone.
 */
export default function CommerceShell({
  skin,
  view,
  productHrefBase,
  preview,
  editable,
  hasConfiguredFooter,
  sections,
  draggableSections,
  onReorderSections,
  onCommitElementOffset,
  elementOffsetMap,
  selectedElementId,
  commerce: commerceProp,
}: ThemeProps & { skin: StoreSkin }) {
  const commerce = commerceProp ?? buildCommerceData(view, undefined);
  const useSections = Array.isArray(sections) && sections.length > 0;
  const sectionView = useSections ? { ...view, theme: { ...view.theme, sections } } : view;
  const root = storeRootProps(skin, view.theme);

  const page = (
    <div className={`${root.className} ${skin.layout.dock ? "pb-16 md:pb-0" : ""}`} style={root.style} data-theme={view.themeId}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-gray-900">
        Skip to content
      </a>
      <StoreHeader view={view} commerce={commerce} skin={skin} preview={preview} editable={editable} />
      <div className="flex-1">
        {useSections ? (
          <main id="main">
            <SectionRenderer
              insideStoreRoot
              view={sectionView}
              productHrefBase={productHrefBase}
              preview={preview}
              showHeader={false}
              editable={editable}
              selectedElementId={selectedElementId}
              draggableSections={draggableSections}
              onReorderSections={onReorderSections}
              onCommitElementOffset={onCommitElementOffset}
              elementOffsetMap={elementOffsetMap}
            />
          </main>
        ) : (
          <CommerceHome
            view={view}
            commerce={commerce}
            skin={skin}
            productHrefBase={productHrefBase}
            preview={preview}
            editable={editable}
            selectedSectionId={selectedElementId?.startsWith("home:") ? selectedElementId.slice(5) : null}
          />
        )}
      </div>
      {!hasConfiguredFooter && <StoreFooter view={view} commerce={commerce} skin={skin} editable={editable} />}
      {skin.layout.dock && <MobileDock skin={skin} hasProducts={commerce.totalProducts > 0} editable={editable} accountHref={commerce.header.accountsEnabled ? (commerce.header.signedInName || commerce.header.signedInUnverified ? "/account" : "/account/login") : null} />}
      {/* Scroll reveals; never in the editor, where content must stay put. */}
      {!editable && <MotionRoot />}
    </div>
  );

  // Non-editable previews render on the dashboard host, where store links do
  // not exist; the editor already blocks navigation per element.
  return preview && !editable ? <PreviewLinkGuard>{page}</PreviewLinkGuard> : page;
}
