import { HttpError } from "@/lib/api";
import { HOME_SECTION_LABELS, type StorefrontConfig } from "@/lib/storefront-config";

/**
 * The ONLY way store data becomes AI provider input (Google Gemini).
 *
 * Approved categories (owner decision, docs/ai-website-builder-plan.md): the
 * business name and type, its description, the selected theme, the
 * storefront configuration and homepage sections, this store's page titles,
 * descriptions and section text, and product titles, descriptions, categories
 * and option attributes (e.g. Size: S, M, L).
 *
 * Never sent: customers, orders, payments or payment credentials, accounts,
 * sessions, tokens, passwords or other secrets, contact details, prices,
 * stock, SKUs, or anything else not listed above.
 *
 * Three layers:
 * 1. ALLOWLIST: the builders below copy only approved fields into new objects
 *    (nothing is passed through by reference or by spreading a document).
 * 2. REDACTION: every free-text value is scrubbed of email addresses, phone
 *    numbers, long digit runs (card or account numbers), credentialed links
 *    and secret-looking strings an owner might have typed into a text. The
 *    business's saved contact details are removed by value (`withoutKnownContact`).
 * 3. FINAL CHECK: `assertProviderPayloadSafe` and `assertNoKnownContact` refuse
 *    to send a request whose complete text still contains any of those.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** "+" numbers, or runs of 9+ digits with common separators (phones, card/account numbers). */
const PHONE_OR_NUMBER = /\+\d[\d\s().-]{6,}\d|\b\d(?:[\s().-]?\d){8,}\b/g;
const SECRETS: RegExp[] = [
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, // API secret keys
  /\brzp_(?:live|test)_[A-Za-z0-9]{6,}\b/g, // Razorpay key ids
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, // JWTs (sessions, tokens)
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{50,60}/g, // bcrypt password hashes
  /\b[a-f0-9]{32,}\b/gi, // long hex tokens and digests
  /https?:\/\/[^\s"]*[?&](?:token|key|sig|signature|auth|session|password|secret)=[^\s"]*/gi, // credentialed links
];

/** Scrubs personal and secret-looking data from one owner-written text and bounds its length. */
export function redactText(value: unknown, max = 2000): string {
  if (typeof value !== "string") return "";
  let text = value;
  for (const pattern of SECRETS) text = text.replace(pattern, "[removed]");
  text = text.replace(EMAIL, "[email removed]").replace(PHONE_OR_NUMBER, "[number removed]");
  return text.slice(0, max);
}

/** Finds data that must never reach the provider (used on the complete outgoing text). */
export function findSensitiveData(text: string): string[] {
  const found: string[] = [];
  for (const [kind, pattern] of [["email", EMAIL], ["number", PHONE_OR_NUMBER], ...SECRETS.map((p) => ["secret", p] as const)] as const) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) found.push(kind);
    pattern.lastIndex = 0;
  }
  return [...new Set(found)];
}

/**
 * Last line of defence before ANY provider request: refuses (nothing is sent)
 * when the outgoing text contains personal or secret-looking data.
 */
export function assertProviderPayloadSafe(...parts: string[]): void {
  const found = findSensitiveData(parts.join("\n"));
  if (found.length > 0) {
    // Kinds only: the matched text itself is never logged.
    console.error(`[ai-builder] payload refused kinds=${found.join(",")}`);
    throw new HttpError(422, "This request contained personal or secret information, so nothing was sent to the AI provider. Remove it and try again.", "unsafe_content");
  }
}

/** Shorter values are too likely to be ordinary words. */
const MIN_KNOWN_CONTACT_LENGTH = 4;
/** The final check also reads labels and catalogue text, so only longer values count there. */
const MIN_FINAL_CHECK_LENGTH = 8;
/** Identifiers and fixed choices, not text. */
const STRUCTURAL_KEYS = new Set(["id", "type", "selectedSectionId", "preferredTheme", "productIds", "knownContact"]);

/** The business's saved email, phone number and address. */
export function knownContactOf(business: { contactEmail?: unknown; phone?: unknown; address?: unknown }): unknown[] {
  return [business.contactEmail, business.phone, business.address];
}

/** Each value as whole words; case and spacing are ignored. */
function knownContactPatterns(known: readonly unknown[], minLength: number): RegExp[] {
  return known.flatMap((item) => {
    const words = typeof item === "string" ? item.trim().split(/\s+/).filter(Boolean) : [];
    if (words.join(" ").length < minLength) return [];
    const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("\\s+");
    return [new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "giu")];
  });
}

/**
 * Removes the store's saved contact details from text, by value: a street
 * address has no pattern `redactText` could recognise. Goes through every
 * string in `value`, before any text is shortened. An address worded differently
 * cannot be detected, which the consent disclosure tells the owner.
 */
export function withoutKnownContact<T>(value: T, known: readonly unknown[] = []): T {
  const patterns = knownContactPatterns(known, MIN_KNOWN_CONTACT_LENGTH);
  if (patterns.length === 0) return value;
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") return patterns.reduce((text, pattern) => text.replace(pattern, "[contact details removed]"), input);
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, STRUCTURAL_KEYS.has(key) ? item : scrub(item)]));
    }
    return input;
  };
  return scrub(value) as T;
}

/** Final check for saved contact details, on the complete prompt (nothing is sent if it fails). */
export function assertNoKnownContact(prompt: string, known: readonly unknown[]): void {
  // Prompts hold JSON: read line breaks and escaped characters as plain text.
  const text = prompt.replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\u003c/g, "<").replace(/\\u003e/g, ">");
  if (knownContactPatterns(known, MIN_FINAL_CHECK_LENGTH).some((pattern) => pattern.test(text))) {
    console.error("[ai-builder] payload refused kinds=contact");
    throw new HttpError(422, "This request contained personal or secret information, so nothing was sent to the AI provider. Remove it and try again.", "unsafe_content");
  }
}

export interface SafeBusiness {
  name: string;
  type: string;
  description: string;
}

export function safeBusiness(input: { name?: unknown; type?: unknown; description?: unknown }): SafeBusiness {
  return { name: redactText(input.name, 140), type: redactText(input.type, 80), description: redactText(input.description, 2000) };
}

export function safeTheme(input: { id: string; name: string }): { id: string; name: string } {
  return { id: redactText(input.id, 40), name: redactText(input.name, 80) };
}

export function safeBrand(input: { primaryColor: string; accentColor: string; font: string }) {
  const hex = (v: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : "");
  return { primaryColor: hex(input.primaryColor), accentColor: hex(input.accentColor), font: ["sans", "serif", "mono"].includes(input.font) ? input.font : "sans" };
}

const safeLink = (href: unknown) => (typeof href === "string" && /^\/(?!\/)[A-Za-z0-9\-._~/?=&%+]*$/.test(href) && findSensitiveData(href).length === 0 ? href.slice(0, 200) : "");

/** The homepage as the provider sees it: text, structure and appearance only (no image URLs, no product ids). */
export function safeHomepage(config: StorefrontConfig) {
  const cta = (c: { label: string; href: string }) => ({ label: redactText(c.label, 40), href: safeLink(c.href) });
  return {
    announcement: { enabled: config.announcement.enabled, text: redactText(config.announcement.text, 140), href: safeLink(config.announcement.href) },
    hero: {
      enabled: config.hero.enabled,
      eyebrow: redactText(config.hero.eyebrow, 60),
      headline: redactText(config.hero.headline, 120),
      description: redactText(config.hero.description, 300),
      align: config.hero.align,
      overlay: config.hero.overlay,
      hasImage: Boolean(config.hero.imageUrl),
      primaryCta: cta(config.hero.primaryCta),
      secondaryCta: cta(config.hero.secondaryCta),
    },
    sections: config.sections.map((s, index) => ({
      position: index,
      id: s.id,
      type: s.type,
      typeName: HOME_SECTION_LABELS[s.type],
      enabled: s.enabled,
      title: redactText(s.title, 80),
      subtitle: redactText(s.subtitle, 160),
      appearance: { background: s.appearance.background, spacing: s.appearance.spacing, align: s.appearance.align },
      ...("limit" in s ? { limit: s.limit } : {}),
      ...(s.type === "story" ? { text: redactText(s.text, 2000) } : {}),
      ...(s.type === "block" ? { content: safePageSections([s.block])[0] } : {}),
    })),
    footerAbout: redactText(config.footer.about, 400),
  };
}

export interface SafeProduct {
  name: string;
  category: string;
  description: string;
  /** Option attributes the owner entered (e.g. Size: S, M, L). */
  attributes: Array<{ name: string; values: string[] }>;
}

export function safeProduct(input: { name?: unknown; category?: unknown; description?: unknown; options?: unknown }): SafeProduct {
  const options = Array.isArray(input.options) ? input.options : [];
  return {
    name: redactText(input.name, 160),
    category: redactText(input.category, 80),
    description: redactText(input.description, 4000),
    attributes: options.slice(0, 5).map((o) => {
      const option = (o ?? {}) as { name?: unknown; values?: unknown };
      return { name: redactText(option.name, 40), values: (Array.isArray(option.values) ? option.values : []).slice(0, 20).map((v) => redactText(v, 40)) };
    }),
  };
}

/** Product titles and categories only (for homepage suggestions). */
export function safeCatalog(products: Array<{ name?: unknown; category?: unknown }>, limit = 40) {
  return products.slice(0, limit).map((p) => ({ name: redactText(p.name, 160), category: redactText(p.category, 80) }));
}

/** Internal store links the suggestion may use (paths only). */
export function safeLinks(links: string[], limit = 80): string[] {
  return [...new Set(links.map(safeLink).filter(Boolean))].slice(0, limit);
}

/** The owner's request: their own words, scrubbed like any other text. */
export function safeRequest(text: string, max = 500): string {
  return redactText(text, max);
}

/** Product category names (for page and SEO suggestions). */
export function safeCategoryNames(names: unknown[], limit = 40): string[] {
  return [...new Set(names.map((n) => redactText(n, 80)).filter(Boolean))].slice(0, limit);
}

/** The store's pages as a list (titles and paths only). */
export function safePageList(pages: Array<{ title?: unknown; slug?: unknown; status?: unknown }>, limit = 50) {
  return pages.slice(0, limit).map((p) => ({ title: redactText(p.title, 140), path: safeLink(`/${String(p.slug ?? "")}`), status: p.status === "published" ? "published" : "draft" }));
}

/**
 * One page's sections as the provider sees them: ids, types and their TEXT
 * fields only. Never images or media URLs, styles, or the contact section's
 * email, phone and address (those come from the business settings, and are
 * also removed if repeated in another section's text).
 */
export function safePageSections(sections: unknown[], limit = 30) {
  const str = (v: unknown, max: number) => redactText(v, max);
  const sent = sections.slice(0, limit);
  const typedContact = sent.flatMap((raw) => {
    const s = (raw ?? {}) as { type?: unknown; settings?: Record<string, unknown> };
    return s.type === "contact" ? [s.settings?.email, s.settings?.phone, s.settings?.address] : [];
  });
  const safe = sent.map((raw) => {
    const s = (raw ?? {}) as { id?: unknown; type?: unknown; visible?: unknown; settings?: Record<string, unknown> };
    const st = s.settings ?? {};
    const items = Array.isArray(st.items)
      ? (st.items as Array<Record<string, unknown>>).slice(0, 20).map((i) =>
          "question" in (i ?? {}) ? { question: str(i.question, 200), answer: str(i.answer, 2000) } : "title" in (i ?? {}) ? { title: str(i.title, 160), ...(typeof i.description === "string" ? { description: str(i.description, 600) } : {}) } : {},
        )
      : undefined;
    const text: Record<string, unknown> = {};
    for (const key of ["title", "headline", "subheadline", "body", "ctaText", "buttonText", "description", "text", "category", "collection", "caption"]) {
      if (typeof st[key] === "string" && st[key]) text[key] = str(st[key], key === "body" ? 4000 : 500);
    }
    if (s.type === "contact") delete text.description; // may hold contact details typed by the owner
    return { id: str(s.id, 64), type: str(s.type, 20), visible: s.visible !== false, ...text, ...(items ? { items } : {}) };
  });
  return withoutKnownContact(safe, typedContact);
}
