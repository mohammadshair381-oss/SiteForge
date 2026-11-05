import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import RichText from "@/components/storefront/RichText";
import { navigationPageIds, resolveNavItems } from "@/lib/navigation";
import { buildPageTemplate, PAGE_TEMPLATES } from "@/lib/page-templates";
import { createDefaultSection, parseVideoUrl, sectionSchema, SECTION_TYPES } from "@/lib/sections";
import { createHomeSection, HOME_BLOCK_TYPES, HOME_SECTION_TYPES, homeSectionName, homeSectionSchema } from "@/lib/storefront-config";
import { buttonShapeClass, DEFAULT_STORE_DESIGN, designFontValue, readStoreDesign, storeDesignSchema, textSizeZoom } from "@/lib/design-settings";

test("video links: only YouTube and Vimeo over https", () => {
  assert.equal(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")?.provider, "YouTube");
  assert.equal(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ")?.watchUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(parseVideoUrl("https://vimeo.com/123456789")?.provider, "Vimeo");
  assert.equal(parseVideoUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseVideoUrl("https://evil.example/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(parseVideoUrl("javascript:alert(1)"), null);
  assert.equal(parseVideoUrl(""), null);
});

test("every section type has a valid default and accepts a screen-size choice", () => {
  for (const type of SECTION_TYPES) {
    const section = createDefaultSection(type, 0);
    assert.equal(sectionSchema.safeParse(section).success, true, `${type} default`);
    assert.equal(sectionSchema.safeParse({ ...section, hideOn: "mobile" }).success, true, `${type} hideOn`);
    assert.equal(sectionSchema.safeParse({ ...section, hideOn: "tablet" }).success, false, `${type} bad hideOn`);
  }
});

test("new sections refuse unsafe links and pictures", () => {
  const base = { id: "s1", order: 0, visible: true };
  assert.equal(sectionSchema.safeParse({ ...base, type: "imageText", settings: { ctaHref: "javascript:alert(1)" } }).success, false);
  assert.equal(sectionSchema.safeParse({ ...base, type: "logos", settings: { items: [{ imageUrl: "javascript:alert(1)" }] } }).success, false);
  assert.equal(sectionSchema.safeParse({ ...base, type: "video", settings: { url: "https://evil.example/a" } }).success, false);
  assert.equal(sectionSchema.safeParse({ ...base, type: "video", settings: { url: "https://youtu.be/dQw4w9WgXcQ" } }).success, true);
});

test("homepage blocks: allowed types only, and never offered to the AI's section list", () => {
  const block = createHomeSection("block", [], "richText");
  assert.equal(block.type, "block");
  assert.equal(homeSectionSchema.safeParse(block).success, true);
  assert.equal((HOME_SECTION_TYPES as readonly string[]).includes("block"), false);
  for (const type of HOME_BLOCK_TYPES) assert.equal(homeSectionSchema.safeParse(createHomeSection("block", [], type)).success, true, type);
  // Sections that only make sense on their own page stay out.
  assert.equal(homeSectionSchema.safeParse({ ...block, block: createDefaultSection("hero", 0) }).success, false);
  assert.equal(homeSectionName(block), "A heading");
});

test("rich text: formats safely and never passes HTML through", () => {
  const html = renderToStaticMarkup(
    createElement(RichText, { headingClass: "h", body: "## Title\n\n**bold** and [a link](/products)\n\n- one\n- two\n\n<script>alert(1)</script> [bad](javascript:alert(1))" }),
  );
  assert.match(html, /<strong[^>]*>bold<\/strong>/);
  assert.match(html, /href="\/products"/);
  assert.match(html, /<li[^>]*>one<\/li>/);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes('href="javascript:'), false);
});

test("menus: pages, other links and one level of dropdown", () => {
  const pages = new Map([
    ["a", { title: "About", slug: "about", status: "published" }],
    ["b", { title: "Secret", slug: "secret", status: "draft" }],
  ]);
  const items = [
    { pageId: "a", label: "", order: 1 },
    { pageId: "b", label: "Secret", order: 2 },
    { pageId: "missing", label: "Gone", order: 3 },
    { href: "https://example.com/x", label: "Elsewhere", order: 4 },
    { href: "/products", label: "Shop", order: 0, children: [{ pageId: "a", label: "About us", order: 0 }, { pageId: "b", label: "Hidden", order: 1 }] },
  ];
  const live = resolveNavItems(items, pages, { publishedOnly: true });
  assert.deepEqual(live.map((item) => item.label), ["Shop", "About", "Elsewhere"]);
  assert.equal(live[0].href, "/products");
  assert.deepEqual(live[0].children?.map((child) => child.label), ["About us"]);
  assert.equal(live[2].external, true);
  // The editor also shows unpublished pages, so links can be checked.
  assert.equal(resolveNavItems(items, pages, { publishedOnly: false }).length, 4);
  assert.deepEqual(navigationPageIds({ header: items, footer: [] }).sort(), ["a", "b", "missing"]);
});

test("design: defaults leave the theme alone, and bad stored values fall back", () => {
  assert.equal(designFontValue("theme"), null);
  assert.equal(buttonShapeClass("theme"), "");
  assert.equal(textSizeZoom("normal"), undefined);
  assert.deepEqual(readStoreDesign(undefined), DEFAULT_STORE_DESIGN);
  assert.deepEqual(readStoreDesign({ displayFont: "not-a-font" }), DEFAULT_STORE_DESIGN);
  assert.equal(storeDesignSchema.safeParse({ ...DEFAULT_STORE_DESIGN, buttonShape: "blob" }).success, false);
});

test("page templates: valid sections, no invented facts, unknowns left as placeholders", () => {
  const business = { name: "Acme", contactEmail: "", phone: "", address: "", description: "" };
  for (const template of PAGE_TEMPLATES) {
    const built = buildPageTemplate(template, business);
    for (const section of built) assert.equal(sectionSchema.safeParse(section).success, true, `${template}: ${section.type}`);
  }
  assert.deepEqual(buildPageTemplate("blank", business), []);
  assert.match(JSON.stringify(buildPageTemplate("about", business)), /\[\[/);
});
