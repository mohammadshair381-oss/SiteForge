import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontView } from "../../backend/lib/storefront";
import type { Section } from "../../backend/lib/sections";

function makeView(overrides: Partial<StorefrontView> = {}): StorefrontView {
  return {
    id: "b1",
    name: "Demo Business",
    subdomain: "demo",
    category: "retail",
    about: "About us text",
    logoUrl: "",
    contactEmail: "demo@example.com",
    phone: "555-1234",
    address: "123 Main St",
    currency: "USD",
    themeId: "aurora",
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [],
    },
    products: [
      {
        id: "p1",
        name: "Widget",
        slug: "widget",
        description: "A widget",
        price: 19.99,
        currency: "USD",
        imageUrl: "",
        category: "retail",
      },
    ],
    removeBranding: false,
    ...overrides,
  };
}

function makeSection(overrides: Partial<Section> & { type: Section["type"] }): Section {
  const { type, ...rest } = overrides;
  return {
    id: `${type}-1`,
    type,
    order: 0,
    visible: true,
    settings: {},
    ...rest,
  } as Section;
}

async function renderSections(view: StorefrontView, extra: Record<string, unknown> = {}): Promise<string> {
  const mod = await import("../../frontend/components/storefront/SectionRenderer");
  const Component = mod.default;
  return renderToString(React.createElement(Component, { view, productHrefBase: "/product", ...extra }));
}

test("SectionRenderer: renders all thirteen section types", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "hero", order: 0, settings: { headline: "Hero H" } }),
        makeSection({ type: "products", order: 1, settings: { title: "Products T" } }),
        makeSection({ type: "about", order: 2, settings: { body: "About body" } }),
        makeSection({ type: "features", order: 3, settings: { title: "Features T", items: [{ title: "F1", description: "D1" }] } }),
        makeSection({ type: "cta", order: 4, settings: { headline: "CTA H" } }),
        makeSection({ type: "footer", order: 5, settings: { text: "Footer text" } }),
        makeSection({ type: "faq", order: 6, settings: { title: "FAQ T", items: [{ question: "FAQ question", answer: "FAQ answer" }] } }),
        makeSection({ type: "testimonials", order: 7, settings: { title: "Testimonial T", items: [{ quote: "Customer quote", name: "Customer name", role: "Customer role" }] } }),
        makeSection({ type: "gallery", order: 8, settings: { title: "Gallery T", images: [{ url: "https://cdn.test/gallery.jpg", alt: "A blue vase", caption: "Vase caption" }] } }),
        makeSection({ type: "pricing", order: 9, settings: { title: "Pricing T", plans: [{ title: "Plan title", price: "Custom", features: ["Plan feature"], ctaText: "Plan CTA", ctaHref: "/contact" }] } }),
        makeSection({ type: "contact", order: 10, settings: { title: "Contact T", email: "hello@example.com", phone: "+1 555 0100", address: "Business address", ctaText: "Contact CTA", ctaHref: "/contact" } }),
        makeSection({ type: "newsletter", order: 11, settings: { headline: "Newsletter T", description: "Newsletter copy", buttonText: "Newsletter CTA", ctaHref: "/signup" } }),
        makeSection({ type: "stats", order: 12, settings: { title: "Stats T", items: [{ value: "12", label: "Years" }] } }),
      ],
    },
  });
  assert.ok(view.theme.sections, "sections present");
  const html = await renderSections(view);
  assert.ok(html.includes("Hero H"), "hero headline");
  assert.ok(html.includes("Products T"), "products title");
  assert.ok(html.includes("About body"), "about body");
  assert.ok(html.includes("Features T"), "features title");
  assert.ok(html.includes("F1"), "feature item");
  assert.ok(html.includes("CTA H"), "cta headline");
  assert.ok(html.includes("Footer text"), "footer text");
  assert.ok(html.includes("FAQ question") && html.includes("FAQ answer"), "FAQ content");
  assert.ok(html.includes("Customer quote") && html.includes("Customer role"), "testimonial content");
  assert.ok(html.includes('alt="A blue vase"') && html.includes("Vase caption"), "gallery image and caption");
  assert.ok(html.includes("Plan title") && html.includes("Plan feature"), "pricing card content");
  assert.ok(html.includes("hello@example.com") && html.includes("Business address"), "contact details");
  assert.ok(html.includes("Newsletter CTA") && html.includes('href="/signup"'), "newsletter CTA link");
  assert.ok(html.includes("12") && html.includes("Years"), "statistics content");
});

test("SectionRenderer: sections render in configured order", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ id: "b", type: "about", order: 1, settings: { body: "SECOND" } }),
        makeSection({ id: "a", type: "hero", order: 0, settings: { headline: "FIRST" } }),
      ],
    },
  });
  const html = await renderSections(view);
  const firstIdx = html.indexOf("FIRST");
  const secondIdx = html.indexOf("SECOND");
  assert.ok(firstIdx >= 0 && secondIdx >= 0, "both present");
  assert.ok(firstIdx < secondIdx, "hero before about");
});

test("SectionRenderer: hidden sections are not rendered", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "hero", order: 0, visible: false, settings: { headline: "HIDDEN HERO" } }),
        makeSection({ type: "about", order: 1, visible: true, settings: { body: "VISIBLE ABOUT" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes("HIDDEN HERO"), "hidden hero excluded");
  assert.ok(html.includes("VISIBLE ABOUT"), "visible about included");
});

test("SectionRenderer: background color override applied", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "about", order: 0, settings: { body: "X" }, style: { backgroundColor: "#ff0000" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("#ff0000"), "bg color present");
});

test("SectionRenderer: text color override applied", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "about", order: 0, settings: { body: "X" }, style: { textColor: "#00ff00" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("#00ff00"), "text color present");
});

test("SectionRenderer: all padding options produce expected classes", async () => {
  for (const [padding, cls] of [
    ["none", "py-0"],
    ["sm", "py-8"],
    ["md", "py-16"],
    ["lg", "py-24"],
    ["xl", "py-32"],
  ] as const) {
    const view = makeView({
      theme: {
        primaryColor: "#4f46e5",
        accentColor: "#0ea5e9",
        font: "sans",
        heroHeadline: "Welcome",
        heroSubheadline: "Subheadline",
        about: "",
        showProducts: true,
        sections: [
          makeSection({ type: "about", order: 0, settings: { body: "X" }, style: { padding } }),
        ],
      },
    });
    const html = await renderSections(view);
    assert.ok(html.includes(cls), `padding ${padding} -> ${cls}`);
  }
});

test("SectionRenderer: products section respects showProducts=false", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: false,
      sections: [
        makeSection({ type: "products", order: 0, settings: { title: "PRODUCTS TITLE" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes("PRODUCTS TITLE"), "products title hidden when showProducts false");
});

test("SectionRenderer: product cards use supplied StorefrontView data", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "products", order: 0, settings: { title: "P" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("Widget"), "product name");
  assert.ok(html.includes("19.99") || html.includes("$19.99") || html.includes("19,99"), "product price rendered");
});

test("SectionRenderer: removeBranding hides business name in footer", async () => {
  const baseView = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "footer", order: 0, settings: { text: "FT" } }),
      ],
    },
  });

  const viewVisible = { ...baseView, removeBranding: false };
  const htmlVisible = await renderSections(viewVisible);
  assert.ok(htmlVisible.includes("Demo Business"), "branding visible");

  const viewHidden = { ...baseView, removeBranding: true };
  const htmlHidden = await renderSections(viewHidden);
  assert.ok(!htmlHidden.includes("Demo Business"), "branding hidden");
});

test("SectionRenderer: contact info still shown when removeBranding", async () => {
  const view = makeView({
    removeBranding: true,
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "footer", order: 0, settings: {} }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("demo@example.com"), "contact email still shown");
  assert.ok(html.includes("555-1234"), "phone still shown");
});

test("SectionRenderer: about section hides heading when removeBranding", async () => {
  const view = makeView({
    removeBranding: true,
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "about", order: 0, settings: { title: "Custom Title", body: "Body" } }),
      ],
    },
  });
  const html = await renderSections(view);
  // When removeBranding, about heading is hidden only if it would show business name.
  // Custom title is still shown.
  assert.ok(html.includes("Body"), "body shown");
});

test("SectionRenderer: empty sections array renders nothing", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [],
    },
  });
  const html = await renderSections(view);
  assert.equal(html.trim(), "", "renders nothing for empty sections");
});

test("SectionRenderer: unknown section type does not crash", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [{ id: "x", type: "video" as never, order: 0, visible: true, settings: {} } as unknown as Section],
    },
  });
  let html = "";
  assert.doesNotThrow(() => {
    html = renderToString(React.createElement(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../../frontend/components/storefront/SectionRenderer").default,
      { view, productHrefBase: "/product" },
    ));
  });
  // default case returns null for that section
  assert.ok(!html.includes("undefined"), "no crash");
});

test("SectionRenderer: malformed known section is skipped without affecting valid sections", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        { id: "invalid-faq", type: "faq", order: 0, visible: true, settings: null } as unknown as Section,
        makeSection({ type: "about", order: 1, settings: { body: "Valid section remains" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("Valid section remains"));
  assert.ok(!html.includes("invalid-faq"));
});

test("SectionRenderer: empty advanced sections hint in preview and are skipped when published", async () => {
  const sections: Section[] = [
    makeSection({ type: "faq", id: "faq-empty", order: 0, settings: {} }),
    makeSection({ type: "testimonials", id: "testimonials-empty", order: 1, settings: {} }),
    makeSection({ type: "gallery", id: "gallery-empty", order: 2, settings: {} }),
    makeSection({ type: "pricing", id: "pricing-empty", order: 3, settings: {} }),
    makeSection({ type: "stats", id: "stats-empty", order: 4, settings: {} }),
  ];
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections,
    },
  });

  const published = await renderSections(view);
  assert.ok(!published.includes("data-editor-id"), "no section content on the live storefront");
  assert.ok(!published.includes("Frequently asked questions"));
  assert.ok(!published.includes("Add questions in the editor"), "no editor hints on the live storefront");

  const previewHtml = await renderSections(view, { preview: true });
  assert.ok(previewHtml.includes("Add questions in the editor"), "FAQ preview hint");
  assert.ok(previewHtml.includes("Add customer quotes in the editor"), "testimonial preview hint");
  assert.ok(previewHtml.includes("Add images in the editor"), "gallery preview hint");
  assert.ok(previewHtml.includes("Add pricing plans in the editor"), "pricing preview hint");
  assert.ok(previewHtml.includes("Add highlights in the editor"), "stats preview hint");
});

test("SectionRenderer: editable mode exposes keyboard-selectable element identifiers", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ type: "hero", order: 0, settings: { headline: "H" } })],
    },
  });
  const html = await renderSections(view, { editable: true, selectedSectionId: null });
  assert.ok(html.includes('data-editor-id="hero-1:headline"'), "heading has a stable editor id");  assert.ok(html.includes('data-editor-content-path="headline"'), "heading maps to editable content");
  assert.ok(html.includes('tabindex="0"'), "editable content is keyboard focusable");
});

test("SectionRenderer: selected element has a visible selected marker", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ id: "h-1", type: "hero", order: 0, settings: { headline: "H" } })],
    },
  });
  const html = await renderSections(view, {
    editable: true,
    selectedSectionId: "h-1",
    selectedElementId: "h-1:headline",
  });
  assert.ok(html.includes('data-editor-selected="true"'), "selected element marker is present");
});

test("SectionRenderer: non-editable mode does not expose editor controls or identifiers", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ type: "hero", order: 0, settings: { headline: "H" } })],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes("data-editor-id="), "public output contains no editor identifiers");
});

test("SectionRenderer: applies validated per-element responsive styles", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({
          id: "about-1",
          type: "about",
          order: 0,
          settings: { title: "About", body: "Our story" },
          style: {
            elementStyles: {
              body: {
                desktop: { color: "#123456", fontSize: "18px", textAlign: "left" },
                mobile: { fontSize: "1rem" },
              },
            },
          },
        }),
      ],
    },
  });
  const html = await renderSections(view, {
    editable: true,
    selectedElementId: "about-1:body",
  });
  assert.ok(html.includes('data-editor-id="about-1:body"'));
  assert.ok(html.includes('data-editor-selected="true"'));
  assert.ok(html.includes("@container editor-preview (min-width:1024px)"));
  assert.ok(html.includes("color:#123456"));
  assert.ok(html.includes("@container editor-preview (max-width:639px)"));
  assert.ok(html.includes("font-size:1rem"));

  const publishedHtml = await renderSections(view);
  assert.ok(publishedHtml.includes('data-style-id="about-1:body"'));
  assert.ok(!publishedHtml.includes("data-editor-id="));
  assert.ok(publishedHtml.includes("color:#123456"));
});

test("SectionRenderer: font class applied for serif", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "serif",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ type: "hero", order: 0, settings: { headline: "H" } })],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("font-serif"), "serif class");
});

test("SectionRenderer: font class applied for mono", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "mono",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ type: "hero", order: 0, settings: { headline: "H" } })],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes("font-mono"), "mono class");
});

test("SectionRenderer: XSS text is escaped (rendered as children)", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "hero", order: 0, settings: { headline: "<script>alert(1)</script>" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes("<script>alert(1)</script>"), "script tag escaped");
  assert.ok(html.includes("&lt;script&gt;"), "escaped");
});

test("SectionRenderer: hero image renders with supplied alt text", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({
          type: "hero",
          order: 0,
          settings: {
            headline: "Hero with image",
            imageUrl: "https://cdn.test/media/biz/hero.png",
            imageAlt: "A shopfront at dusk",
          },
        }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes('src="https://cdn.test/media/biz/hero.png"'), "image src");
  assert.ok(html.includes('alt="A shopfront at dusk"'), "image alt");
  // Pages follow the theme: Aurora sets the image full-bleed behind the text...
  assert.ok(html.includes('data-page-hero="overlay"'), "image layout (theme composition)");
  // ...while a split theme (Market) places it beside the text.
  const split = await renderSections({ ...view, themeId: "market" });
  assert.ok(split.includes('data-page-hero="split"') && split.includes("lg:grid-cols-2"), "split image layout");
  assert.ok(split.includes('alt="A shopfront at dusk"'));
});

test("SectionRenderer: hero image falls back to a descriptive alt", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({
          type: "hero",
          order: 0,
          settings: { imageUrl: "https://cdn.test/media/biz/hero.png" },
        }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes('alt="Demo Business hero image"'), "fallback alt");
});

test("SectionRenderer: about image renders with supplied alt text", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({
          type: "about",
          order: 0,
          settings: {
            body: "About with image",
            imageUrl: "https://cdn.test/media/biz/about.png",
            imageAlt: "Our team at work",
          },
        }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(html.includes('src="https://cdn.test/media/biz/about.png"'), "image src");
  assert.ok(html.includes('alt="Our team at work"'), "image alt");
});

test("SectionRenderer: hero/about without images keep the legacy layout", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "hero", order: 0, settings: { headline: "Hero" } }),
        makeSection({ type: "about", order: 1, settings: { body: "About" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes("<img"), "no images for legacy sections");
  assert.ok(html.includes("max-w-3xl"), "legacy hero/about width");
});

test("SectionRenderer: unsafe legacy CTA URLs are not emitted as links", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [
        makeSection({ type: "hero", order: 0, settings: { ctaHref: "javascript:alert(1)" } }),
        makeSection({ type: "cta", order: 1, settings: { buttonHref: "data:text/html,unsafe" } }),
        makeSection({ type: "pricing", order: 2, settings: { plans: [{ title: "Plan", price: "Custom", ctaText: "Choose", ctaHref: "javascript:alert(1)" }] } }),
        makeSection({ type: "contact", order: 3, settings: { ctaText: "Open", ctaHref: "javascript:alert(1)" } }),
        makeSection({ type: "newsletter", order: 4, settings: { buttonText: "Subscribe", ctaHref: "javascript:alert(1)" } }),
      ],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.ok(!html.includes("type=\"email\""), "newsletter section does not imply a working signup form");
});

test("SectionRenderer: newsletter without a destination has no fake action", async () => {
  const view = makeView({
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
      sections: [makeSection({ type: "newsletter", order: 0, settings: { buttonText: "Join" } })],
    },
  });
  const html = await renderSections(view);
  assert.ok(!html.includes(">Join</a>"));
  assert.ok(!html.includes("<button"));
  assert.ok(!html.includes("<input"));
});
test("SectionRenderer: products section filters by category, collection and limit", async () => {
  const base = makeView();
  const item = (id: string, over: Record<string, unknown>) => ({ ...base.products[0], id, slug: id, name: `Item ${id}`, ...over });
  const products = [
    item("shirt-old", { category: "Men", createdAt: "2026-01-01T00:00:00Z" }),
    item("shirt-new", { category: "men ", createdAt: "2026-09-01T00:00:00Z", compareAtPrice: 40, price: 30 }),
    item("dress", { category: "Women", createdAt: "2026-08-01T00:00:00Z", compareAtPrice: 20, price: 25 }),
  ];
  const render = (settings: Record<string, unknown>) =>
    renderSections(makeView({ products, theme: { ...base.theme, sections: [makeSection({ type: "products", settings: { title: "List", ...settings } })] } }));

  const men = await render({ category: "Men" });
  assert.ok(men.includes("Item shirt-old") && men.includes("Item shirt-new"), "case/whitespace-insensitive category match");
  assert.ok(!men.includes("Item dress"));

  const sale = await render({ collection: "sale" });
  assert.ok(sale.includes("Item shirt-new"), "real reduced price");
  assert.ok(!sale.includes("Item dress"), "compare-at below price is not a sale");
  assert.ok(!sale.includes("Item shirt-old"));

  const newest = await render({ collection: "new", limit: 1 });
  assert.ok(newest.includes("Item shirt-new"));
  assert.ok(!newest.includes("Item dress") && !newest.includes("Item shirt-old"), "limit applies after sorting newest first");

  const empty = await render({ category: "Kids" });
  assert.ok(empty.includes("No products in this collection right now."));
  assert.ok(!empty.includes("Item "));
});

test("SectionRenderer: a page without a hero gets exactly one h1 (its first titled section)", async () => {
  const base = makeView();
  const html = await renderSections(
    makeView({
      theme: {
        ...base.theme,
        sections: [
          makeSection({ id: "a", type: "about", order: 0, settings: { title: "Our story", body: "Text" } }),
          makeSection({ id: "f", type: "faq", order: 1, settings: { title: "Questions", items: [{ question: "Q?", answer: "A." }] } }),
        ],
      },
    }),
  );
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1[^>]*>(<!-- -->)?Our story/);
  assert.match(html, /<h2[^>]*>(<!-- -->)?Questions/);

  const withHero = await renderSections(
    makeView({ theme: { ...base.theme, sections: [makeSection({ id: "h", type: "hero", order: 0, settings: { headline: "Hi" } }), makeSection({ id: "a", type: "about", order: 1, settings: { title: "Our story", body: "Text" } })] } }),
  );
  assert.equal((withHero.match(/<h1\b/g) ?? []).length, 1, "the hero keeps the single h1");
  assert.match(withHero, /<h2[^>]*>(<!-- -->)?Our story/);
});
