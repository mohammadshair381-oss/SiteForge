import { z } from "zod";
import { sectionSchema, type Section, type SectionType } from "@/lib/sections";
import { RESERVED_PAGE_SLUGS, normalizePageSlug } from "@/lib/validation";
import { PLACEHOLDER_PATTERN } from "@/lib/page-presets";
import type { EditingAction } from "@/lib/ai-planning/actions";
import type { WebsitePlan } from "@/lib/ai-planning/plan";

/**
 * AI page builder (pure; no I/O). Turns a validated AI answer into the
 * EXISTING editing actions (lib/ai-planning/actions.ts), so the page change
 * goes through the same proposal lifecycle as every other page change:
 * pending -> owner approval -> applied to DRAFT pages -> separate publish.
 *
 * The AI may only write TEXT into the section types listed here, in the
 * section's own fields. It can never set images, media, testimonials,
 * ratings, statistics or prices, never write contact details (the contact
 * section is filled from the business's own settings, here, on the server),
 * and may link only to the store's own pages. Unknown facts must be written
 * as visible [[placeholders]], which block publishing until replaced.
 */

const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const text = (max: number) => z.string().trim().max(max).refine(noHtml, "HTML is not supported");
const required = (max: number) => text(max).pipe(z.string().min(1));
/** A store path ("/products", "/about"); validated against the allowed links when used. */
const link = z.string().trim().max(200).refine((v) => v === "" || /^\/(?!\/)[A-Za-z0-9\-._~/?=&%+#]*$/.test(v), "Use a store link");

const featureItems = z.array(z.object({ title: required(80), description: text(240) }).strict()).min(1).max(8);
const faqItems = z.array(z.object({ question: required(200), answer: required(2000) }).strict()).min(1).max(12);

/** The section types (and fields) the AI may write. */
export const aiSectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hero"), headline: required(160), subheadline: text(240).optional(), ctaText: text(60).optional(), ctaHref: link.optional() }).strict(),
  z.object({ type: z.literal("about"), title: text(80).optional(), body: required(4000) }).strict(),
  z.object({ type: z.literal("features"), title: text(80).optional(), items: featureItems }).strict(),
  z.object({ type: z.literal("faq"), title: text(80).optional(), items: faqItems }).strict(),
  z.object({ type: z.literal("cta"), headline: required(160), buttonText: text(60).optional(), buttonHref: link.optional() }).strict(),
  z.object({ type: z.literal("contact"), title: text(80).optional(), description: text(500).optional() }).strict(),
  z
    .object({ type: z.literal("products"), title: text(80).optional(), category: text(80).optional(), collection: z.enum(["all", "new", "sale"]).optional(), limit: z.number().int().min(1).max(48).optional() })
    .strict(),
]);
export type AiSection = z.infer<typeof aiSectionSchema>;
export const AI_SECTION_TYPES = ["hero", "about", "features", "faq", "cta", "contact", "products"] as const satisfies readonly SectionType[];

const notes = z.array(text(200)).max(5).prefault([]);

/** A new page. */
export const aiNewPageSchema = z
  .object({
    summary: required(280),
    title: required(80),
    sections: z.array(aiSectionSchema).min(1).max(8),
    notes,
  })
  .strict();
export type AiNewPage = z.infer<typeof aiNewPageSchema>;

/** Text fields an update may change, per section type (the section's own field names). */
const EDITABLE_FIELDS: Partial<Record<SectionType, readonly string[]>> = {
  hero: ["headline", "subheadline", "ctaText"],
  about: ["title", "body"],
  features: ["title", "items"],
  faq: ["title", "items"],
  cta: ["headline", "buttonText"],
  contact: ["title", "description"],
  products: ["title", "category", "collection", "limit"],
  footer: ["text"],
  richText: ["title", "body"],
  imageText: ["title", "body", "ctaText"],
  steps: ["title", "items"],
  newsletter: ["headline", "description", "buttonText"],
  video: ["title", "caption"],
  gallery: ["title"],
  logos: ["title"],
  team: ["title"],
  pricing: ["title"],
  stats: ["title"],
  reviews: ["title"],
};

/** Each section's own schema then applies its own, possibly shorter, limits. */
const stepItems = z.array(z.object({ title: required(160), description: text(600).optional() }).strict()).min(1).max(12);

export const aiSectionUpdateSet = z
  .object({
    title: text(160),
    body: text(8000),
    caption: text(240),
    headline: text(160),
    subheadline: text(240),
    ctaText: text(60),
    buttonText: text(60),
    description: text(500),
    text: text(240),
    items: z.union([faqItems, featureItems, stepItems]),
    category: text(80),
    collection: z.enum(["all", "new", "sale"]),
    limit: z.number().int().min(1).max(48),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

const sectionRef = z.string().trim().min(1).max(64);

/** Changes to an existing page. */
export const aiPageEditSchema = z
  .object({
    summary: required(280),
    changes: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("update"), sectionId: sectionRef, set: aiSectionUpdateSet }).strict(),
          z.object({ op: z.literal("add"), index: z.number().int().min(0).max(49), section: aiSectionSchema }).strict(),
          z.object({ op: z.literal("remove"), sectionId: sectionRef }).strict(),
          z.object({ op: z.literal("move"), sectionId: sectionRef, toIndex: z.number().int().min(0).max(49) }).strict(),
        ]),
      )
      .max(12),
    notes,
  })
  .strict();
export type AiPageEdit = z.infer<typeof aiPageEditSchema>;

export class PageBuildError extends Error {
  constructor(
    public code: "unknown_section" | "unsupported_field" | "unknown_category" | "invalid_result" | "no_changes" | "slug_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PageBuildError";
  }
}

export interface PageBuildContext {
  /** The business's own contact details (never written by the AI). */
  contact: { email: string; phone: string; address: string };
  /** Real product category names (case-insensitive match; stored as written). */
  categories: string[];
  /** Store paths a button may link to. */
  links: string[];
}

function canonicalCategory(name: string | undefined, ctx: PageBuildContext): string | undefined {
  if (!name) return undefined;
  const found = ctx.categories.find((c) => c.trim().toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new PageBuildError("unknown_category", `"${name}" is not one of your product categories.`);
  return found;
}

const allowedLink = (href: string | undefined, ctx: PageBuildContext) => (href && ctx.links.includes(href.split("#")[0]) ? href : undefined);

/** One AI section as a CMS section (validated by the CMS schema). */
export function toSection(ai: AiSection, id: string, order: number, ctx: PageBuildContext): Section {
  let settings: Record<string, unknown>;
  switch (ai.type) {
    case "hero":
      settings = { headline: ai.headline, subheadline: ai.subheadline, ctaText: ai.ctaText, ctaHref: allowedLink(ai.ctaHref, ctx) };
      if (!settings.ctaHref) delete settings.ctaText;
      break;
    case "about":
      settings = { title: ai.title, body: ai.body };
      break;
    case "features":
      settings = { title: ai.title, items: ai.items };
      break;
    case "faq":
      settings = { title: ai.title, items: ai.items };
      break;
    case "cta":
      settings = { headline: ai.headline, buttonText: ai.buttonText, buttonHref: allowedLink(ai.buttonHref, ctx) ?? "/products" };
      break;
    case "contact": {
      // Contact details come ONLY from the business settings.
      const { email, phone, address } = ctx.contact;
      const known = Boolean(email || phone || address);
      settings = {
        title: ai.title,
        description: known ? ai.description : [ai.description, "[[Add your email or phone number in Business settings]]"].filter(Boolean).join(" "),
        email,
        phone,
        address,
      };
      break;
    }
    case "products":
      settings = { title: ai.title, category: canonicalCategory(ai.category, ctx), collection: ai.collection, limit: ai.limit };
      break;
  }
  const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = sectionSchema.safeParse({ id, type: ai.type, order, visible: true, settings: clean });
  if (!parsed.success) throw new PageBuildError("invalid_result", "The suggested section does not fit the page editor.");
  return parsed.data;
}

/**
 * Changes only the listed text fields of a section. Its id, images, links, style and screen size
 * settings are kept as they are, and the result must still be a valid section.
 */
export function updateSectionText(current: Section, change: Record<string, unknown>, ctx: PageBuildContext): Section {
  const allowed = EDITABLE_FIELDS[current.type] ?? [];
  const blocked = Object.keys(change).filter((key) => !allowed.includes(key));
  if (blocked.length > 0) throw new PageBuildError("unsupported_field", `The ${current.type} section has no editable "${blocked[0]}" text.`);
  const set: Record<string, unknown> = { ...change };
  if (current.type === "products" && typeof set.category === "string") set.category = canonicalCategory(set.category, ctx);
  const parsed = sectionSchema.safeParse({ ...current, settings: { ...(current.settings as Record<string, unknown>), ...set } });
  if (!parsed.success) throw new PageBuildError("invalid_result", "The suggested change does not fit this section.");
  return parsed.data;
}

/** A page slug from a title: never reserved, never one this business already uses. */
export function uniquePageSlug(base: string, existing: ReadonlySet<string>): string {
  let slug = normalizePageSlug(base).slice(0, 60).replace(/-+$/g, "") || "page";
  if (RESERVED_PAGE_SLUGS.has(slug)) slug = `${slug}-page`;
  if (!existing.has(slug)) return slug;
  for (let n = 2; n <= 20; n++) {
    const candidate = `${slug.slice(0, 56)}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new PageBuildError("slug_unavailable", "Choose a different page name: this one is already used.");
}

/** A create-page action for a new AI page. */
export function buildNewPageAction(page: AiNewPage, ctx: PageBuildContext & { existingSlugs: ReadonlySet<string>; slugBase?: string; titleOverride?: string }): Extract<EditingAction, { kind: "create-page" }> {
  const counts = new Map<string, number>();
  const sections = page.sections.map((s, index) => {
    const n = (counts.get(s.type) ?? 0) + 1;
    counts.set(s.type, n);
    return toSection(s, n === 1 ? s.type : `${s.type}-${n}`, index, ctx);
  });
  const title = (ctx.titleOverride ?? page.title).slice(0, 140);
  return { actionId: "page-1", kind: "create-page", title, slug: uniquePageSlug(ctx.slugBase ?? page.title, ctx.existingSlugs), sections };
}

/** Editing actions for changes to one existing (draft) page. */
export function buildPageEditActions(
  page: { id: string; version: number; sections: Section[] },
  edit: AiPageEdit,
  ctx: PageBuildContext,
): EditingAction[] {
  if (edit.changes.length === 0) throw new PageBuildError("no_changes", "These suggestions would not change anything.");
  const ids = new Set(page.sections.map((s) => s.id));
  // Actions apply one after another, and adding, moving or removing renumbers the page. So each
  // one is built against the page as the actions before it leave it, as the editing engine does.
  let running: Section[] = [...page.sections];
  const inOrder = (): Section[] => [...running].sort((a, b) => a.order - b.order);
  const renumber = (sections: Section[]): Section[] => sections.map((section, order) => ({ ...section, order }));
  const actions: EditingAction[] = [];
  let count = 0;
  const actionId = () => `change-${++count}`;
  const base = { pageId: page.id, expectedVersion: page.version };

  for (const change of edit.changes) {
    if (change.op === "add") {
      let n = 1;
      while (ids.has(`ai-${change.section.type}-${n}`)) n++;
      const id = `ai-${change.section.type}-${n}`;
      ids.add(id);
      const sections = inOrder();
      const index = Math.min(change.index, sections.length);
      const section = toSection(change.section, id, index, ctx);
      sections.splice(index, 0, section);
      running = renumber(sections);
      actions.push({ ...base, actionId: actionId(), kind: "add-section", index, section });
      continue;
    }
    const current = running.find((s) => s.id === change.sectionId);
    if (!current) throw new PageBuildError("unknown_section", `There is no section "${change.sectionId}" on this page.`);
    if (change.op === "remove") {
      running = renumber(inOrder().filter((s) => s.id !== change.sectionId));
      actions.push({ ...base, actionId: actionId(), kind: "remove-section", sectionId: change.sectionId });
    } else if (change.op === "move") {
      const sections = inOrder();
      const from = sections.findIndex((s) => s.id === change.sectionId);
      const toIndex = Math.min(change.toIndex, sections.length - 1);
      // Already there: moving it would change nothing, and the engine refuses that.
      if (from === toIndex) continue;
      sections.splice(toIndex, 0, sections.splice(from, 1)[0]);
      running = renumber(sections);
      actions.push({ ...base, actionId: actionId(), kind: "reorder-sections", sectionId: change.sectionId, toIndex });
    } else {
      const updated = updateSectionText(current, change.set, ctx);
      running = running.map((s) => (s.id === current.id ? updated : s));
      actions.push({ ...base, actionId: actionId(), kind: "update-section", section: updated });
    }
  }
  if (actions.length === 0) throw new PageBuildError("no_changes", "These suggestions would not change anything.");
  return actions;
}

/**
 * The owner's published page with the AI changes applied, as a NEW draft page.
 * Published pages are never changed by proposals (they stay live as they are):
 * the owner reviews the new version, then replaces the old page themselves.
 */
export function buildDraftCopyAction(
  page: { id: string; version: number; title: string; slug: string; sections: Section[] },
  edit: AiPageEdit,
  ctx: PageBuildContext & { existingSlugs: ReadonlySet<string> },
): Extract<EditingAction, { kind: "create-page" }> {
  // Positions in the actions count from the page in its display order.
  const sections = [...page.sections].sort((a, b) => a.order - b.order);
  for (const action of buildPageEditActions(page, edit, ctx)) {
    if (action.kind === "update-section") {
      const index = sections.findIndex((s) => s.id === action.section.id);
      if (index >= 0) sections[index] = action.section;
    } else if (action.kind === "add-section") {
      sections.splice(Math.min(action.index, sections.length), 0, action.section);
    } else if (action.kind === "remove-section") {
      const index = sections.findIndex((s) => s.id === action.sectionId);
      if (index >= 0) sections.splice(index, 1);
    } else if (action.kind === "reorder-sections") {
      const index = sections.findIndex((s) => s.id === action.sectionId);
      if (index >= 0) sections.splice(Math.min(action.toIndex, sections.length - 1), 0, sections.splice(index, 1)[0]);
    }
  }
  if (sections.length === 0) throw new PageBuildError("invalid_result", "A page needs at least one section.");
  return {
    actionId: "page-1",
    kind: "create-page",
    title: `${page.title} (new version)`.slice(0, 140),
    slug: uniquePageSlug(`${page.slug}-new`, ctx.existingSlugs),
    sections: sections.map((section, order) => ({ ...section, order })),
  };
}

/**
 * Every text a planned page would put on the store, placeholders removed (claims check and comparing
 * with what was generated). A question states nothing. A page without sections shows its title and
 * purpose (`planToEditingActions`).
 */
export function planPageTexts(page: WebsitePlan["pages"][number]): string[] {
  const out: string[] = [];
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string") {
      if (!["question", "ctaHref", "buttonHref", "imageUrl", "url"].includes(key)) out.push(value.replace(PLACEHOLDER_PATTERN, " "));
    } else if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => visit(item, name));
  };
  visit(page.title);
  visit(page.proposedContent);
  if (page.sections.length === 0) visit(page.purpose);
  for (const section of page.sections) visit(section.settings);
  return out.filter((text) => text.trim().length > 0);
}

/** The same for a whole plan. */
export function planVisibleTexts(plan: WebsitePlan): string[] {
  return plan.pages.flatMap(planPageTexts);
}

/** Every text an AI page answer would put on the store, placeholders removed (claims check). */
export function aiPageTexts(value: AiNewPage | AiPageEdit): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v.replace(PLACEHOLDER_PATTERN, " "));
    else if (Array.isArray(v)) v.forEach(visit);
    // A question states nothing ("Do you offer a warranty?"): only answers are checked.
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => (k === "type" || k === "op" || k === "sectionId" || k === "collection" || k === "question" ? null : visit(x)));
  };
  if ("sections" in value) visit([value.title, value.sections]);
  else visit(value.changes);
  return out.filter((t) => t.trim().length > 0);
}
