import type { StorefrontView } from "@/lib/storefront";
import { getVisibleSections, type Section } from "@/lib/sections";
import { resolveThemeComponent } from "@/themes/registry";
import type { CommerceData } from "@/lib/storefront-home";

export default function ThemeRenderer({
  view,
  productHrefBase,
  preview,
  editable,
  selectedElementId,
  onSelectElement,
  sections,
  draggableSections,
  onReorderSections,
  onCommitElementOffset,
  elementOffsetMap,
  commerce,
}: {
  view: StorefrontView;
  productHrefBase: string;
  preview?: boolean;
  editable?: boolean;
  selectedElementId?: string | null;
  onSelectElement?: (id: string) => void;
  sections?: Section[];
  draggableSections?: boolean;
  onReorderSections?: (fromId: string, toId: string, position: "before" | "after") => void;
  onCommitElementOffset?: (id: string, x: number, y: number) => void;
  elementOffsetMap?: Record<string, { x: number; y: number }>;
  commerce?: CommerceData;
}) {
  const Theme = resolveThemeComponent(view.themeId);
  const hasConfiguredFooter = getVisibleSections(sections).some((section) => section.type === "footer");
  return (
    // Restores the theme's own colour tokens inside platform pages (display: contents).
    <div className="store-surface">
    <Theme
      view={view}
      productHrefBase={productHrefBase}
      preview={preview}
      editable={editable}
      hasConfiguredFooter={hasConfiguredFooter}
      selectedElementId={selectedElementId}
      onSelectElement={onSelectElement}
      sections={sections}
      draggableSections={draggableSections}
      onReorderSections={onReorderSections}
      onCommitElementOffset={onCommitElementOffset}
      elementOffsetMap={elementOffsetMap}
      commerce={commerce}
    />
    </div>
  );
}
