import { generateSectionId, sectionSchema, type Section } from "./sections";
import { HOME_BLOCK_TYPES, SINGLE_INSTANCE_TYPES, createHomeSection, homeSectionSchema, type HomeSection, type HomeSectionType } from "./storefront-config";

/**
 * Ready-made sections an owner can drop into a page (pure; safe in client components). To add
 * one, add an entry to SECTION_TEMPLATES. They are ordinary sections once inserted: every theme
 * renders them its own way, and they can be edited, duplicated and removed like any other.
 *
 * A template never supplies wording of its own. Text the owner must write is a [[placeholder]],
 * and publishing is refused while a visible section still holds one (`findVisiblePlaceholders`),
 * so nothing from here can reach a store by accident. Sections filled from the store's real data
 * (products, reviews) only carry a plain heading, and stay hidden until they have something to show.
 */
export type TemplateGroup = "Introductions" | "Products" | "About you" | "Trust" | "Get in touch";
export const TEMPLATE_GROUPS: readonly TemplateGroup[] = ["Introductions", "Products", "About you", "Trust", "Get in touch"];

/** The small drawing beside a template in the library. */
export type TemplateThumb = "hero" | "split" | "grid" | "banner" | "quotes" | "people" | "cards" | "numbers" | "list" | "form" | "logos" | "centered";

/** Where a template goes on the store homepage, which has its own kinds of section. */
type HomeTarget = { kind: "block" } | { kind: "hero" } | { kind: "native"; type: HomeSectionType; fields?: Record<string, unknown> };

export interface SectionTemplate {
  key: string;
  label: string;
  description: string;
  group: TemplateGroup;
  thumb: TemplateThumb;
  /** The section's settings, without an id or an order. */
  section: { type: Section["type"]; settings: Record<string, unknown> };
  home: HomeTarget;
}

const ph = (what: string) => `[[${what}]]`;
const repeat = <T,>(count: number, make: (n: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i + 1));

export const SECTION_TEMPLATES: readonly SectionTemplate[] = [
  {
    key: "hero-banner",
    label: "Hero banner",
    description: "A large opening with a headline, a line of text, a picture and a button.",
    group: "Introductions",
    thumb: "hero",
    section: { type: "hero", settings: { headline: ph("Your main headline"), subheadline: ph("One line about what you offer"), ctaText: ph("Button text") } },
    home: { kind: "hero" },
  },
  {
    key: "image-text",
    label: "Image and text",
    description: "A picture beside your text, on either side, with an optional button.",
    group: "Introductions",
    thumb: "split",
    section: { type: "imageText", settings: { title: ph("A heading"), body: ph("Tell people about this in a few sentences"), imageSide: "right" } },
    home: { kind: "block" },
  },
  {
    key: "call-to-action",
    label: "Call to action",
    description: "One clear message and a button that takes people to the next step.",
    group: "Introductions",
    thumb: "centered",
    section: { type: "cta", settings: { headline: ph("What should people do next?"), buttonText: ph("Button text") } },
    home: { kind: "block" },
  },
  {
    key: "promotional-banner",
    label: "Promotional banner",
    description: "A banner for an offer or some news, with your own text and link.",
    group: "Introductions",
    thumb: "banner",
    section: { type: "cta", settings: { headline: ph("Your offer or news"), buttonText: ph("Button text") } },
    home: { kind: "native", type: "promotions", fields: { items: [{ title: ph("Your offer or news"), text: ph("A short line about it") }] } },
  },
  {
    key: "featured-products",
    label: "Featured products",
    description: "Products from your catalog. It shows only products you really have.",
    group: "Products",
    thumb: "grid",
    section: { type: "products", settings: { title: "Featured products", columns: "3", limit: 6 } },
    home: { kind: "native", type: "featured" },
  },
  {
    key: "product-collection",
    label: "Product collection",
    description: "Your newest products. Choose a category or reduced prices in its settings.",
    group: "Products",
    thumb: "grid",
    section: { type: "products", settings: { title: "New arrivals", columns: "4", collection: "new", limit: 8 } },
    home: { kind: "native", type: "newArrivals" },
  },
  {
    key: "about",
    label: "About section",
    description: "Your story, with an optional picture.",
    group: "About you",
    thumb: "split",
    section: { type: "about", settings: { title: ph("About us"), body: ph("Who you are, what you do and why") } },
    home: { kind: "native", type: "story" },
  },
  {
    key: "team",
    label: "Team",
    description: "The people behind your business, with photos and roles.",
    group: "About you",
    thumb: "people",
    section: { type: "team", settings: { title: ph("Meet the team"), items: repeat(3, (n) => ({ name: ph(`Person ${n}`), role: ph("Their role") })) } },
    home: { kind: "block" },
  },
  {
    key: "services",
    label: "Services",
    description: "What you offer, each with a short description.",
    group: "About you",
    thumb: "cards",
    section: { type: "features", settings: { title: ph("Our services"), items: repeat(3, (n) => ({ title: ph(`Service ${n}`), description: ph("What it includes") })) } },
    home: { kind: "block" },
  },
  {
    key: "features",
    label: "Features",
    description: "The things that make you different, in short blocks.",
    group: "About you",
    thumb: "cards",
    section: { type: "features", settings: { title: ph("Why choose us"), items: repeat(3, (n) => ({ title: ph(`Reason ${n}`), description: ph("A sentence about it") })) } },
    home: { kind: "block" },
  },
  {
    key: "statistics",
    label: "Statistics",
    description: "A few numbers you can stand behind.",
    group: "Trust",
    thumb: "numbers",
    section: { type: "stats", settings: { title: ph("A heading"), items: repeat(3, () => ({ value: ph("Number"), label: ph("What it counts") })) } },
    home: { kind: "block" },
  },
  {
    key: "testimonials",
    label: "Testimonials",
    description: "Quotes you have collected from real customers, in your own words.",
    group: "Trust",
    thumb: "quotes",
    section: { type: "testimonials", settings: { title: ph("A heading"), items: repeat(2, () => ({ quote: ph("What the customer said"), name: ph("Their name") })) } },
    home: { kind: "block" },
  },
  {
    key: "customer-reviews",
    label: "Customer reviews",
    description: "Reviews you have approved from real orders. It stays hidden until there are some.",
    group: "Trust",
    thumb: "quotes",
    section: { type: "reviews", settings: { title: "Customer reviews", limit: 6 } },
    home: { kind: "block" },
  },
  {
    key: "logos",
    label: "Logo collection",
    description: "Partner, client or press logos in a row.",
    group: "Trust",
    thumb: "logos",
    section: { type: "logos", settings: { title: ph("A heading"), items: [] } },
    home: { kind: "block" },
  },
  {
    key: "faq",
    label: "Frequently asked questions",
    description: "Questions and answers people can open one at a time.",
    group: "Get in touch",
    thumb: "list",
    section: { type: "faq", settings: { title: ph("Questions and answers"), items: repeat(3, (n) => ({ question: ph(`Question ${n}`), answer: ph("Its answer") })) } },
    home: { kind: "block" },
  },
  {
    key: "contact",
    label: "Contact",
    description: "How to reach you. Add your details in its settings.",
    group: "Get in touch",
    thumb: "form",
    section: { type: "contact", settings: { title: ph("Get in touch"), description: ph("When and how people can reach you") } },
    home: { kind: "block" },
  },
  {
    key: "newsletter",
    label: "Newsletter",
    description: "Invite people to hear from you, with a button that links where they sign up.",
    group: "Get in touch",
    thumb: "form",
    section: { type: "newsletter", settings: { headline: ph("Stay in touch"), description: ph("What people will get"), buttonText: ph("Button text") } },
    home: { kind: "block" },
  },
];

export const sectionTemplate = (key: string) => SECTION_TEMPLATES.find((template) => template.key === key) ?? null;

/** A template as a section for a content page. The settings are copied, so each insert stands alone. */
export function sectionFromTemplate(template: SectionTemplate, order: number): Section {
  return sectionSchema.parse({ id: generateSectionId(template.section.type), order, visible: true, type: template.section.type, settings: structuredClone(template.section.settings) });
}

export type HomeTemplateResult = { kind: "hero" } | { kind: "section"; section: HomeSection } | { kind: "blocked"; reason: string };

/** A template as a homepage section. The homepage has one hero, so that one opens the hero's settings. */
export function homeSectionFromTemplate(template: SectionTemplate, existing: ReadonlyArray<{ id: string; type: string }>): HomeTemplateResult {
  const target = template.home;
  if (target.kind === "hero") return { kind: "hero" };
  if (target.kind === "native") {
    if (SINGLE_INSTANCE_TYPES.includes(target.type) && existing.some((section) => section.type === target.type)) return { kind: "blocked", reason: "already on the page" };
    const base = createHomeSection(target.type, existing);
    return { kind: "section", section: homeSectionSchema.parse({ ...base, ...structuredClone(target.fields ?? {}) }) };
  }
  if (!(HOME_BLOCK_TYPES as readonly string[]).includes(template.section.type)) return { kind: "blocked", reason: "not available on the homepage" };
  const base = createHomeSection("block", existing, template.section.type as (typeof HOME_BLOCK_TYPES)[number]);
  return { kind: "section", section: homeSectionSchema.parse({ ...base, block: sectionFromTemplate(template, 0) }) };
}
