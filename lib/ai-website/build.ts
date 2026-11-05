import { ZodError } from "zod";
import { PageBuildError, buildDraftCopyAction, toSection, uniquePageSlug, updateSectionText, type AiSection, type PageBuildContext } from "@/lib/ai-builder/page-builder";
import { applyStorefrontChanges } from "@/lib/ai-builder/storefront-changes";
import { designDraftSchema, type DesignDraft } from "@/lib/design-settings";
import { textReadability } from "@/lib/color-contrast";
import { canSelectTheme, type ThemeAccess } from "@/lib/theme-tiers";
import { sectionTemplate } from "@/lib/section-library";
import { SECTION_TYPE_LABELS, sectionSchema, type Section } from "@/lib/sections";
import { withResponsiveValue, type ResponsiveRule, type ResponsiveSettings } from "@/lib/section-responsive";
import { HOME_BLOCK_TYPES, HOME_SECTION_LABELS, SINGLE_INSTANCE_TYPES, createHomeSection, homeSectionSchema, readStorefrontConfig, storefrontConfigSchema, type HomeSection, type StorefrontConfig } from "@/lib/storefront-config";
import type { AiDesignChoices, AiHomeAnswer, AiRevisionChange, AiWebsitePageContent, AiWebsitePlan, AiWebsiteRevision, AiWebsiteSection } from "./answers";
import { MAX_WEBSITE_PAGES, websitePageSchema, type ClassicHomepage, type WebsiteBaseline, type WebsiteBlueprint, type WebsiteChanges, type WebsiteIdentity, type WebsiteNavItem, type WebsiteNavigation, type WebsitePage, type WebsitePreview, type WebsiteState, type PreviewNavItem } from "./blueprint";

/**
 * Turns validated answers into the product's own data (pure; no I/O). Nothing the provider said is
 * used as it was: links must be real, categories must exist, images come from this store's media
 * and contact details from its settings. Every result passes the existing schemas again.
 */
export interface WebsiteBuildContext extends PageBuildContext {
  /** This store's own media, by the references sent in the prompt. */
  media: ReadonlyMap<string, { url: string; alt: string }>;
  /** This store's own active products, by the references sent in the prompt. */
  products: ReadonlyMap<string, string>;
  themeAccess: ThemeAccess;
  /** Pictures the owner is asked to upload: collected while building, shown as notes. */
  imageRequests: string[];
}

/** The product ids behind these references. One the server did not offer is left out. */
function productIdsFrom(refs: readonly string[], ctx: WebsiteBuildContext): string[] {
  return [...new Set(refs.flatMap((ref) => {
    const id = ctx.products.get(ref);
    return id ? [id] : [];
  }))];
}

/** Sections work without a picture, so a missing one becomes a request to the owner, never an invented address. */
function imageNotes(ctx: WebsiteBuildContext): string[] {
  return [...new Set(ctx.imageRequests)].slice(0, 5).map((request) => `Upload a picture to your media library and add it here: ${request}`);
}

const pathToSlug = (path: string) => path.replace(/^\/+/, "").split(/[/?#]/)[0].toLowerCase();

/** A section of the shared types, built by the same code as a single page suggestion. */
export function toWebsiteSection(ai: AiWebsiteSection, id: string, order: number, ctx: WebsiteBuildContext): Section {
  const image = (ref: string | undefined, alt: string | undefined, request: string | undefined) => {
    const media = ref ? ctx.media.get(ref) : undefined;
    if (media) return { imageUrl: media.url, imageAlt: alt || media.alt };
    if (request || ref) ctx.imageRequests.push(request || alt || "a picture for this section");
    return {};
  };
  const parse = (type: string, settings: Record<string, unknown>) => {
    const clean = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined && value !== ""));
    const parsed = sectionSchema.safeParse({ id, type, order, visible: true, settings: clean });
    if (!parsed.success) throw new PageBuildError("invalid_result", "A suggested section does not fit the page editor.");
    return parsed.data;
  };
  const allowed = (href: string | undefined) => (href && ctx.links.includes(href.split("#")[0]) ? href : undefined);

  switch (ai.type) {
    case "template": {
      const template = sectionTemplate(ai.template);
      if (!template) throw new PageBuildError("invalid_result", "A suggested section is not in the section library.");
      return parse(template.section.type, structuredClone(template.section.settings));
    }
    case "hero":
    case "about": {
      const { imageRef, imageAlt, imageRequest, ...rest } = ai;
      const section = toSection(rest as AiSection, id, order, ctx);
      return parse(section.type, { ...(section.settings as Record<string, unknown>), ...image(imageRef, imageAlt, imageRequest) });
    }
    case "features":
    case "faq":
    case "cta":
    case "contact":
    case "products":
      return toSection(ai as AiSection, id, order, ctx);
    case "richText":
      return parse(ai.type, { title: ai.title, body: ai.body });
    case "imageText": {
      const ctaHref = allowed(ai.ctaHref);
      return parse(ai.type, { title: ai.title, body: ai.body, imageSide: ai.imageSide, ...image(ai.imageRef, ai.imageAlt, ai.imageRequest), ...(ctaHref ? { ctaHref, ctaText: ai.ctaText } : {}) });
    }
    case "steps":
      return parse(ai.type, { title: ai.title, items: ai.items });
    case "newsletter":
      return parse(ai.type, { headline: ai.headline, description: ai.description, buttonText: ai.buttonText });
    case "spacer":
      return parse(ai.type, { size: ai.size, line: ai.line });
    case "reviews":
      return parse(ai.type, { title: ai.title, limit: ai.limit });
    case "gallery":
      return parse(ai.type, {
        title: ai.title,
        columns: ai.columns,
        images: ai.images.flatMap((item) => {
          const media = ctx.media.get(item.imageRef);
          if (!media) ctx.imageRequests.push(item.alt);
          return media ? [{ url: media.url, alt: item.alt, caption: item.caption }] : [];
        }),
      });
  }
}

/** Section ids stay stable and unique on a page: `about`, `about-2`. */
function buildSections(answers: AiWebsiteSection[], ctx: WebsiteBuildContext, taken: ReadonlySet<string> = new Set()): Section[] {
  const used = new Set(taken);
  return answers.map((ai, order) => {
    const root = ai.type === "template" ? (sectionTemplate(ai.template)?.section.type ?? "section") : ai.type;
    let id = root;
    for (let n = 2; used.has(id); n += 1) id = `${root}-${n}`;
    used.add(id);
    return toWebsiteSection(ai, id, order, ctx);
  });
}

/** Colours the owner would be warned about are left to the theme, rather than put on a store. */
export function applyDesignChoices(current: DesignDraft, themeId: DesignDraft["themeId"], set: AiDesignChoices, notes: string[]): DesignDraft {
  const next = { ...current, ...set, themeId };
  if (set.primaryColor || set.accentColor) next.useThemeColors = set.useThemeColors ?? false;
  if (next.backgroundColor && next.textColor && textReadability(next.textColor, next.backgroundColor)?.level === "low") {
    next.backgroundColor = current.backgroundColor;
    next.textColor = current.textColor;
    notes.push("The suggested page colours were hard to read together, so they were left out.");
  }
  return designDraftSchema.parse(next);
}

function chooseTheme(requested: DesignDraft["themeId"], current: DesignDraft["themeId"], ctx: WebsiteBuildContext, notes: string[]): DesignDraft["themeId"] {
  if (requested === current || canSelectTheme(ctx.themeAccess, requested)) return requested;
  notes.push(`The ${requested} theme is not included in your plan, so your current theme is kept.`);
  return current;
}

function homeBlockFrom(ai: AiWebsiteSection, existing: ReadonlyArray<{ id: string }>, ctx: WebsiteBuildContext): HomeSection | null {
  const blockType = ai.type === "template" ? sectionTemplate(ai.template)?.section.type : ai.type;
  if (!blockType || !(HOME_BLOCK_TYPES as readonly string[]).includes(blockType)) return null;
  const base = createHomeSection("block", existing, blockType);
  return homeSectionSchema.parse({ ...base, block: toWebsiteSection(ai, `${base.id}-content`, 0, ctx) });
}

/** The homepage from an answer, keeping what the answer says nothing about: images, chosen products, policies, social links. */
function homeConfigFrom(current: StorefrontConfig, home: AiHomeAnswer, ctx: WebsiteBuildContext, notes: string[]): StorefrontConfig {
  const sections: HomeSection[] = [];
  for (const item of home.sections) {
    if (item.kind === "block") {
      // Answers are checked before they are kept, but a category can be removed while a website is
      // being written. One section must not stop the whole website, so it is left out and said so.
      let block: HomeSection | null = null;
      try {
        block = homeBlockFrom(item.section, sections, ctx);
      } catch (error) {
        if (!(error instanceof PageBuildError)) throw error;
      }
      if (block) sections.push(block);
      else notes.push("A suggested homepage section is not available on the homepage, so it was left out.");
      continue;
    }
    if (SINGLE_INSTANCE_TYPES.includes(item.kind) && sections.some((section) => section.type === item.kind)) continue;
    const keep = current.sections.find((section) => section.type === item.kind && !sections.some((placed) => placed.id === section.id));
    const base = keep ?? createHomeSection(item.kind, sections);
    const merged: Record<string, unknown> = { ...base };
    if (item.title !== undefined) merged.title = item.title;
    if (item.subtitle !== undefined) merged.subtitle = item.subtitle;
    if (item.limit !== undefined && "limit" in base) merged.limit = base.type === "categories" ? Math.min(item.limit, 12) : item.limit;
    if (item.text !== undefined && base.type === "story") merged.text = item.text;
    if (item.products && base.type === "featured") {
      const chosen = productIdsFrom(item.products, ctx);
      if (chosen.length > 0) merged.productIds = chosen;
    }
    sections.push(homeSectionSchema.parse(merged));
  }

  const { imageRef, imageAlt, imageRequest, primaryCta, secondaryCta, ...heroText } = home.hero;
  const hrefOf = (cta: { label: string; href: string } | undefined) => (cta ? { label: cta.label, href: ctx.links.includes(cta.href.split("#")[0]) ? cta.href : "" } : undefined);
  const media = imageRef ? ctx.media.get(imageRef) : undefined;
  if (!media && !current.hero.imageUrl && (imageRequest || imageRef)) ctx.imageRequests.push(imageRequest || imageAlt || "a picture for your homepage banner");
  const primary = hrefOf(primaryCta);
  const secondary = hrefOf(secondaryCta);
  return parseConfig(
    {
      ...current,
      hero: {
        ...current.hero,
        ...heroText,
        ...(primary ? { primaryCta: primary } : {}),
        ...(secondary ? { secondaryCta: secondary } : {}),
        ...(media ? { imageUrl: media.url, imageAlt: imageAlt || media.alt } : {}),
      },
      announcement: { ...current.announcement, ...home.announcement, ...(home.announcement?.href && !ctx.links.includes(home.announcement.href) ? { href: "" } : {}) },
      sections: sections.length > 0 ? sections : current.sections,
      seo: { ...current.seo, ...(home.seoTitle !== undefined ? { title: home.seoTitle } : {}), ...(home.seoDescription !== undefined ? { description: home.seoDescription } : {}) },
    },
    current,
  );
}

function parseConfig(value: unknown, current: StorefrontConfig): StorefrontConfig {
  const parsed = storefrontConfigSchema.safeParse(value);
  if (!parsed.success) throw new PageBuildError("invalid_result", "The suggested homepage does not fit the website editor.");
  // In the stored order of fields, so comparing it with the current draft finds only real changes.
  return readStorefrontConfig({ ...parsed.data, sections: parsed.data.sections ?? current.sections });
}

function withFooter(config: StorefrontConfig, set: AiWebsitePlan["footer"], ctx: WebsiteBuildContext): StorefrontConfig {
  const { columns, ...rest } = set;
  return parseConfig(
    {
      ...config,
      footer: {
        ...config.footer,
        ...rest,
        // A link that leads nowhere is left out, as on every other store link.
        ...(columns ? { columns: columns.map((column) => ({ title: column.title, links: column.links.filter((item) => ctx.links.includes(item.href.split("#")[0])) })) } : {}),
      },
    },
    config,
  );
}

const newPage = (fields: Pick<WebsitePage, "title" | "slug" | "description" | "seoTitle" | "seoDescription" | "sections">): WebsitePage => ({
  id: null,
  status: "draft",
  isHome: false,
  version: 0,
  seoImage: "",
  aiWritten: true,
  // Policy wording needs the owner's review before it can be published, like the policy templates.
  needsReview: /(privacy|terms|refund|return|shipping|polic|legal|cookie)/.test(fields.slug),
  ...fields,
});

const navItemFor = (page: Pick<WebsitePage, "slug" | "title">, order: number): WebsiteNavItem => ({ pageSlug: page.slug, label: page.title.slice(0, 80), order });
/** The most `websiteNavigationSchema` allows in one menu. */
const MAX_MENU_ITEMS = 30;

/** Menus with these pages added, keeping every link already there. */
function withMenuLinks(navigation: WebsiteNavigation, placed: Array<{ page: Pick<WebsitePage, "slug" | "title">; nav: "header" | "footer" | "both" | "none" }>): WebsiteNavigation {
  const add = (items: WebsiteNavItem[], area: "header" | "footer") => {
    const out = [...items];
    for (const { page, nav } of placed) {
      // A full menu keeps what it has: the page is still created, and can be added by hand.
      if ((nav === area || nav === "both") && out.length < MAX_MENU_ITEMS && !out.some((item) => item.pageSlug === page.slug)) out.push(navItemFor(page, out.length));
    }
    return out;
  };
  return { header: add(navigation.header, "header"), footer: add(navigation.footer, "footer") };
}

/** The parts of a website that come from the plan: its theme, design, homepage, header and footer. */
function planParts(current: WebsiteState, plan: AiWebsitePlan, context: WebsiteBuildContext, notes: string[]) {
  const themeId = chooseTheme(plan.themeId, current.design.themeId, context, notes);
  const design = applyDesignChoices(current.design, themeId, plan.design, notes);
  const homepage = homeConfigFrom(current.config, plan.home, context, notes);
  const config = withFooter(parseConfig({ ...homepage, header: { ...homepage.header, ...plan.header } }, homepage), plan.footer, context);
  return { themeId, design, config };
}

/** A trial context: the planned pages count as real links, and nothing collected here reaches the owner. */
const trialContext = (ctx: WebsiteBuildContext, plannedPages: readonly PlannedPage[]): WebsiteBuildContext => ({
  ...ctx,
  links: [...new Set([...ctx.links, ...plannedPages.map((page) => `/${page.slug}`)])],
  imageRequests: [],
});

/**
 * Throws if a plan could not become a website, using the same code the final build uses. Run before a
 * plan is kept and before it is charged for, so a problem shows at this step and not after every page.
 */
export function assertPlanBuildable(input: { current: WebsiteState; plan: AiWebsitePlan; plannedPages: readonly PlannedPage[] }, ctx: WebsiteBuildContext): void {
  planParts(input.current, input.plan, trialContext(ctx, input.plannedPages), []);
}

/**
 * Which of these written pages could not be built now, using the same code the final build uses. Run on a
 * page before it is kept, and on all of them before the final build, since the store can change meanwhile.
 * A page with no content yet is not a problem: it simply has not been written.
 */
export function unbuildablePages(plannedPages: readonly PlannedPage[], contents: Record<string, AiWebsitePageContent>, ctx: WebsiteBuildContext): PlannedPage[] {
  const context = trialContext(ctx, plannedPages);
  return plannedPages.filter((planned) => {
    const content = contents[planned.key];
    if (!content) return false;
    try {
      const sections = buildSections(content.sections, context);
      const fields = { title: planned.title, slug: planned.slug, description: content.description, seoTitle: content.seoTitle, seoDescription: content.seoDescription, sections };
      return !websitePageSchema.safeParse(newPage(fields)).success;
    } catch (error) {
      if (error instanceof PageBuildError || error instanceof ZodError) return true;
      throw error;
    }
  });
}

/**
 * The plan and the page contents together: one complete website. Pages the plan does not mention are
 * kept as they are, and none is ever removed. Policy wording is flagged for the owner's review.
 */
export function buildWebsiteBlueprint(
  input: { businessName: string; category: string; current: WebsiteState; plan: AiWebsitePlan; contents: Record<string, AiWebsitePageContent>; plannedPages: PlannedPage[] },
  ctx: WebsiteBuildContext,
): { blueprint: WebsiteBlueprint; notes: string[] } {
  const { current, plan, plannedPages, contents } = input;
  const notes = [...plan.notes];
  const links = new Set(ctx.links);
  for (const planned of plannedPages) links.add(`/${planned.slug}`);
  const context: WebsiteBuildContext = { ...ctx, links: [...links] };

  const { themeId, design, config } = planParts(current, plan, context, notes);

  const pages = current.pages.map((page) => ({ ...page }));
  for (const planned of plannedPages) {
    const content = contents[planned.key];
    if (!content) throw new PageBuildError("invalid_result", "A page of this website has not been generated yet.");
    const sections = buildSections(content.sections, context);
    const fields = { title: planned.title, slug: planned.slug, description: content.description, seoTitle: content.seoTitle, seoDescription: content.seoDescription, sections };
    const index = planned.existingId ? pages.findIndex((page) => page.id === planned.existingId) : -1;
    if (index >= 0) pages[index] = { ...pages[index], ...fields, aiWritten: true };
    else pages.push(newPage(fields));
  }

  const navigation = withMenuLinks(current.navigation, plannedPages.map((planned) => ({ page: planned, nav: planned.nav })));
  const identity: WebsiteIdentity = {
    businessName: input.businessName,
    category: input.category,
    description: plan.identity.description ?? "",
    targetAudience: plan.identity.targetAudience ?? "",
    purpose: plan.identity.purpose ?? "",
    personality: plan.identity.personality ?? "",
    language: plan.identity.language ?? "",
    themeId,
  };
  const noMedia = context.media.size === 0 ? ["Your media library has no pictures this website can use yet, so sections are shown without pictures. Upload some to your media library, then add them in the website editor."] : [];
  return { blueprint: { version: 1, identity, design, config, navigation, pages }, notes: [...notes, ...noMedia, ...imageNotes(context)] };
}

export interface PlannedPage {
  key: string;
  title: string;
  slug: string;
  purpose: string;
  nav: "header" | "footer" | "both" | "none";
  /** The existing page this rewrites. */
  existingId: string | null;
}

/**
 * The pages to write, with final addresses. Never the home page, which is the homepage above, and never
 * more than the plan and the allowance leave room for: the rest are named in a note, not started.
 */
export function plannedPagesFrom(plan: AiWebsitePlan, current: WebsiteState, limits: { maxNewPages: number; maxPages: number; lockedPageIds: readonly string[] }): { pages: PlannedPage[]; notes: string[] } {
  const notes: string[] = [];
  const taken = new Set(current.pages.map((page) => page.slug));
  const pages: PlannedPage[] = [];
  let created = 0;
  for (const item of plan.pages) {
    // A page whose stored content cannot be read is left alone: this becomes a new page instead.
    const existing = item.existingPath ? current.pages.find((page) => page.slug === pathToSlug(item.existingPath as string) && !page.isHome && !limits.lockedPageIds.includes(page.id ?? "")) : undefined;
    if (existing && pages.some((page) => page.existingId === existing.id)) continue;
    if (pages.length >= Math.min(limits.maxPages, MAX_WEBSITE_PAGES) || (!existing && created >= limits.maxNewPages)) {
      notes.push(`"${item.title}" was left out to stay within your limits. You can ask for it later.`);
      continue;
    }
    let slug = existing?.slug;
    if (!slug) {
      slug = uniquePageSlug(item.title, taken);
      taken.add(slug);
      created += 1;
    }
    pages.push({ key: `p${pages.length}`, title: item.title, slug, purpose: item.purpose, nav: item.nav, existingId: existing?.id ?? null });
  }
  return { pages, notes };
}

/** The current state with a proposal's changes applied: what a revision of a waiting proposal builds on. */
export function stateAfterChanges(current: WebsiteState, changes: WebsiteChanges): WebsiteState {
  const pages = current.pages.map((page) => changes.updatePages.find((update) => update.id === page.id) ?? page);
  return {
    design: changes.design ?? current.design,
    config: changes.config ?? current.config,
    navigation: changes.navigation ?? current.navigation,
    pages: [...pages, ...changes.createPages],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pageFields = (page: WebsitePage) => [page.title, page.slug, page.description, page.seoTitle, page.seoDescription, page.seoImage, page.sections];

/** Only what differs between two states, so everything else is left alone. */
export function changesBetween(before: WebsiteState, after: WebsiteState): WebsiteChanges {
  const updatePages = after.pages.filter((page) => {
    if (!page.id) return false;
    const old = before.pages.find((candidate) => candidate.id === page.id);
    return old ? !same(pageFields(old), pageFields(page)) : false;
  });
  return {
    ...(same(before.config, after.config) ? {} : { config: after.config }),
    ...(same(before.design, after.design) ? {} : { design: after.design }),
    ...(same(before.navigation, after.navigation) ? {} : { navigation: after.navigation }),
    createPages: after.pages.filter((page) => !page.id),
    updatePages,
  };
}

export const hasChanges = (changes: WebsiteChanges) => Boolean(changes.config || changes.design || changes.navigation || changes.createPages.length > 0 || changes.updatePages.length > 0);

export interface WebsiteDiffRow {
  area: "homepage" | "page" | "menu" | "design" | "header" | "footer";
  kind: "added" | "modified" | "removed";
  label: string;
  before: string;
  after: string;
  live: false;
}

const short = (value: unknown) => {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
};
/** A setting's name as words: `headingWeight` is "heading weight". */
const words = (key: string) => key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
const sectionLabel = (section: Section) => {
  const settings = section.settings as { title?: unknown; headline?: unknown };
  const heading = typeof settings.title === "string" && settings.title ? settings.title : typeof settings.headline === "string" ? settings.headline : "";
  return heading ? `${SECTION_TYPE_LABELS[section.type]}: ${heading}` : SECTION_TYPE_LABELS[section.type];
};

/** A value as the review screen shows it. */
const describe = (key: string, value: unknown) => {
  if (value === undefined || value === null || value === "") return "(empty)";
  if (key === "imageUrl" || key === "url") return "A picture";
  if (key === "productIds" && Array.isArray(value)) return `${value.length} chosen ${value.length === 1 ? "product" : "products"}`;
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  return short(value);
};

/** One row per field that really changed, so a proposal shows exactly what it does to a section. */
function fieldRows(area: WebsiteDiffRow["area"], prefix: string, before: Record<string, unknown>, after: Record<string, unknown>): WebsiteDiffRow[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !same(before[key], after[key]))
    .map((key) => ({ area, kind: "modified" as const, label: `${prefix}: ${words(key)}`, before: describe(key, before[key]), after: describe(key, after[key]), live: false as const }));
}

function diffList<T>(input: { area: WebsiteDiffRow["area"]; prefix: string; before: T[]; after: T[]; key: (item: T) => string; label: (item: T) => string; fields?: (before: T, after: T, label: string) => WebsiteDiffRow[]; rows: WebsiteDiffRow[] }) {
  const { area, prefix, before, after, key, label, fields, rows } = input;
  const beforeKeys = before.map(key);
  const afterKeys = after.map(key);
  for (const item of after) {
    const old = before.find((candidate) => key(candidate) === key(item));
    if (!old) rows.push({ area, kind: "added", label: `${prefix}: ${label(item)} added`, before: "(none)", after: label(item), live: false });
    else if (!same(old, item)) {
      const detail = fields ? fields(old, item, `${prefix}: ${label(old)}`) : [];
      if (detail.length > 0) rows.push(...detail);
      else rows.push({ area, kind: "modified", label: `${prefix}: ${label(item)} changed`, before: short(label(old)), after: short(label(item)), live: false });
    }
  }
  for (const item of before) {
    if (!afterKeys.includes(key(item))) rows.push({ area, kind: "removed", label: `${prefix}: ${label(item)} removed`, before: label(item), after: "(removed)", live: false });
  }
  const keptBefore = beforeKeys.filter((id) => afterKeys.includes(id));
  const keptAfter = afterKeys.filter((id) => beforeKeys.includes(id));
  if (!same(keptBefore, keptAfter)) rows.push({ area, kind: "modified", label: `${prefix}: order changed`, before: "Current order", after: "New order", live: false });
}

/** Added, changed and removed items, in the owner's words, for the review screen. */
export function diffWebsite(before: WebsiteState, changes: WebsiteChanges): { changes: WebsiteDiffRow[]; summary: { added: number; modified: number; removed: number } } {
  const rows: WebsiteDiffRow[] = [];
  const field = (area: WebsiteDiffRow["area"], label: string, a: unknown, b: unknown) => {
    if (!same(a, b)) rows.push({ area, kind: "modified", label, before: short(a) || "(empty)", after: short(b) || "(empty)", live: false });
  };

  if (changes.config) {
    const next = changes.config;
    const old = before.config;
    field("homepage", "Homepage headline", old.hero.headline, next.hero.headline);
    field("homepage", "Homepage introduction", old.hero.description, next.hero.description);
    field("homepage", "Homepage small heading", old.hero.eyebrow, next.hero.eyebrow);
    field("homepage", "Homepage main button", old.hero.primaryCta, next.hero.primaryCta);
    field("homepage", "Homepage picture", old.hero.imageUrl ? "Set" : "", next.hero.imageUrl ? "Set" : "");
    field("homepage", "Announcement bar", old.announcement, next.announcement);
    field("homepage", "Homepage search title", old.seo.title, next.seo.title);
    field("homepage", "Homepage search description", old.seo.description, next.seo.description);
    diffList({ area: "homepage", prefix: "Homepage section", before: old.sections, after: next.sections, key: (s) => s.id, label: (s) => s.title || (s.type === "block" ? sectionLabel(s.block) : HOME_SECTION_LABELS[s.type]), fields: (a, b, label) => (a.type === "block" && b.type === "block" ? [...fieldRows("homepage", label, a.block.settings as Record<string, unknown>, b.block.settings as Record<string, unknown>), ...(same(a.responsive, b.responsive) ? [] : [{ area: "homepage" as const, kind: "modified" as const, label: `${label}: screen size settings`, before: "Current", after: "Changed", live: false as const }])] : fieldRows("homepage", label, { ...a }, { ...b })), rows });
    for (const key of Object.keys(next.header) as Array<keyof typeof next.header>) field("header", `Header: ${words(key)}`, old.header[key], next.header[key]);
    field("footer", "Footer layout", old.footer.layout, next.footer.layout);
    field("footer", "Footer description", old.footer.about, next.footer.about);
    field("footer", "Footer copyright line", old.footer.copyright, next.footer.copyright);
    field("footer", "Footer columns", old.footer.columns.map((column) => column.title), next.footer.columns.map((column) => column.title));
    for (const key of ["showContact", "showSocial", "showShopLinks", "showMenuLinks"] as const) field("footer", `Footer: ${words(key)}`, old.footer[key], next.footer[key]);
  }
  if (changes.design) {
    const next = changes.design;
    for (const key of Object.keys(next) as Array<keyof DesignDraft>) field("design", `Design: ${words(key)}`, before.design[key], next[key]);
  }
  if (changes.navigation) {
    for (const area of ["header", "footer"] as const) {
      diffList({ area: "menu", prefix: `${area === "header" ? "Header" : "Footer"} menu`, before: before.navigation[area], after: changes.navigation[area], key: (item) => item.pageSlug ?? item.href ?? item.label, label: (item) => item.label, rows });
    }
  }
  for (const page of changes.createPages) {
    rows.push({ area: "page", kind: "added", label: `New page: ${page.title}`, before: "(none)", after: `/${page.slug} · ${page.sections.length} sections`, live: false });
  }
  for (const page of changes.updatePages) {
    const old = before.pages.find((candidate) => candidate.id === page.id);
    if (!old) continue;
    field("page", `${old.title}: title`, old.title, page.title);
    field("page", `${old.title}: search title`, old.seoTitle, page.seoTitle);
    field("page", `${old.title}: search description`, old.seoDescription, page.seoDescription);
    field("page", `${old.title}: description`, old.description, page.description);
    diffList({ area: "page", prefix: old.title, before: old.sections, after: page.sections, key: (s) => s.id, label: sectionLabel, fields: (a, b, label) => [...fieldRows("page", label, a.settings as Record<string, unknown>, b.settings as Record<string, unknown>), ...(same(a.style, b.style) ? [] : [{ area: "page" as const, kind: "modified" as const, label: `${label}: screen size settings`, before: "Current", after: "Changed", live: false as const }])], rows });
  }
  return {
    changes: rows,
    summary: { added: rows.filter((row) => row.kind === "added").length, modified: rows.filter((row) => row.kind === "modified").length, removed: rows.filter((row) => row.kind === "removed").length },
  };
}

function previewNavItem(item: WebsiteNavItem, pages: ReadonlyArray<Pick<WebsitePage, "slug" | "id">>): PreviewNavItem | null {
  const children = (item.children ?? []).map((child) => previewNavItem(child, pages)).filter((child): child is PreviewNavItem => child !== null);
  const extra = { ...(children.length > 0 ? { children } : {}), ...(item.showOn ? { showOn: item.showOn } : {}) };
  if (item.pageSlug) {
    const page = pages.find((candidate) => candidate.slug === item.pageSlug);
    return page ? { pageId: page.id ?? "", label: item.label, slug: page.slug, href: `/${page.slug}`, ...extra } : null;
  }
  if (item.href) return { pageId: "", label: item.label, slug: "", href: item.href, ...(/^https:/i.test(item.href) ? { external: true } : {}), ...extra };
  return children.length > 0 ? { pageId: "", label: item.label, slug: "", href: "#", ...extra } : null;
}

/** The proposed website as the renderer needs it. Unchanged pages come too, so its menus lead somewhere. */
export function websitePreviewOf(state: WebsiteState, changes: WebsiteChanges, classicHomepage: ClassicHomepage | null = null): WebsitePreview {
  const proposed = new Set([...changes.createPages, ...changes.updatePages].map((page) => page.slug));
  const area = (items: WebsiteNavItem[]) => items.map((item) => previewNavItem(item, state.pages)).filter((item): item is PreviewNavItem => item !== null);
  return {
    design: state.design,
    config: state.config,
    navigation: { header: area(state.navigation.header), footer: area(state.navigation.footer) },
    pages: state.pages.filter((page) => !page.isHome).map((page) => ({ id: page.id ?? `new-${page.slug}`, title: page.title, slug: page.slug, sections: page.sections, proposed: proposed.has(page.slug) })),
    classicHomepage,
  };
}

/**
 * A proposal laid over the drafts as they are now, without asking the AI again. Anything only the proposal
 * changed is taken from it. Anything only the owner changed since is kept as it is. Anything both changed
 * is a conflict: it is named, and nothing is decided on the owner's behalf.
 */
export function rebaseWebsiteChanges(baseline: WebsiteBaseline, changes: WebsiteChanges, current: WebsiteState): { state: WebsiteState; conflicts: string[] } {
  const conflicts: string[] = [];
  const merge = <T,>(before: T, mine: T, theirs: T, label: string): T => {
    if (same(mine, before) || same(mine, theirs)) return theirs;
    if (same(theirs, before)) return mine;
    conflicts.push(label);
    return theirs;
  };
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((item) => [item.id, item]));
  /** Section by section when both still hold the same sections in the same order. */
  const mergeSections = <T extends { id: string }>(before: T[], mine: T[], theirs: T[], label: (item: T) => string, whole: string): T[] => {
    const ids = (list: T[]) => list.map((item) => item.id);
    if (!same(ids(before), ids(theirs)) || !same(ids(before), ids(mine))) return merge(before, mine, theirs, whole);
    const was = byId(before);
    const proposed = byId(mine);
    return theirs.map((section) => merge(was.get(section.id) as T, proposed.get(section.id) as T, section, label(section)));
  };

  let config = current.config;
  if (changes.config && baseline.config) {
    const was = baseline.config;
    const mine = changes.config;
    const now = current.config;
    config = parseConfig(
      {
        ...now,
        announcement: merge(was.announcement, mine.announcement, now.announcement, "your announcement bar"),
        header: merge(was.header, mine.header, now.header, "your header"),
        hero: merge(was.hero, mine.hero, now.hero, "your homepage banner"),
        policies: merge(was.policies, mine.policies, now.policies, "your policies"),
        seo: merge(was.seo, mine.seo, now.seo, "your homepage search text"),
        footer: merge(was.footer, mine.footer, now.footer, "your footer"),
        sections: mergeSections(was.sections, mine.sections, now.sections, (section) => `the homepage section "${section.title || HOME_SECTION_LABELS[section.type]}"`, "the order of your homepage sections"),
      },
      now,
    );
  }

  let design = current.design;
  if (changes.design && baseline.design) {
    const next: Record<string, unknown> = { ...current.design };
    for (const key of Object.keys(changes.design) as Array<keyof DesignDraft>) next[key] = merge(baseline.design[key], changes.design[key], current.design[key], `your design (${words(key)})`);
    design = designDraftSchema.parse(next);
  }

  let navigation = current.navigation;
  if (changes.navigation && baseline.navigation) {
    navigation = {
      header: merge(baseline.navigation.header, changes.navigation.header, current.navigation.header, "your header menu"),
      footer: merge(baseline.navigation.footer, changes.navigation.footer, current.navigation.footer, "your footer menu"),
    };
  }

  const pages = current.pages.map((page) => {
    const mine = changes.updatePages.find((candidate) => candidate.id === page.id);
    const was = baseline.pages.find((candidate) => candidate.id === page.id);
    if (!mine || !was) return page;
    return {
      ...page,
      title: merge(was.title, mine.title, page.title, `the title of "${page.title}"`),
      description: merge(was.description, mine.description, page.description, `the description of "${page.title}"`),
      seoTitle: merge(was.seoTitle, mine.seoTitle, page.seoTitle, `the search title of "${page.title}"`),
      seoDescription: merge(was.seoDescription, mine.seoDescription, page.seoDescription, `the search description of "${page.title}"`),
      seoImage: merge(was.seoImage, mine.seoImage, page.seoImage, `the sharing picture of "${page.title}"`),
      sections: mergeSections(was.sections, mine.sections, page.sections, (section) => `a ${SECTION_TYPE_LABELS[section.type]} section of "${page.title}"`, `the sections of "${page.title}"`),
    };
  });
  for (const page of changes.updatePages) {
    if (!current.pages.some((candidate) => candidate.id === page.id)) conflicts.push(`"${page.title}", which no longer exists`);
  }
  for (const page of changes.createPages) {
    if (current.pages.some((candidate) => candidate.slug === page.slug)) conflicts.push(`the address /${page.slug}, which is now in use`);
  }
  return { state: { design, config, navigation, pages: [...pages, ...changes.createPages] }, conflicts: [...new Set(conflicts)] };
}

function findPage(state: WebsiteState, path: string): WebsitePage {
  const slug = pathToSlug(path);
  const page = state.pages.find((candidate) => candidate.slug === slug);
  if (!page) throw new PageBuildError("unknown_section", `There is no page at /${slug}.`);
  if (page.isHome) throw new PageBuildError("unsupported_field", "That page is your homepage, which is changed with the homepage options.");
  return page;
}

function withResponsive(section: { style?: { responsive?: ResponsiveSettings } }, device: "desktop" | "tablet" | "mobile", rule: ResponsiveRule): ResponsiveSettings | undefined {
  let next = section.style?.responsive;
  for (const [key, value] of Object.entries(rule) as Array<[keyof ResponsiveRule, ResponsiveRule[keyof ResponsiveRule]]>) {
    next = withResponsiveValue(next, device, key, value as never);
  }
  return next;
}

/**
 * One requested revision. Each change touches only what it names: everything else, manual edits
 * included, is copied across unchanged.
 */
export function applyWebsiteRevision(base: WebsiteState, revision: AiWebsiteRevision, ctx: WebsiteBuildContext): { state: WebsiteState; notes: string[] } {
  const notes = [...revision.notes];
  let state: WebsiteState = { ...base, pages: base.pages.map((page) => ({ ...page })) };
  const links = new Set(ctx.links);
  for (const page of state.pages) if (!page.isHome) links.add(`/${page.slug}`);
  for (const change of revision.changes) {
    if (change.op === "page_create") links.add(`/${uniquePageSlug(change.title, new Set(state.pages.map((page) => page.slug)))}`);
  }
  const context: WebsiteBuildContext = { ...ctx, links: [...links], imageRequests: [] };
  const noBrand = { primaryColor: "#000000", accentColor: "#000000", font: "sans" as const };
  const replacePage = (page: WebsitePage) => {
    state = { ...state, pages: state.pages.map((candidate) => (candidate.slug === page.slug ? page : candidate)) };
  };

  for (const change of revision.changes) {
    state = applyOne(state, change);
  }
  return { state, notes: [...notes, ...imageNotes(context)] };

  function applyOne(current: WebsiteState, change: AiRevisionChange): WebsiteState {
    state = current;
    switch (change.op) {
      case "home": {
        if (change.change.op === "brand") {
          notes.push("Colour and font changes are part of the design, so that one was left out.");
          return state;
        }
        return { ...state, config: applyStorefrontChanges(state.config, noBrand, [change.change]).config };
      }
      case "home_add_block": {
        const block = homeBlockFrom(change.section, state.config.sections, context);
        if (!block) {
          notes.push("That kind of section is not available on the homepage, so it was left out.");
          return state;
        }
        const sections = [...state.config.sections];
        sections.splice(Math.min(change.index, sections.length), 0, block);
        return { ...state, config: parseConfig({ ...state.config, sections }, state.config) };
      }
      case "home_block_update": {
        const target = state.config.sections.find((section) => section.id === change.sectionId);
        if (!target) throw new PageBuildError("unknown_section", `There is no homepage section "${change.sectionId}".`);
        if (target.type !== "block") throw new PageBuildError("unsupported_field", "That homepage section fills itself from your store's data. Its heading can be changed, but it has no text of its own.");
        const block = updateSectionText(target.block, change.set, context);
        return { ...state, config: parseConfig({ ...state.config, sections: state.config.sections.map((section) => (section.id === target.id ? { ...target, block } : section)) }, state.config) };
      }
      case "home_featured": {
        const chosen = productIdsFrom(change.products, context);
        if (chosen.length === 0) {
          notes.push("None of the suggested products are available, so the product collection was left as it is.");
          return state;
        }
        const target = change.sectionId ? state.config.sections.find((section) => section.id === change.sectionId) : undefined;
        if (change.sectionId && target?.type !== "featured") throw new PageBuildError("unknown_section", "That homepage section is not a product collection.");
        const sections = [...state.config.sections];
        const base = target ?? createHomeSection("featured", sections);
        const next = homeSectionSchema.parse({ ...base, productIds: chosen, ...(change.title !== undefined ? { title: change.title } : {}) });
        if (target) sections[sections.indexOf(target)] = next;
        else sections.splice(Math.min(change.index ?? sections.length, sections.length), 0, next);
        return { ...state, config: parseConfig({ ...state.config, sections }, state.config) };
      }
      case "page_edit": {
        const page = findPage(state, change.path);
        if (change.changes.length === 0) return state;
        const edited = buildDraftCopyAction(
          { id: page.id ?? "000000000000000000000000", version: page.version, title: page.title, slug: page.slug, sections: page.sections },
          { summary: revision.summary, changes: change.changes, notes: [] },
          { ...context, existingSlugs: new Set() },
        );
        replacePage({ ...page, sections: edited.sections, aiWritten: true });
        return state;
      }
      case "page_add_section": {
        const page = findPage(state, change.path);
        const sections = [...page.sections].sort((a, b) => a.order - b.order);
        const [built] = buildSections([change.section], context, new Set(sections.map((section) => section.id)));
        sections.splice(Math.min(change.index, sections.length), 0, built);
        replacePage({ ...page, sections: sections.map((section, order) => ({ ...section, order })) as Section[], aiWritten: true });
        return state;
      }
      case "page_create": {
        const slug = uniquePageSlug(change.title, new Set(state.pages.map((page) => page.slug)));
        const page = newPage({ title: change.title, slug, description: change.description, seoTitle: change.seoTitle, seoDescription: change.seoDescription, sections: buildSections(change.sections, context) });
        return { ...state, pages: [...state.pages, page], navigation: withMenuLinks(state.navigation, [{ page, nav: change.nav }]) };
      }
      case "page_seo": {
        const page = findPage(state, change.path);
        replacePage({ ...page, ...(change.seoTitle !== undefined ? { seoTitle: change.seoTitle } : {}), ...(change.seoDescription !== undefined ? { seoDescription: change.seoDescription } : {}), ...(change.description !== undefined ? { description: change.description } : {}) });
        return state;
      }
      case "seo_home":
        return { ...state, config: parseConfig({ ...state.config, seo: { ...state.config.seo, ...(change.seoTitle !== undefined ? { title: change.seoTitle } : {}), ...(change.seoDescription !== undefined ? { description: change.seoDescription } : {}) } }, state.config) };
      case "design": {
        const themeId = change.themeId ? chooseTheme(change.themeId, state.design.themeId, ctx, notes) : state.design.themeId;
        return { ...state, design: applyDesignChoices(state.design, themeId, change.set, notes) };
      }
      case "header":
        return { ...state, config: parseConfig({ ...state.config, header: { ...state.config.header, ...change.set } }, state.config) };
      case "footer":
        return { ...state, config: withFooter(state.config, change.set, context) };
      case "announcement":
        return { ...state, config: parseConfig({ ...state.config, announcement: { ...state.config.announcement, ...change.set, ...(change.set.href && !context.links.includes(change.set.href) ? { href: "" } : {}) } }, state.config) };
      case "menu": {
        const items = change.items.flatMap((item, order): WebsiteNavItem[] => {
          const page = item.target.startsWith("/") ? state.pages.find((candidate) => candidate.slug === pathToSlug(item.target) && !candidate.isHome) : undefined;
          if (page) return [{ pageSlug: page.slug, label: item.label, order, ...(item.showOn ? { showOn: item.showOn } : {}) }];
          // Only real store links: a link that leads nowhere is left out.
          return context.links.includes(item.target.split("#")[0]) ? [{ href: item.target, label: item.label, order, ...(item.showOn ? { showOn: item.showOn } : {}) }] : [];
        });
        return { ...state, navigation: { ...state.navigation, [change.area]: items } };
      }
      case "responsive": {
        if (pathToSlug(change.path) === "" || change.path.trim() === "/") {
          const sections = state.config.sections.map((section) => (section.id === change.sectionId ? { ...section, responsive: withResponsiveHome(section.responsive, change.device, change.rule) } : section));
          if (!state.config.sections.some((section) => section.id === change.sectionId)) throw new PageBuildError("unknown_section", `There is no homepage section "${change.sectionId}".`);
          return { ...state, config: parseConfig({ ...state.config, sections }, state.config) };
        }
        const page = findPage(state, change.path);
        if (!page.sections.some((section) => section.id === change.sectionId)) throw new PageBuildError("unknown_section", `There is no section "${change.sectionId}" on this page.`);
        replacePage({
          ...page,
          sections: page.sections.map((section) => {
            if (section.id !== change.sectionId) return section;
            const parsed = sectionSchema.safeParse({ ...section, style: { ...section.style, responsive: withResponsive(section, change.device, change.rule) } });
            if (!parsed.success) throw new PageBuildError("invalid_result", "That screen size setting does not fit this section.");
            return parsed.data;
          }),
        });
        return state;
      }
    }
  }
}

function withResponsiveHome(settings: ResponsiveSettings | undefined, device: "desktop" | "tablet" | "mobile", rule: ResponsiveRule): ResponsiveSettings | undefined {
  return withResponsive({ style: { responsive: settings } }, device, rule);
}
