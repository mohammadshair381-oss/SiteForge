import { createDefaultSection, reorderSections, type Section } from "./sections";

/**
 * Starting layouts for a new page (pure). Text comes from the business's own
 * details; anything unknown is a [[placeholder]] the owner must replace before
 * the page can be published, so a template can never publish an invented fact.
 */
const ph = (text: string) => `[[${text}]]`;

export const PAGE_TEMPLATES = ["blank", "about", "contact", "faq", "services", "landing"] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export const PAGE_TEMPLATE_INFO: Record<PageTemplate, { label: string; description: string; title: string }> = {
  blank: { label: "Blank", description: "An empty page. Add the sections you want.", title: "" },
  about: { label: "About", description: "Your story, what you stand for and a call to action.", title: "About us" },
  contact: { label: "Contact", description: "Your contact details and common questions.", title: "Contact us" },
  faq: { label: "Questions", description: "Answers to the questions customers ask most.", title: "Frequently asked questions" },
  services: { label: "Services", description: "What you offer, how it works and your prices.", title: "Our services" },
  landing: { label: "Campaign", description: "A focused page for one offer or event.", title: "" },
};

export interface TemplateBusiness {
  name: string;
  description?: string;
  contactEmail?: string;
  phone?: string;
  address?: string;
}

function build(sections: Array<Omit<Section, "id" | "order" | "visible"> & { settings: unknown }>): Section[] {
  return reorderSections(
    sections.map((partial, index) => ({ ...createDefaultSection(partial.type, index), settings: partial.settings }) as Section),
  );
}

export function buildPageTemplate(template: PageTemplate, business: TemplateBusiness): Section[] {
  switch (template) {
    case "about":
      return build([
        { type: "hero", settings: { headline: `About ${business.name}`, subheadline: business.description || ph("A sentence about what your business does") } },
        { type: "imageText", settings: { title: "Our story", body: ph("How your business started and what drives it"), imageSide: "right" } },
        { type: "features", settings: { title: "What we stand for", items: [{ title: ph("A value"), description: ph("What it means in practice") }, { title: ph("A value"), description: ph("What it means in practice") }, { title: ph("A value"), description: ph("What it means in practice") }] } },
        { type: "cta", settings: { headline: "See what we offer", buttonText: "Browse", buttonHref: "/products" } },
      ] as never);
    case "contact":
      return build([
        { type: "contact", settings: { title: "Get in touch", description: ph("When and how you usually reply"), email: business.contactEmail ?? "", phone: business.phone ?? "", address: business.address ?? "" } },
        { type: "faq", settings: { title: "Before you write", items: [{ question: ph("A question customers often ask"), answer: ph("Your answer") }, { question: ph("Another common question"), answer: ph("Your answer") }] } },
      ] as never);
    case "faq":
      return build([
        { type: "richText", settings: { title: "Frequently asked questions", body: ph("A short introduction to these answers") } },
        { type: "faq", settings: { title: "", items: [1, 2, 3, 4].map(() => ({ question: ph("A question customers ask"), answer: ph("Your answer") })) } },
        { type: "cta", settings: { headline: "Still have a question?", buttonText: "Contact us", buttonHref: "#contact" } },
      ] as never);
    case "services":
      return build([
        { type: "hero", settings: { headline: "Our services", subheadline: ph("What you help customers do") } },
        { type: "steps", settings: { title: "How it works", items: [1, 2, 3].map(() => ({ title: ph("A step"), description: ph("What happens in this step") })) } },
        { type: "pricing", settings: { title: "Prices", plans: [1, 2].map(() => ({ title: ph("A service"), price: ph("Its price"), features: [ph("What is included")] })) } },
        { type: "cta", settings: { headline: "Ready to start?", buttonText: "Contact us", buttonHref: "#contact" } },
      ] as never);
    case "landing":
      return build([
        { type: "hero", settings: { headline: ph("Your offer in one line"), subheadline: ph("Why it matters and who it is for"), ctaText: "Shop now", ctaHref: "/products" } },
        { type: "imageText", settings: { title: ph("The main benefit"), body: ph("Explain it in a sentence or two"), imageSide: "left" } },
        { type: "products", settings: { title: "Featured products", columns: "3", limit: 6 } },
        { type: "cta", settings: { headline: ph("Your closing line"), buttonText: "Shop now", buttonHref: "/products" } },
      ] as never);
    case "blank":
    default:
      return [];
  }
}
