/**
 * What an owner's AI Builder request is about (pure; no I/O, no AI call).
 *
 * The AI Builder routes each request to ONE structured task, each with its
 * own validated output schema: a homepage change set, a page proposal, SEO
 * suggestions, a theme recommendation or product copy. Deciding the task
 * deterministically (keywords plus what the owner has selected) costs nothing,
 * is predictable, and is shown to the owner ("Understood as: ...") before
 * anything is sent, so they can correct it. The provider is never asked to
 * pick a task, so it can never escalate a request into another kind of write.
 */

export const AI_BUILDER_MODES = ["homepage", "section", "page", "seo", "theme", "product"] as const;
export type AiBuilderMode = (typeof AI_BUILDER_MODES)[number];

/** What kind of change the request describes, within its mode. */
export type AiChangeKind = "content" | "layout" | "new-section" | "section-edit" | "new-page" | "page-edit" | "seo" | "theme" | "product-copy" | "style";

export interface AiIntent {
  mode: AiBuilderMode;
  kind: AiChangeKind;
  /** Owner-facing explanation ("Understood as: a new page"). */
  label: string;
  /** A page type named in the request ("about", "faq", ...), when any. */
  pageType: PageType | null;
}

export const PAGE_TYPES = ["about", "contact", "faq", "brand-story", "shipping", "returns", "store-info", "custom"] as const;
export type PageType = (typeof PAGE_TYPES)[number];

const has = (text: string, pattern: RegExp) => pattern.test(text);

const PAGE_TYPE_PATTERNS: Array<[PageType, RegExp]> = [
  ["about", /\babout(\s+us|\s+page)?\b|\bwho we are\b|\bintroduction\b|\bintro\b/],
  ["brand-story", /\bbrand story\b|\bour story\b|\bstory page\b/],
  ["contact", /\bcontact\b/],
  ["faq", /\bfaqs?\b|\bfrequently asked\b|\bquestions page\b/],
  ["shipping", /\bshipping\b|\bdelivery (information|info|page)\b/],
  ["returns", /\breturns?\b|\brefunds?\b/],
  ["store-info", /\bstore (information|info|hours|details)\b|\bopening hours\b|\bvisit us\b/],
];

/** The page type a request names, if any. */
export function pageTypeOf(text: string): PageType | null {
  const t = text.toLowerCase();
  for (const [type, pattern] of PAGE_TYPE_PATTERNS) if (pattern.test(t)) return type;
  return null;
}

/** Something smaller than a website that a request may be about ("an about page for my website"). */
const PART_OF_A_WEBSITE =
  /\b(page|section|banner|block|menu|header|footer|hero|button|product|description|seo|theme|colou?r|font|logo|text|copy|blog|post|article|faq|polic(y|ie)|announcement|newsletter|image|picture|photo|link|selling)s?\b/;

/**
 * Whether the owner asks for a whole website ("create a website for my bakery",
 * "build my online store with all the pages"). Pure keywords, like the rest of
 * this file: the AI never decides it. A request about one part of a website
 * ("add an FAQ page to my website") is not one.
 */
export function asksForWholeWebsite(text: string): boolean {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  // "make my website darker" is a change, so "make" counts only as "make (me) a/an/new ...".
  const create = "(?:\\b(?:create|build|generate|design|set up|setup|start|launch|write)\\b|\\bmake(?: me| us)? (?:a|an|new)\\b)";
  if (new RegExp(`${create}.{0,40}?\\b(?:all|every)(?: of)?(?: the| my)? (?:web ?)?pages\\b`).test(t)) return true;
  // Group 1 is what comes between the verb and "website": "an FAQ page for my" is about a part.
  const match = new RegExp(`${create}(.{0,60}?)\\b(?:web ?site|site|online (?:store|shop)|e-?commerce store)\\b`).exec(t);
  return match !== null && !PART_OF_A_WEBSITE.test(match[1] ?? "");
}

/**
 * Classifies a request. `context` is what the owner has selected: a content
 * page (`pageId`), a product, or nothing (the store / homepage).
 */
export function classifyAiRequest(text: string, context: { pageSelected?: boolean; productSelected?: boolean } = {}): AiIntent {
  const t = text.toLowerCase();
  const pageType = pageTypeOf(t);

  if (has(t, /\btheme\b|\bvisual direction\b|\b(aurora|market|bistro|studio|launch|atelier|volt|harvest|forma)\b.*\b(or|vs|versus)\b|\bwhich (design|look)\b/)) {
    return { mode: "theme", kind: "theme", label: "A theme recommendation", pageType: null };
  }
  if (has(t, /\bseo\b|\bsearch engines?\b|\bgoogle\b|\bmeta (title|description)s?\b|\bpage titles?\b|\balt text\b/)) {
    return { mode: "seo", kind: "seo", label: "Search engine (SEO) suggestions", pageType };
  }
  if (context.productSelected || has(t, /\bproduct (description|copy|text|highlights?|features?)s?\b|\bdescriptions? (for|of) (my|this|the) products?\b|\bthis description\b/)) {
    return { mode: "product", kind: "product-copy", label: "Product description suggestions", pageType: null };
  }
  const wantsNewPage = has(t, /\b(create|make|add|write|build|generate|set up)\b[^.]{0,40}\bpage\b/) || (pageType !== null && has(t, /\b(create|write|build|generate|set up)\b/) && !has(t, /\bsection\b/));
  if (wantsNewPage) {
    return { mode: "page", kind: "new-page", label: "A new page", pageType: pageType ?? "custom" };
  }
  if (context.pageSelected || (pageType !== null && has(t, /\b(improve|rewrite|update|edit|change|shorten|expand)\b/))) {
    const section = has(t, /\b(add|create|insert)\b[^.]{0,40}\bsection\b/);
    return { mode: "page", kind: section ? "new-section" : "page-edit", label: section ? "A new section on this page" : "Changes to this page", pageType };
  }
  if (has(t, /\b(add|create|insert|build)\b[^.]{0,40}\b(section|banner|showcase|collection|block)\b|\bsection\b/)) {
    const edit = has(t, /\b(improve|rewrite|change|update|edit)\b/) && !has(t, /\b(add|create|insert|build)\b/);
    return { mode: "section", kind: edit ? "section-edit" : "new-section", label: edit ? "Changes to a homepage section" : "A new homepage section", pageType: null };
  }
  if (has(t, /\b(move|reorder|above|below|layout|order|first|before|after)\b/)) {
    return { mode: "homepage", kind: "layout", label: "A homepage layout change", pageType: null };
  }
  if (has(t, /\b(colou?rs?|fonts?|typography|palette|black and gold|darker|lighter)\b/)) {
    return { mode: "homepage", kind: "style", label: "Brand colours or font", pageType: null };
  }
  return { mode: "homepage", kind: "content", label: "Homepage content and design", pageType: null };
}

/** Owner-facing name of each mode (chips, history). */
export const AI_MODE_LABELS: Record<AiBuilderMode, string> = {
  homepage: "Homepage",
  section: "Section",
  page: "Page",
  seo: "SEO",
  theme: "Theme",
  product: "Products",
};
