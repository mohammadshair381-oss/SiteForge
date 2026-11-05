import type { StorefrontView } from "@/lib/storefront";
import type { Section } from "@/lib/sections";
import type { CommerceData } from "@/lib/storefront-home";

export interface ThemeProps {
  view: StorefrontView;
  productHrefBase: string;
  preview?: boolean;
  editable?: boolean;
  hasConfiguredFooter?: boolean;
  selectedElementId?: string | null;
  onSelectElement?: (id: string) => void;
  sections?: Section[];
  draggableSections?: boolean;
  onReorderSections?: (fromId: string, toId: string, position: "before" | "after") => void;
  onCommitElementOffset?: (id: string, x: number, y: number) => void;
  elementOffsetMap?: Record<string, { x: number; y: number }>;
  /** Homepage, header and footer data built from published store data (public store). */
  commerce?: CommerceData;
}
