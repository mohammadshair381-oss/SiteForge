import test from "node:test";
import assert from "node:assert/strict";
import {
  sectionSchema,
  sectionsArraySchema,
  getVisibleSections,
  createDefaultSection,
  reorderSections,
  SECTION_TYPES,
  isSafeSectionHref,
  editorElementStyleSchema,
} from "../../lib/sections";
import { themeSettingsSchema } from "../../lib/validation";

test("section schema accepts a valid hero section", () => {
  const result = sectionSchema.safeParse({
    id: "hero-1",
    type: "hero",
    order: 0,
    visible: true,
    settings: { headline: "Hi", subheadline: "There" },
  });
  assert.equal(result.success, true);
});

test("getVisibleSections skips invalid and hidden sections and preserves configured order", () => {
  const sections = getVisibleSections([
    { id: "about", type: "about", order: 2, visible: true, settings: { body: "About" } },
    { id: "hidden", type: "about", order: 0, visible: false, settings: { body: "Hidden" } },
    { id: "invalid", type: "faq", order: 1, visible: true, settings: null },
    { id: "hero", type: "hero", order: 1, visible: true, settings: { headline: "Welcome" } },
  ]);

  assert.deepEqual(sections.map((section) => section.id), ["hero", "about"]);
  assert.deepEqual(getVisibleSections([{ id: "invalid", type: "unknown" }]), []);
});

test("advanced section schemas accept valid content and safe link targets", () => {
  const validSections = [
    { id: "faq-1", type: "faq", order: 0, visible: true, settings: { items: [{ question: "When are you open?", answer: "See our hours on the contact page." }] } },
    { id: "testimonials-1", type: "testimonials", order: 1, visible: true, settings: { items: [{ quote: "A customer-provided quote.", name: "A. Customer", role: "Customer" }] } },
    { id: "gallery-1", type: "gallery", order: 2, visible: true, settings: { images: [{ url: "https://cdn.test/photo.jpg", alt: "A handmade ceramic bowl" }] } },
    { id: "pricing-1", type: "pricing", order: 3, visible: true, settings: { plans: [{ title: "Custom plan", price: "Contact us", features: ["Tailored to your needs"], ctaText: "Ask us", ctaHref: "/contact" }] } },
    { id: "contact-1", type: "contact", order: 4, visible: true, settings: { email: "hello@example.com", phone: "+1 555 0100", ctaText: "Directions", ctaHref: "https://maps.example.com/shop" } },
    { id: "newsletter-1", type: "newsletter", order: 5, visible: true, settings: { headline: "News from our studio", buttonText: "Visit signup page", ctaHref: "#signup" } },
    { id: "stats-1", type: "stats", order: 6, visible: true, settings: { items: [{ value: "12", label: "Years in business" }] } },
  ];
  assert.equal(sectionsArraySchema.safeParse(validSections).success, true);
});

test("advanced sections reject incomplete content, unsafe links, and missing gallery alt text", () => {
  const invalidSections = [
    { id: "faq-bad", type: "faq", order: 0, visible: true, settings: { items: [{ question: "", answer: "Answer" }] } },
    { id: "testimonial-bad", type: "testimonials", order: 1, visible: true, settings: { items: [{ quote: "Quote", name: "" }] } },
    { id: "gallery-bad", type: "gallery", order: 2, visible: true, settings: { images: [{ url: "https://cdn.test/photo.jpg" }] } },
    { id: "pricing-bad", type: "pricing", order: 3, visible: true, settings: { plans: [{ title: "Plan", price: "$10", ctaHref: "javascript:alert(1)" }] } },
    { id: "contact-bad", type: "contact", order: 4, visible: true, settings: { email: "not-an-email", ctaHref: "data:text/html,unsafe" } },
    { id: "newsletter-bad", type: "newsletter", order: 5, visible: true, settings: { ctaHref: "//evil.example" } },
    { id: "stats-bad", type: "stats", order: 6, visible: true, settings: { items: [{ value: "", label: "Customers" }] } },
  ];
  for (const section of invalidSections) {
    assert.equal(sectionSchema.safeParse(section).success, false, `${section.type} rejects invalid data`);
  }
});

test("section CTA targets allow HTTPS and same-site paths but reject unsafe protocols", () => {
  for (const href of ["https://example.com/signup", "/contact?from=site", "contact", "#", "#signup"]) {
    assert.equal(isSafeSectionHref(href), true, `${href} should be allowed`);
  }
  for (const href of ["javascript:alert(1)", "data:text/html,unsafe", "http://example.com", "http://siteforge.invalid", "//evil.example", "/\\evil.example", " https://example.com "]) {
    assert.equal(isSafeSectionHref(href), false, `${href} should be rejected`);
  }
});

test("section schema rejects unknown type", () => {
  const result = sectionSchema.safeParse({
    id: "x-1",
    type: "not-a-section",
    order: 0,
    visible: true,
    settings: {},
  });
  assert.equal(result.success, false);
});

test("section schema rejects invalid id (spaces)", () => {
  const result = sectionSchema.safeParse({
    id: "bad id",
    type: "hero",
    order: 0,
    visible: true,
    settings: {},
  });
  assert.equal(result.success, false);
});

test("section schema rejects invalid hex color in style", () => {
  const result = sectionSchema.safeParse({
    id: "hero-2",
    type: "hero",
    order: 0,
    visible: true,
    settings: {},
    style: { backgroundColor: "red" },
  });
  assert.equal(result.success, false);
});

test("element styles accept bounded responsive properties and reject unsafe CSS values", () => {
  const valid = sectionSchema.safeParse({
    id: "hero-style",
    type: "hero",
    order: 0,
    settings: { headline: "Welcome" },
    style: {
      elementStyles: {
        headline: {
          desktop: { color: "#112233", fontSize: "48px", textAlign: "center" },
          mobile: { fontSize: "2rem", maxWidth: "90%" },
        },
      },
    },
  });
  assert.equal(valid.success, true);

  for (const style of [
    { color: "red" },
    { fontSize: "calc(100% + 1px)" },
    { backgroundColor: "url(https://example.com)" },
    { position: "absolute" },
    { opacity: 2 },
  ]) {
    assert.equal(editorElementStyleSchema.safeParse(style).success, false);
  }
});

test("sections array rejects duplicate ids", () => {
  const result = sectionsArraySchema.safeParse([
    { id: "a", type: "hero", order: 0, visible: true, settings: {} },
    { id: "a", type: "about", order: 1, visible: true, settings: {} },
  ]);
  assert.equal(result.success, false);
});

test("sections array rejects more than 50 sections", () => {
  const arr = Array.from({ length: 51 }, (_, i) => ({
    id: `s-${i}`,
    type: "hero",
    order: i,
    visible: true,
    settings: {},
  }));
  const result = sectionsArraySchema.safeParse(arr);
  assert.equal(result.success, false);
});

test("createDefaultSection produces valid section", () => {
  for (const type of SECTION_TYPES) {
    const s = createDefaultSection(type, 0);
    const r = sectionSchema.safeParse(s);
    assert.equal(r.success, true, `default ${type} invalid: ${JSON.stringify(r.error?.issues)}`);
  }
});

test("advanced defaults contain no fabricated testimonials, prices, or statistics", () => {
  const faq = createDefaultSection("faq", 0);
  const testimonials = createDefaultSection("testimonials", 1);
  const pricing = createDefaultSection("pricing", 2);
  const stats = createDefaultSection("stats", 3);
  if (faq.type === "faq") assert.deepEqual(faq.settings.items, []);
  if (testimonials.type === "testimonials") {
    assert.deepEqual(testimonials.settings.items, []);
  }
  if (pricing.type === "pricing") assert.deepEqual(pricing.settings.plans, []);
  if (stats.type === "stats") assert.deepEqual(stats.settings.items, []);
});

test("reorderSections normalizes order", () => {
  const secs = [
    createDefaultSection("hero", 5),
    createDefaultSection("about", 9),
  ];
  const reordered = reorderSections(secs);
  assert.equal(reordered[0].order, 0);
  assert.equal(reordered[1].order, 1);
});

test("themeSettingsSchema accepts sections", () => {
  const r = themeSettingsSchema.safeParse({
    primaryColor: "#4f46e5",
    sections: [{ id: "h-1", type: "hero", order: 0, visible: true, settings: {} }],
  });
  assert.equal(r.success, true);
});

test("themeSettingsSchema rejects invalid section type", () => {
  const r = themeSettingsSchema.safeParse({
    sections: [{ id: "x", type: "nope", order: 0, visible: true, settings: {} }],
  });
  assert.equal(r.success, false);
});

test("themeSettingsSchema still accepts legacy settings without sections", () => {
  const r = themeSettingsSchema.safeParse({
    primaryColor: "#4f46e5",
    heroHeadline: "Hi",
    showProducts: true,
  });
  assert.equal(r.success, true);
});

test("hero and about sections accept optional media images", () => {
  const imageUrl = "https://cdn.test/media/64b7f0c2a1b2c3d4e5f60712/hero.png";

  const hero = sectionSchema.safeParse({
    id: "hero-image",
    type: "hero",
    order: 0,
    visible: true,
    settings: { headline: "Hi", imageUrl, imageAlt: "A shopfront" },
  });
  assert.equal(hero.success, true);
  if (hero.success && hero.data.type === "hero") {
    assert.equal(hero.data.settings.imageUrl, imageUrl);
    assert.equal(hero.data.settings.imageAlt, "A shopfront");
  }

  const about = sectionSchema.safeParse({
    id: "about-image",
    type: "about",
    order: 0,
    visible: true,
    settings: { body: "About us", imageUrl, imageAlt: "Our team" },
  });
  assert.equal(about.success, true);

  const cleared = sectionSchema.safeParse({
    id: "hero-cleared",
    type: "hero",
    order: 0,
    visible: true,
    settings: { imageUrl: "", imageAlt: "" },
  });
  assert.equal(cleared.success, true);
});

test("section images reject unsafe or non-https URLs", () => {
  for (const imageUrl of [
    "http://cdn.test/media/64b7f0c2a1b2c3d4e5f60712/hero.png",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
  ]) {
    const result = sectionSchema.safeParse({
      id: "hero-unsafe",
      type: "hero",
      order: 0,
      visible: true,
      settings: { imageUrl },
    });
    assert.equal(result.success, false, `${imageUrl} must be rejected`);
  }
});

test("legacy hero and about sections without image settings still validate", () => {
  const result = sectionsArraySchema.safeParse([
    {
      id: "legacy-hero",
      type: "hero",
      order: 0,
      visible: true,
      settings: { headline: "Legacy" },
    },
    {
      id: "legacy-about",
      type: "about",
      order: 1,
      visible: true,
      settings: { body: "Legacy body" },
    },
  ]);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal("imageUrl" in result.data[0].settings, false);
    assert.equal("imageUrl" in result.data[1].settings, false);
  }
});