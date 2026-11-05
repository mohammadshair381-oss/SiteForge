"use client";

import { editorFocus } from "./EditorWorkspace";
import { AddSectionMenu, SectionRow, SectionSwitch, useSectionDrag, type DropPosition } from "./SectionControls";
import {
  HOME_BLOCK_TYPES,
  HOME_SECTION_DESCRIPTIONS,
  HOME_SECTION_LABELS,
  HOME_SECTION_TYPES,
  MAX_HOME_SECTIONS,
  SINGLE_INSTANCE_TYPES,
  homeSectionName,
  type HomeSection,
  type HomeSectionType,
  type StorefrontConfig,
} from "@/lib/storefront-config";
import { SECTION_TYPE_DESCRIPTIONS, SECTION_TYPE_LABELS, type SectionType } from "@/lib/sections";

/** What a navigator row represents: a fixed part of the page or a section id. */
export type HomeSelection = "announcement" | "header" | "hero" | "footer" | "seo" | string;

/**
 * Layer list of the homepage: announcement bar, header, hero, every section
 * in order, footer. Selecting a row opens its settings; sections can be
 * shown/hidden, moved, dragged, removed and added here (each change is one
 * undoable step).
 */
export default function HomeSectionNavigator({
  config,
  selected,
  hiddenReasons,
  onSelect,
  onToggleSection,
  onToggleHero,
  onMove,
  onReorder,
  onRemove,
  onAdd,
  onBrowseLibrary,
}: {
  config: StorefrontConfig;
  selected: HomeSelection | null;
  hiddenReasons: Map<string, string>;
  onSelect: (selection: HomeSelection) => void;
  onToggleSection: (id: string, enabled: boolean) => void;
  onToggleHero: (enabled: boolean) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReorder: (fromId: string, toId: string, position: DropPosition) => void;
  onRemove: (section: HomeSection) => void;
  onAdd: (type: HomeSectionType, blockType?: SectionType) => void;
  onBrowseLibrary: () => void;
}) {
  const drag = useSectionDrag(onReorder);
  const present = new Set(config.sections.map((s) => s.type));
  const full = config.sections.length >= MAX_HOME_SECTIONS;

  const row = (key: HomeSelection, title: string, detail: string, extra?: React.ReactNode, muted = false) => (
    <li key={key}>
      <div
        className={`flex items-center gap-1.5 rounded-lg border py-1 pl-2.5 pr-1 transition-colors ${selected === key ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300"}`}
      >
        <button type="button" onClick={() => onSelect(key)} aria-current={selected === key ? "true" : undefined} className={`min-h-10 min-w-0 flex-1 rounded py-0.5 text-left lg:min-h-8 ${editorFocus}`}>
          <span className={`block truncate text-sm font-medium ${muted ? "text-slate-500" : "text-slate-900"}`}>{title}</span>
          <span className="block truncate text-xs text-slate-500">{detail}</span>
        </button>
        {extra}
      </div>
    </li>
  );

  const groupLabel = (text: string) => (
    <li aria-hidden="true" className="pb-0.5 pt-2 text-xs font-medium text-slate-500 first:pt-0">
      {text}
    </li>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-slate-500">Select a part of the page to edit it, or click it in the preview. Everything here changes your draft only.</p>
      <ol className="space-y-1.5" aria-label="Homepage sections">
        {groupLabel("Top of the page")}
        {row("announcement", "Announcement bar", config.announcement.enabled && config.announcement.text ? config.announcement.text : "Off", undefined, !config.announcement.enabled)}
        {row("header", "Header", "Logo, menu, search, account and cart")}
        {row(
          "hero",
          "Hero banner",
          config.hero.enabled ? config.hero.headline || "Uses your store name" : "Hidden",
          <SectionSwitch checked={config.hero.enabled} label="Show hero banner" onChange={onToggleHero} />,
          !config.hero.enabled,
        )}
        {groupLabel(`Sections (${config.sections.length})`)}
        {config.sections.length === 0 && (
          <li className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-center text-xs text-slate-500">No sections yet. Add the first one below.</li>
        )}
        {config.sections.map((section, index) => {
          const reason = section.enabled ? hiddenReasons.get(section.id) : undefined;
          return (
            <SectionRow
              key={section.id}
              id={section.id}
              name={homeSectionName(section)}
              detail={!section.enabled ? "Hidden" : reason ? `Not shown yet: ${reason}` : section.type === "block" ? SECTION_TYPE_LABELS[section.block.type] : HOME_SECTION_LABELS[section.type]}
              muted={!section.enabled}
              selected={selected === section.id}
              isFirst={index === 0}
              isLast={index === config.sections.length - 1}
              visible={section.enabled}
              drag={drag}
              onSelect={() => onSelect(section.id)}
              onMove={(direction) => onMove(section.id, direction)}
              onToggle={(enabled) => onToggleSection(section.id, enabled)}
              onRemove={() => onRemove(section)}
            />
          );
        })}
        {groupLabel("Bottom of the page")}
        {row("footer", "Footer", config.footer.about ? "Custom description" : "Business details, links and social profiles")}
        {groupLabel("Page settings")}
        {row("seo", "Search and sharing", config.seo?.title || "Title, description and picture")}
      </ol>

      <AddSectionMenu
        options={[
          ...HOME_SECTION_TYPES.map((type) => ({
            key: type as string,
            label: type === "featured" ? "Product collection" : HOME_SECTION_LABELS[type],
            description: HOME_SECTION_DESCRIPTIONS[type],
            blockedNote: SINGLE_INSTANCE_TYPES.includes(type) && present.has(type) ? "already on the page" : undefined,
          })),
          ...HOME_BLOCK_TYPES.map((type) => ({
            key: `block:${type}`,
            label: SECTION_TYPE_LABELS[type],
            description: SECTION_TYPE_DESCRIPTIONS[type],
            blockedNote: undefined,
          })),
        ]}
        disabled={full}
        disabledNote={`A homepage can have up to ${MAX_HOME_SECTIONS} sections.`}
        onAdd={(key) => (key.startsWith("block:") ? onAdd("block", key.slice(6) as SectionType) : onAdd(key as HomeSectionType))}
      >
        <button type="button" disabled={full} onClick={onBrowseLibrary} className={`mt-1.5 flex min-h-10 w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50 ${editorFocus}`}>
          Browse ready-made sections
        </button>
      </AddSectionMenu>
    </div>
  );
}
