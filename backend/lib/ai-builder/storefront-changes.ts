import { z } from "zod";
import {
  HOME_SECTION_ID_PATTERN,
  HOME_SECTION_LABELS,
  HOME_SECTION_TYPES,
  MAX_HOME_SECTIONS,
  SINGLE_INSTANCE_TYPES,
  createHomeSection,
  internalHrefSchema,
  storefrontConfigSchema,
  type HomeSection,
  type StorefrontConfig,
} from "@/lib/storefront-config";

/**
 * Store homepage change sets (pure; no I/O). A change set is STRUCTURED DATA
 * that can only express what the storefront editor itself supports: hero and
 * announcement text, homepage sections (add, remove, reorder, show/hide,
 * headings, appearance, limits, story text), footer text and the store's brand
 * colours/font. It can never carry HTML, scripts, images, product choices or
 * arbitrary fields (every object is strict), and every result is validated
 * against the storefront schema again before anyone sees it.
 *
 * The same engine serves AI suggestions and any other source: where a change
 * set comes from never changes what it may do.
 */

const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const text = (max: number) => z.string().trim().max(max).refine(noHtml, "HTML is not supported");
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #111827")
  .transform((v) => v.toLowerCase());
const cta = z.object({ label: text(40), href: internalHrefSchema }).strict();
const sectionId = z.string().regex(HOME_SECTION_ID_PATTERN, "Unknown section");
const nonEmpty = (value: object) => Object.keys(value).length > 0;
export const FONTS = ["sans", "serif", "mono"] as const;

export const storefrontChangeSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("hero"),
      set: z
        .object({
          enabled: z.boolean(),
          eyebrow: text(60),
          headline: text(120),
          description: text(300),
          align: z.enum(["left", "center"]),
          overlay: z.number().int().min(0).max(80),
          primaryCta: cta,
          secondaryCta: cta,
        })
        .partial()
        .strict()
        .refine(nonEmpty, "Nothing to change"),
    })
    .strict(),
  z
    .object({
      op: z.literal("announcement"),
      set: z.object({ enabled: z.boolean(), text: text(140), href: internalHrefSchema }).partial().strict().refine(nonEmpty, "Nothing to change"),
    })
    .strict(),
  z
    .object({
      op: z.literal("section"),
      sectionId,
      set: z
        .object({
          enabled: z.boolean(),
          title: text(80),
          subtitle: text(160),
          appearance: z
            .object({ background: z.enum(["default", "alt", "accent"]), spacing: z.enum(["compact", "normal", "spacious"]), align: z.enum(["left", "center"]) })
            .partial()
            .strict()
            .refine(nonEmpty, "Nothing to change"),
          limit: z.number().int().min(2).max(24),
          text: text(2000),
        })
        .partial()
        .strict()
        .refine(nonEmpty, "Nothing to change"),
    })
    .strict(),
  z.object({ op: z.literal("move"), sectionId, toIndex: z.number().int().min(0).max(MAX_HOME_SECTIONS - 1) }).strict(),
  z
    .object({
      op: z.literal("add"),
      sectionType: z.enum(HOME_SECTION_TYPES),
      index: z.number().int().min(0).max(MAX_HOME_SECTIONS),
      title: text(80).optional(),
      subtitle: text(160).optional(),
    })
    .strict(),
  z.object({ op: z.literal("remove"), sectionId }).strict(),
  z
    .object({
      op: z.literal("brand"),
      set: z.object({ primaryColor: hex, accentColor: hex, font: z.enum(FONTS) }).partial().strict().refine(nonEmpty, "Nothing to change"),
    })
    .strict(),
  z.object({ op: z.literal("footer"), set: z.object({ about: text(400) }).strict() }).strict(),
]);
export type StorefrontChange = z.infer<typeof storefrontChangeSchema>;

/** What a suggestion returns: a summary, the changes, and notes for the owner. */
export const storefrontChangeSetSchema = z
  .object({
    summary: text(280).pipe(z.string().min(1, "A summary is required")),
    changes: z.array(storefrontChangeSchema).max(20),
    notes: z.array(text(200)).max(5).prefault([]),
  })
  .strict();
export type StorefrontChangeSet = z.infer<typeof storefrontChangeSetSchema>;

/** The store-wide look a proposal may change (business theme settings). */
export interface BrandState {
  primaryColor: string;
  accentColor: string;
  font: (typeof FONTS)[number];
}

export interface StorefrontDiffEntry {
  area: "hero" | "announcement" | "section" | "layout" | "brand" | "footer";
  /** What changed, in owner words ("Hero headline", "New arrivals: heading"). */
  label: string;
  before: string;
  after: string;
  /** Store-wide once published: goes to the design draft when the proposal is applied (brand). */
  live: boolean;
}

export class StorefrontChangeError extends Error {
  constructor(
    public code: "unknown_section" | "unsupported_field" | "section_exists" | "too_many_sections" | "invalid_position" | "no_changes" | "invalid_result",
    message: string,
  ) {
    super(message);
    this.name = "StorefrontChangeError";
  }
}

const sectionName = (s: HomeSection) => s.title || HOME_SECTION_LABELS[s.type];
const show = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "Shown" : "Hidden";
  if (value && typeof value === "object") {
    const v = value as { label?: string; href?: string };
    return v.label || v.href ? `${v.label || "(no label)"} → ${v.href || "(no link)"}` : "(none)";
  }
  return value === "" || value === undefined || value === null ? "(empty)" : String(value);
};
const HERO_LABELS: Record<string, string> = {
  enabled: "Hero banner",
  eyebrow: "Hero small heading",
  headline: "Hero headline",
  description: "Hero description",
  align: "Hero alignment",
  overlay: "Hero image darkening",
  primaryCta: "Hero main button",
  secondaryCta: "Hero second button",
};

/**
 * Applies a change set to the current draft homepage and brand. Returns the
 * resulting (schema-valid) config and brand plus a reviewable diff, or throws
 * StorefrontChangeError. The inputs are never mutated.
 */
export function applyStorefrontChanges(
  base: StorefrontConfig,
  baseBrand: BrandState,
  changes: StorefrontChange[],
): { config: StorefrontConfig; brand: BrandState; diff: StorefrontDiffEntry[] } {
  const config = structuredClone(base);
  const brand = { ...baseBrand };
  const diff: StorefrontDiffEntry[] = [];
  const record = (area: StorefrontDiffEntry["area"], label: string, before: unknown, after: unknown, live = false) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) diff.push({ area, label, before: show(before), after: show(after), live });
  };
  const find = (id: string) => {
    const index = config.sections.findIndex((s) => s.id === id);
    if (index < 0) throw new StorefrontChangeError("unknown_section", `There is no homepage section "${id}".`);
    return index;
  };

  for (const change of changes) {
    switch (change.op) {
      case "hero":
        for (const [key, value] of Object.entries(change.set)) {
          const hero = config.hero as Record<string, unknown>;
          record("hero", HERO_LABELS[key] ?? key, hero[key], value);
          hero[key] = value;
        }
        break;
      case "announcement":
        for (const [key, value] of Object.entries(change.set)) {
          const announcement = config.announcement as Record<string, unknown>;
          record("announcement", key === "enabled" ? "Announcement bar" : key === "text" ? "Announcement text" : "Announcement link", announcement[key], value);
          announcement[key] = value;
        }
        break;
      case "section": {
        const section = config.sections[find(change.sectionId)] as HomeSection & Record<string, unknown>;
        const name = sectionName(section);
        const { appearance, ...fields } = change.set;
        for (const [key, value] of Object.entries(fields)) {
          if (key === "limit" && !("limit" in section)) throw new StorefrontChangeError("unsupported_field", `${name} has no product limit.`);
          if (key === "limit" && section.type === "categories" && (value as number) > 12) throw new StorefrontChangeError("unsupported_field", `${name} shows at most 12 categories.`);
          if (key === "text" && section.type !== "story") throw new StorefrontChangeError("unsupported_field", `Only the story section has body text.`);
          const label = key === "enabled" ? `${name}: visibility` : key === "title" ? `${name}: heading` : key === "subtitle" ? `${name}: small heading` : key === "limit" ? `${name}: number of items` : `${name}: text`;
          record("section", label, section[key], value);
          section[key] = value;
        }
        if (appearance) {
          for (const [key, value] of Object.entries(appearance)) {
            const current = section.appearance as Record<string, unknown>;
            record("section", `${name}: ${key === "background" ? "background" : key === "spacing" ? "spacing" : "heading alignment"}`, current[key], value);
            current[key] = value;
          }
        }
        break;
      }
      case "move": {
        const from = find(change.sectionId);
        if (change.toIndex >= config.sections.length) throw new StorefrontChangeError("invalid_position", "That position is past the end of the homepage.");
        if (from !== change.toIndex) {
          const [moved] = config.sections.splice(from, 1);
          config.sections.splice(change.toIndex, 0, moved);
          record("layout", `${sectionName(moved)}: position`, `${from + 1} of ${config.sections.length}`, `${change.toIndex + 1} of ${config.sections.length}`);
        }
        break;
      }
      case "add": {
        if (SINGLE_INSTANCE_TYPES.includes(change.sectionType) && config.sections.some((s) => s.type === change.sectionType)) {
          throw new StorefrontChangeError("section_exists", `The homepage already has a ${HOME_SECTION_LABELS[change.sectionType]} section.`);
        }
        if (config.sections.length >= MAX_HOME_SECTIONS) throw new StorefrontChangeError("too_many_sections", `A homepage can have at most ${MAX_HOME_SECTIONS} sections.`);
        const created = createHomeSection(change.sectionType, config.sections);
        if (change.title !== undefined) created.title = change.title;
        if (change.subtitle !== undefined) created.subtitle = change.subtitle;
        const at = Math.min(change.index, config.sections.length);
        config.sections.splice(at, 0, created);
        diff.push({ area: "layout", label: `New section: ${sectionName(created)}`, before: "(none)", after: `Added at position ${at + 1}`, live: false });
        break;
      }
      case "remove": {
        const [removed] = config.sections.splice(find(change.sectionId), 1);
        diff.push({ area: "layout", label: `Section removed: ${sectionName(removed)}`, before: "Shown on the homepage", after: "(removed)", live: false });
        break;
      }
      case "brand":
        for (const [key, raw] of Object.entries(change.set) as Array<[keyof BrandState, string]>) {
          const value = key === "font" ? raw : raw.toLowerCase();
          record("brand", key === "primaryColor" ? "Primary colour" : key === "accentColor" ? "Accent colour" : "Font", brand[key], value, true);
          (brand as Record<string, string>)[key] = value;
        }
        break;
      case "footer":
        record("footer", "Footer description", config.footer.about, change.set.about);
        config.footer.about = change.set.about;
        break;
    }
  }

  if (diff.length === 0) throw new StorefrontChangeError("no_changes", "These suggestions would not change anything.");
  const parsed = storefrontConfigSchema.safeParse(config);
  if (!parsed.success) throw new StorefrontChangeError("invalid_result", "These changes do not produce a valid homepage.");
  return { config: { ...parsed.data, sections: parsed.data.sections ?? config.sections } as StorefrontConfig, brand, diff };
}

/** Every piece of text a change set would put on the store (for the claims check). */
export function changeSetTexts(changes: StorefrontChange[]): string[] {
  const out: string[] = [];
  for (const change of changes) {
    if (change.op === "hero") {
      const s = change.set;
      out.push(s.eyebrow ?? "", s.headline ?? "", s.description ?? "", s.primaryCta?.label ?? "", s.secondaryCta?.label ?? "");
    } else if (change.op === "announcement") out.push(change.set.text ?? "");
    else if (change.op === "section") out.push(change.set.title ?? "", change.set.subtitle ?? "", change.set.text ?? "");
    else if (change.op === "add") out.push(change.title ?? "", change.subtitle ?? "");
    else if (change.op === "footer") out.push(change.set.about);
  }
  return out.filter((t) => t.trim().length > 0);
}
