import { formatPrice } from "./format";
import { presetForBusinessType, storeVocabulary } from "./storefront-presets";
import type { Section } from "./sections";
import { RESERVED_PAGE_SLUGS } from "./validation";

/**
 * Default website pages for a business (pure, deterministic; no AI needed).
 *
 * Rules (docs/theme-marketplace-and-pages.md, "Default pages"):
 * - Pages depend on the business type, and on REAL store data: a category
 *   page exists only for a real product category, "Offers" only when a
 *   product has a real compare-at price, "New arrivals" only with products.
 * - Text uses only the owner's own data (name, description, contact details,
 *   shipping settings, policy text, payment options). Anything the platform
 *   cannot know is a visible placeholder `[[ ... ]]`; a page with placeholders
 *   cannot be published until the owner replaces them.
 * - Policy and legal pages are templates, not legal advice, and need the
 *   owner's explicit review before publishing (`needsReview`).
 * - Every page is created as a DRAFT. The home page is never generated (the
 *   store homepage is edited in the homepage editor); "Shop" is the built-in
 *   catalog at /products.
 */

export type PageFamily = "general" | "fashion" | "tech" | "grocery" | "home" | "restaurant" | "beauty" | "services" | "realestate" | "fitness" | "education" | "creative" | "wellness";

export const PAGE_FAMILY_LABELS: Record<PageFamily, string> = {
  general: "General retail",
  fashion: "Clothing and fashion",
  tech: "Electronics",
  grocery: "Grocery",
  home: "Furniture and home",
  restaurant: "Restaurant and food",
  beauty: "Cosmetics and personal care",
  services: "Professional services",
  realestate: "Real estate",
  fitness: "Fitness and sports",
  education: "Education and training",
  creative: "Creative and events",
  wellness: "Beauty and wellness",
};

/**
 * Businesses that offer services rather than ship goods: their product list is
 * shown under the right name, and there are no delivery, returns or "new
 * arrivals" pages. Everything the platform cannot know stays a placeholder.
 */
interface ServicePlan {
  list: { key: string; title: string; heading: string; reason: string };
  book: { question: string; placeholder: string };
  pages: (contact: string) => Array<{ key: string; title: string; description: string; reason: string; body: Array<string | false> }>;
}

const SERVICE_PLANS: Partial<Record<PageFamily, ServicePlan>> = {
  services: {
    list: { key: "services", title: "Services", heading: "Our services", reason: "Lists what you offer, from your product list." },
    book: { question: "How do I get started?", placeholder: "Explain the first step: a call, an email or a quote" },
    pages: (contact) => [
      { key: "how-we-work", title: "How we work", description: "Your process, step by step.", reason: "Clients want to know what happens after they get in touch.", body: [ph("Describe your process from the first conversation to the finished work, in a few short steps"), ph("Say who you usually work with")] },
      { key: "request-a-quote", title: "Request a quote", description: "How clients ask for a quote (no form is connected).", reason: "SiteForge has no quote form: this page explains how to reach you.", body: ["Tell us what you need and we will get back to you.", contact, ph("Say what details you need to give a quote")] },
    ],
  },
  realestate: {
    list: { key: "listings", title: "Listings", heading: "Current listings", reason: "Lists your properties, from your product list." },
    book: { question: "How do I arrange a viewing?", placeholder: "Explain how to book a viewing" },
    pages: (contact) => [
      { key: "book-a-viewing", title: "Book a viewing", description: "How buyers and tenants arrange a viewing (no booking system is connected).", reason: "SiteForge has no booking system: this page explains how to reach you.", body: ["Found a property you would like to see?", contact, ph("Say when viewings are available and what to bring")] },
      { key: "sell-with-us", title: "Sell with us", description: "What you offer property owners.", reason: "Owners look for this before contacting an agent.", body: [ph("Describe how you help owners sell or let their property, and your fees if you share them"), contact] },
    ],
  },
  fitness: {
    list: { key: "programs", title: "Programs", heading: "Programs and memberships", reason: "Lists what you offer, from your product list." },
    book: { question: "How do I join?", placeholder: "Explain how to join or book a first session" },
    pages: (contact) => [
      { key: "timetable", title: "Timetable", description: "Your class or opening times.", reason: "Members look for this first.", body: [ph("Add your class times or opening hours")] },
      { key: "membership", title: "Membership", description: "How membership works.", reason: "Explains how people join.", body: [ph("Explain your membership options, what is included and how to cancel"), contact] },
    ],
  },
  education: {
    list: { key: "courses", title: "Courses", heading: "Our courses", reason: "Lists your courses, from your product list." },
    book: { question: "How do I enrol?", placeholder: "Explain how to enrol and when courses start" },
    pages: (contact) => [
      { key: "admissions", title: "Admissions", description: "How to enrol.", reason: "Students and parents look for this first.", body: [ph("Explain who can enrol, how to apply and the important dates"), contact] },
      { key: "teachers", title: "Our teachers", description: "Who teaches here.", reason: "Students want to know who they will learn from.", body: [ph("Introduce your teachers and their experience")] },
    ],
  },
  creative: {
    list: { key: "packages", title: "Packages", heading: "Our packages", reason: "Lists what you offer, from your product list." },
    book: { question: "How do I book you?", placeholder: "Explain how to book and how far ahead" },
    pages: (contact) => [
      { key: "our-work", title: "Our work", description: "Examples of what you have made.", reason: "People want to see your work before they get in touch.", body: [ph("Describe a few projects you are proud of, and add photos in the editor")] },
      { key: "book-us", title: "Book us", description: "How clients book you (no booking system is connected).", reason: "SiteForge has no booking system: this page explains how to reach you.", body: ["Planning something? Tell us the date and what you have in mind.", contact, ph("Say what you need to know to confirm a booking")] },
    ],
  },
  wellness: {
    list: { key: "treatments", title: "Treatments", heading: "Our treatments", reason: "Lists what you offer, from your product list." },
    book: { question: "How do I book an appointment?", placeholder: "Explain how to book an appointment" },
    pages: (contact) => [
      { key: "book-an-appointment", title: "Book an appointment", description: "How clients book (no booking system is connected).", reason: "SiteForge has no booking system: this page explains how to reach you.", body: ["We would love to see you.", contact, ph("Add your opening hours and how far ahead to book")] },
    ],
  },
};

/** A placeholder the owner must replace before the page can be published. */
export const PLACEHOLDER_PATTERN = /\[\[[^\]]{1,300}\]\]/g;
export const ph = (text: string) => `[[${text}]]`;

export interface PagePlanInput {
  business: {
    name: string;
    category: string;
    description: string;
    contactEmail: string;
    phone: string;
    address: string;
    currency: string;
    codEnabled: boolean;
    guestCodEnabled?: boolean;
  };
  /** Owner-written policy text from the store settings (may be empty). */
  policies: { shipping: string; returns: string };
  /** The store's delivery settings, when delivery charges are configured. */
  shipping: { enabled: boolean; flatRate: number; freeOver: number | null; deliveryInfo: string } | null;
  /** Real product categories with active products. */
  categories: Array<{ name: string; count: number }>;
  productCount: number;
  saleCount: number;
  onlinePayments: boolean;
  accountsEnabled: boolean;
}

export interface DefaultPageSpec {
  /** Stable identity of the page kind (also stored on the page as `generated.key`). */
  key: string;
  title: string;
  slug: string;
  kind: "content" | "collection" | "policy";
  description: string;
  seoTitle: string;
  seoDescription: string;
  sections: Section[];
  /** Policy/legal content: the owner must confirm a review before publishing. */
  needsReview: boolean;
  /** Suggested navigation area (added only where the owner has none yet). */
  nav: "header" | "footer" | null;
  /** Why the page is suggested (shown to the owner). */
  reason: string;
}

export interface PagePlan {
  family: PageFamily;
  pages: DefaultPageSpec[];
  /** Suggestions not made, and why (e.g. no matching product category). */
  skipped: Array<{ key: string; title: string; reason: string }>;
}

const OPTIONAL_LISTS = new Set(["new-arrivals", "offers", "collections"]);

/**
 * Which pages come first when a plan cannot hold them all (lower first). How customers reach
 * you and what you sell, then the policies a store needs, then everything else.
 */
export function pagePriority(spec: Pick<DefaultPageSpec, "key" | "kind" | "nav">): number {
  if (spec.key === "contact" || spec.key === "about") return 0;
  if (spec.kind === "collection" && spec.nav === "header" && !OPTIONAL_LISTS.has(spec.key)) return 0;
  return spec.kind === "policy" ? 1 : 2;
}

export const isEssentialPage = (spec: Pick<DefaultPageSpec, "key" | "kind" | "nav">) => pagePriority(spec) <= 1;

export function pageFamilyFor(businessType: string | null | undefined): PageFamily {
  const type = (businessType ?? "").toLowerCase();
  if (type === "food") return "restaurant";
  if (type === "beauty") return "wellness";
  if (type === "cosmetics") return "beauty";
  switch (presetForBusinessType(businessType)) {
    case "services":
    case "realestate":
    case "fitness":
    case "education":
    case "creative":
      return presetForBusinessType(businessType) as PageFamily;
    case "clothing":
    case "shoes":
      return "fashion";
    case "electronics":
    case "hardware":
      return "tech";
    case "grocery":
      return "grocery";
    case "furniture":
      return "home";
    default:
      return "general";
  }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Category pages each family looks for, matched against REAL categories only. */
const CATEGORY_MATCHERS: Partial<Record<PageFamily, Array<{ key: string; pattern: RegExp }>>> = {
  fashion: [
    { key: "men", pattern: /^(men|mens|men's|man|male)$/i },
    { key: "women", pattern: /^(women|womens|women's|woman|ladies|female)$/i },
  ],
  home: [
    { key: "living-room", pattern: /^living[\s-]?room$/i },
    { key: "bedroom", pattern: /^bedroom$/i },
    { key: "home-decor", pattern: /^(home[\s-]?decor|decor|d[eé]cor)$/i },
  ],
  grocery: [{ key: "fresh", pattern: /^(fresh|fresh produce|produce|fruit|fruits|vegetables|fruit (and|&) vegetables)$/i }],
};

let counter = 0;
const sid = (key: string, part: string) => `${key}-${part}`.replace(/[^a-z0-9-]+/gi, "-").slice(0, 60) || `s${++counter}`;
const paragraphs = (...parts: Array<string | false | null | undefined>) => parts.filter((p): p is string => Boolean(p && p.trim())).join("\n\n");

/** Section titles are limited to 80 characters (lib/sections.ts). */
const title80 = (value: string) => (value.length > 80 ? `${value.slice(0, 79).trimEnd()}…` : value);

function about(key: string, title: string, body: string): Section {
  return { id: sid(key, "text"), type: "about", order: 0, visible: true, settings: { title: title80(title), body: body.slice(0, 4000) } } as Section;
}
function products(key: string, settings: { title: string; category?: string; collection?: "all" | "new" | "sale"; limit?: number }, order = 1): Section {
  return { id: sid(key, `products-${order}`), type: "products", order, visible: true, settings: { columns: "4", ...settings, title: title80(settings.title) } } as Section;
}
function cta(key: string, headline: string, buttonText: string, buttonHref: string, order: number): Section {
  return { id: sid(key, "cta"), type: "cta", order, visible: true, settings: { headline, buttonText, buttonHref } } as Section;
}
const ordered = (sections: Section[]) => sections.map((s, order) => ({ ...s, order }) as Section);

/** The default page plan for a business (pure). */
export function planDefaultPages(input: PagePlanInput): PagePlan {
  const family = pageFamilyFor(input.business.category);
  const servicePlan = SERVICE_PLANS[family];
  const { business } = input;
  const name = business.name.trim() || "our store";
  const pages: DefaultPageSpec[] = [];
  const skipped: PagePlan["skipped"] = [];
  const money = (amount: number) => formatPrice(amount, business.currency || "USD");
  const contactLine = [business.contactEmail && `email ${business.contactEmail}`, business.phone && `call ${business.phone}`].filter(Boolean).join(" or ");
  const contact = contactLine ? `You can ${contactLine}.` : ph("Add how customers can reach you (email or phone), or delete this line");
  const shippingFacts = input.shipping?.enabled
    ? paragraphs(
        input.shipping.flatRate > 0 ? `Delivery costs ${money(input.shipping.flatRate)} per order.` : "Delivery is free.",
        input.shipping.freeOver !== null ? `Orders of ${money(input.shipping.freeOver)} or more are delivered free.` : null,
        input.shipping.deliveryInfo || null,
      )
    : "";
  const reviewLine = ph("This page is a template, not legal advice. Check it against the laws that apply to your business, then delete this line");
  const add = (spec: Omit<DefaultPageSpec, "seoTitle" | "seoDescription"> & { seoDescription?: string }) => {
    pages.push({
      ...spec,
      // Never a slug owned by a storefront route (e.g. /terms, /products).
      slug: RESERVED_PAGE_SLUGS.has(spec.slug) ? `${spec.slug}-page` : spec.slug,
      sections: ordered(spec.sections),
      seoTitle: spec.title,
      seoDescription: (spec.seoDescription ?? `${spec.title} – ${name}.`).slice(0, 300),
    });
  };

  // ---- Shop-side pages (only with real products/categories) ----------------
  if (family === "restaurant") {
    if (input.productCount > 0) {
      add({ key: "menu", title: "Menu", slug: "menu", kind: "collection", description: "Everything you can order, from your product list.", sections: [products("menu", { title: "Our menu", collection: "all" })], needsReview: false, nav: "header", reason: "Restaurants and cafés usually show their menu first." });
    } else {
      skipped.push({ key: "menu", title: "Menu", reason: "Add products first: the menu lists them." });
    }
  }

  if (servicePlan) {
    const { list } = servicePlan;
    if (input.productCount > 0) {
      add({ key: list.key, title: list.title, slug: list.key, kind: "collection", description: list.reason, sections: [products(list.key, { title: list.heading, collection: "all", limit: 12 })], needsReview: false, nav: "header", reason: list.reason });
    } else {
      skipped.push({ key: list.key, title: list.title, reason: `Add what you offer first: this page lists it.` });
    }
  }

  for (const matcher of CATEGORY_MATCHERS[family] ?? []) {
    const category = input.categories.find((c) => matcher.pattern.test(c.name.trim()));
    if (!category) {
      skipped.push({ key: `category-${matcher.key}`, title: matcher.key.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()), reason: "No product category with this name yet." });
      continue;
    }
    add({
      key: `category-${matcher.key}`,
      title: category.name,
      slug: slugify(category.name) || matcher.key,
      kind: "collection",
      description: `Products in the ${category.name} category.`,
      sections: [products(`category-${matcher.key}`, { title: category.name, category: category.name })],
      needsReview: false,
      // The header already links every product category: no duplicate link.
      nav: null,
      reason: `Your ${category.name} category has ${category.count} ${category.count === 1 ? "product" : "products"}.`,
    });
  }

  if (family === "fashion" || family === "home") {
    const real = input.categories.filter((c) => c.count > 0).slice(0, 4);
    if (real.length >= 2) {
      add({
        key: "collections",
        title: "Collections",
        slug: "collections",
        kind: "collection",
        description: "Your product categories, one collection each.",
        sections: real.map((c, i) => products("collections", { title: c.name, category: c.name, limit: 4 }, i)),
        needsReview: false,
        nav: null,
        reason: `${real.length} product categories become collections.`,
      });
    } else {
      skipped.push({ key: "collections", title: "Collections", reason: "Needs at least two product categories." });
    }
  }

  if (family !== "restaurant" && !servicePlan) {
    if (input.productCount >= 2) {
      add({ key: "new-arrivals", title: "New arrivals", slug: "new-arrivals", kind: "collection", description: "Your newest products, newest first.", sections: [products("new-arrivals", { title: "New arrivals", collection: "new", limit: 12 })], needsReview: false, nav: family === "general" ? null : "header", reason: "Lists your newest products automatically." });
    } else {
      skipped.push({ key: "new-arrivals", title: "New arrivals", reason: "Needs at least two products." });
    }
  }

  if (family === "grocery" || family === "general" || family === "tech" || family === "beauty") {
    if (input.saleCount > 0) {
      add({ key: "offers", title: "Offers", slug: "offers", kind: "collection", description: "Products with a real reduced price.", sections: [products("offers", { title: "Current offers", collection: "sale" })], needsReview: false, nav: family === "grocery" ? "header" : null, reason: `${input.saleCount} ${input.saleCount === 1 ? "product has" : "products have"} a reduced price.` });
    } else {
      skipped.push({ key: "offers", title: "Offers", reason: "No product has a reduced price (an original price above its price)." });
    }
  }

  // ---- About and contact ---------------------------------------------------
  const story = business.description.trim() || ph("Tell customers who you are, what you make or sell, and why");
  add({
    key: "about",
    title: family === "fashion" ? "About the brand" : "About us",
    slug: family === "fashion" ? "about-the-brand" : "about",
    kind: "content",
    description: "Your story, from your business description.",
    seoDescription: business.description.trim() ? business.description.trim() : `About ${name}.`,
    sections: [
      about("about", `About ${name}`, story),
      ...(input.productCount > 0 ? [cta("about", "See what we offer", storeVocabulary(business.category).shopHeading === "Shop" ? "Shop all products" : storeVocabulary(business.category).shopAll, "/products", 1)] : []),
    ],
    needsReview: false,
    nav: "header",
    reason: business.description.trim() ? "Uses your business description." : "Add your story: there is no business description yet.",
  });

  const contactSections: Section[] = [
    about("contact", `Contact ${name}`, paragraphs("Questions about an order or a product? Get in touch.", contactLine ? null : contact)),
  ];
  if (business.contactEmail || business.phone || business.address) {
    contactSections.push({
      id: sid("contact", "details"),
      type: "contact",
      order: 1,
      visible: true,
      settings: { title: "Contact details", description: "", email: business.contactEmail, phone: business.phone, address: business.address },
    } as Section);
  }
  add({ key: "contact", title: "Contact", slug: "contact", kind: "content", description: "Your contact details from Business settings.", sections: contactSections, needsReview: false, nav: "header", reason: business.contactEmail || business.phone ? "Uses your contact details." : "Add an email or phone number in Business settings." });

  if (family === "restaurant") {
    add({
      key: "reservations",
      title: "Reservations and enquiries",
      slug: "reservations",
      kind: "content",
      description: "How guests can book or ask questions (no booking system is connected).",
      sections: [about("reservations", "Reservations and enquiries", paragraphs(ph("Explain how guests can reserve a table or place a large order, for example by phone. If you do not take reservations, delete this page"), contactLine ? `For enquiries, ${contactLine}.` : null))],
      needsReview: false,
      nav: "footer",
      reason: "SiteForge has no booking system: this page explains how to reach you.",
    });
  }

  // ---- FAQ (answers only from real settings; placeholders otherwise) -------
  const faq: Array<{ question: string; answer: string }> = [];
  if (input.shipping?.enabled) {
    faq.push({ question: "How much does delivery cost?", answer: shippingFacts });
    if (!input.shipping.deliveryInfo) faq.push({ question: "How long does delivery take?", answer: ph("Add your usual delivery time") });
  } else if (family !== "restaurant" && !servicePlan) {
    faq.push({ question: "Do you deliver?", answer: ph("Explain where and how you deliver") });
  }
  if (business.codEnabled && business.guestCodEnabled) faq.push({ question: "Can I pay cash on delivery?", answer: "Yes. You can choose cash on delivery at checkout, with or without an account." });
  else if (business.codEnabled && input.accountsEnabled) faq.push({ question: "Can I pay cash on delivery?", answer: "Yes. Signed-in customers can choose cash on delivery at checkout." });
  if (input.onlinePayments) faq.push({ question: "Can I pay online?", answer: "Yes. You can pay securely online at checkout." });
  if (servicePlan) {
    faq.unshift({ question: servicePlan.book.question, answer: ph(servicePlan.book.placeholder) });
    faq.push({ question: "Can I cancel or change a booking?", answer: ph("Explain your cancellation and rescheduling rules") });
  }
  if (family !== "restaurant" && !servicePlan) {
    faq.push({ question: "Can I return an item?", answer: input.policies.returns.trim() ? "Yes, under our return and refund policy. See the Return and refund policy page for details." : ph("Explain your returns policy in one or two sentences") });
  }
  faq.push({ question: "How do I follow my order?", answer: "After you order, your order page shows its status and any tracking details we add." });
  if (contactLine) faq.push({ question: "How can I contact you?", answer: `${contact}` });
  if (family === "tech") faq.push({ question: "Do your products come with a warranty?", answer: ph("Describe the warranty, or say there is none") });
  add({
    key: "faq",
    title: "FAQ",
    slug: "faq",
    kind: "content",
    description: "Questions answered from your store settings.",
    sections: [{ id: sid("faq", "questions"), type: "faq", order: 0, visible: true, settings: { title: "Frequently asked questions", items: faq.slice(0, 20) } } as Section],
    needsReview: false,
    nav: "footer",
    reason: "Answers come from your delivery and payment settings; the rest are placeholders.",
  });

  // ---- Family-specific information pages ------------------------------------
  for (const page of servicePlan?.pages(contact) ?? []) {
    add({ key: page.key, title: page.title, slug: page.key, kind: "content", description: page.description, sections: [about(page.key, page.title, paragraphs(...page.body))], needsReview: false, nav: "footer", reason: page.reason });
  }
  if (family === "beauty") {
    add({ key: "ingredients", title: "Ingredients and care", slug: "ingredients-and-care", kind: "content", description: "What your products contain and how to use them.", sections: [about("ingredients", "Ingredients and care", paragraphs(ph("List your key ingredients and any allergy information"), ph("Explain how to use and store your products")))], needsReview: false, nav: "footer", reason: "Shoppers check ingredients before they buy." });
  }
  if (family === "tech") {
    add({
      key: "support",
      title: "Product support",
      slug: "product-support",
      kind: "content",
      description: "How customers get help with a product.",
      sections: [about("support", "Product support", paragraphs("Need help with a product you bought from us?", contact, ph("Add your support hours and what to include in a request (order number, product, a description of the problem)")))],
      needsReview: false,
      nav: "footer",
      reason: "Electronics shoppers look for support before buying.",
    });
    add({
      key: "warranty",
      title: "Warranty information",
      slug: "warranty",
      kind: "policy",
      description: "Your warranty terms (template).",
      sections: [about("warranty", "Warranty information", paragraphs(ph("Describe the warranty that applies to your products: how long it lasts, what it covers and how to claim it. If the manufacturer's warranty applies, say so"), contactLine ? `To make a warranty claim, ${contactLine}.` : null, reviewLine))],
      needsReview: true,
      nav: "footer",
      reason: "Template: warranty terms must come from you.",
    });
  }

  // ---- Policies --------------------------------------------------------------
  const shippingBody = paragraphs(
    input.policies.shipping.trim() || null,
    shippingFacts || null,
    input.policies.shipping.trim() ? null : ph("Explain where you deliver and how long delivery usually takes"),
    reviewLine,
  );
  const returnsBody = paragraphs(
    input.policies.returns.trim() || ph("Explain whether customers can return items, within how many days, in what condition, and how refunds are paid"),
    `To start a return, ${contactLine || ph("add how customers should contact you")}.`,
    reviewLine,
  );

  if (family === "home") {
    add({ key: "delivery-and-returns", title: "Delivery and returns", slug: "delivery-and-returns", kind: "policy", description: "Delivery and return terms (template using your settings).", sections: [about("delivery", "Delivery", shippingBody), { ...about("returns", "Returns", returnsBody), id: sid("delivery-and-returns", "returns"), order: 1 } as Section], needsReview: true, nav: "footer", reason: "Large items need clear delivery and return terms." });
  } else {
    if (family === "grocery") {
      add({ key: "delivery-information", title: "Delivery information", slug: "delivery-information", kind: "policy", description: "Delivery areas, times and costs (template using your settings).", sections: [about("delivery-info", "Delivery information", paragraphs(shippingFacts || null, ph("List the areas you deliver to and your delivery time slots"), reviewLine))], needsReview: true, nav: "header", reason: "Grocery shoppers check delivery areas and slots first." });
    }
    if ((family !== "restaurant" && !servicePlan) || input.shipping?.enabled) {
      add({ key: "shipping-policy", title: "Shipping policy", slug: "shipping-policy", kind: "policy", description: "Shipping terms (template using your settings).", sections: [about("shipping", "Shipping policy", shippingBody)], needsReview: true, nav: "footer", reason: input.policies.shipping.trim() ? "Starts from your shipping policy text." : "Template: add your delivery terms." });
    }
    if (servicePlan) {
      add({ key: "cancellation-policy", title: "Cancellation and refund policy", slug: "cancellation-policy", kind: "policy", description: "Cancellations and refunds (template).", sections: [about("cancellation-policy", "Cancellation and refund policy", paragraphs(ph("Explain how clients can cancel or reschedule, how much notice you need, and when you give refunds"), `To cancel or change a booking, ${contactLine || ph("add how clients should contact you")}.`, reviewLine))], needsReview: true, nav: "footer", reason: "Template: your cancellation terms must come from you." });
    }
    if (family !== "restaurant" && !servicePlan) {
      add({ key: "returns-policy", title: "Return and refund policy", slug: "returns-policy", kind: "policy", description: "Returns and refunds (template using your settings).", sections: [about("returns", "Return and refund policy", returnsBody)], needsReview: true, nav: "footer", reason: input.policies.returns.trim() ? "Starts from your returns policy text." : "Template: add your returns terms." });
    }
  }

  const privacyBody = paragraphs(
    `This policy explains how ${name} handles personal information.`,
    servicePlan && !input.shipping?.enabled ? "When you place an order or contact us, we collect your name, email address and phone number so we can respond and provide what you asked for." : "When you place an order we collect your name, email address, phone number and delivery address so we can process and deliver it.",
    input.accountsEnabled ? "If you create an account, we keep your account details and order history so you can sign in and follow your orders." : null,
    input.onlinePayments ? "Online payments are handled by our payment provider; we do not see or store your full card details." : null,
    "We use cookies that keep your cart and sign-in working.",
    `To ask about or correct your information, ${contactLine || ph("add how customers can contact you")}.`,
    ph("Add how long you keep customer information and any other services you share it with"),
    reviewLine,
  );
  add({ key: "privacy-policy", title: "Privacy policy", slug: "privacy-policy", kind: "policy", description: "How customer data is handled (template describing what this store collects).", sections: [about("privacy", "Privacy policy", privacyBody)], needsReview: true, nav: "footer", reason: "Template based on what your store actually collects." });

  const termsBody = paragraphs(
    `These terms apply to orders placed with ${name}${business.address ? `, ${business.address}` : ""}.`,
    ph("Add the legal name of your business and where it is registered"),
    "Prices are shown at checkout before you confirm your order.",
    ph("Explain whether prices include taxes, and any other charges"),
    ph("Add the law that governs these terms and how disputes are handled"),
    reviewLine,
  );
  add({ key: "terms", title: "Terms and conditions", slug: "terms-and-conditions", kind: "policy", description: "Terms of sale (template).", sections: [about("terms", "Terms and conditions", termsBody)], needsReview: true, nav: "footer", reason: "Template: terms must come from you." });

  return { family, pages, skipped };
}

/** Placeholders in sections visitors would see. A hidden section can wait: it is not shown. */
export function findVisiblePlaceholders(sections: unknown): string[] {
  const shown = Array.isArray(sections) ? sections.filter((section) => !(section && typeof section === "object" && ((section as { visible?: unknown }).visible === false || (section as { enabled?: unknown }).enabled === false))) : sections;
  return findPlaceholders(shown);
}

/** Placeholders still present in a page's sections (text fields only). */
export function findPlaceholders(sections: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.match(PLACEHOLDER_PATTERN) ?? []) found.add(match);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(sections);
  return [...found];
}
