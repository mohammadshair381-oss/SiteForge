import type { HomeSection, StorefrontConfig } from "@/lib/storefront-config";

/**
 * What an editor window holds that has not been saved, in the owner's words (pure; safe in client
 * components). It only describes the difference: nothing here saves, merges or changes anything. When
 * a draft has moved on elsewhere, this lets the owner see and copy their work before loading the latest.
 */
export interface UnsavedSnapshot {
  config: StorefrontConfig;
  themeId: string;
  font: string;
}

const AREAS: ReadonlyArray<readonly [keyof StorefrontConfig, string]> = [
  ["announcement", "Announcement bar"],
  ["header", "Header"],
  ["hero", "Homepage banner"],
  ["policies", "Policies"],
  ["seo", "Search text"],
  ["footer", "Footer"],
];

/** Settings that are not wording the owner would need to retype. */
const NOT_TEXT = new Set(["id", "type", "imageUrl", "url", "href", "appearance", "responsive", "style", "productIds"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const words = (key: string) => key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
const MAX_LINES = 200;

function changedText(before: unknown, after: unknown, label: string, lines: string[]): void {
  if (lines.length >= MAX_LINES || same(before, after)) return;
  if (typeof after === "string") {
    if (after.trim()) lines.push(`${label}: ${after}`);
    return;
  }
  if (Array.isArray(after)) {
    const was = Array.isArray(before) ? before : [];
    after.forEach((item, index) => changedText(was[index], item, `${label} ${index + 1}`, lines));
    return;
  }
  if (after && typeof after === "object") {
    const was = before && typeof before === "object" ? (before as Record<string, unknown>) : {};
    for (const [key, value] of Object.entries(after)) {
      if (!NOT_TEXT.has(key)) changedText(was[key], value, `${label}, ${words(key)}`, lines);
    }
  }
}

export function unsavedSummary(saved: UnsavedSnapshot, current: UnsavedSnapshot, sectionName: (section: HomeSection) => string): { areas: string[]; text: string } {
  const areas: string[] = [];
  const lines: string[] = [];
  if (saved.themeId !== current.themeId) areas.push("Theme");
  if (saved.font !== current.font) areas.push("Font");
  for (const [key, name] of AREAS) {
    if (same(saved.config[key], current.config[key])) continue;
    areas.push(name);
    changedText(saved.config[key], current.config[key], name, lines);
  }

  const savedSections = new Map(saved.config.sections.map((section) => [section.id, section]));
  const currentIds = new Set(current.config.sections.map((section) => section.id));
  for (const section of current.config.sections) {
    const was = savedSections.get(section.id);
    if (same(was, section)) continue;
    const name = sectionName(section);
    areas.push(was ? name : `${name} (new)`);
    changedText(was, section, name, lines);
  }
  for (const section of saved.config.sections) {
    if (!currentIds.has(section.id)) areas.push(`${sectionName(section)} (removed)`);
  }
  const kept = (list: HomeSection[], other: Set<string>) => list.filter((section) => other.has(section.id)).map((section) => section.id);
  if (!same(kept(saved.config.sections, currentIds), kept(current.config.sections, new Set(savedSections.keys())))) areas.push("Section order");

  return { areas: [...new Set(areas)], text: lines.join("\n") };
}
