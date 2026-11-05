import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontProduct, StorefrontView } from "../../lib/storefront";
import { buildCommerceData } from "../../lib/storefront-home";
import { THEME_IDS, type ThemeId } from "../../lib/constants";
import { THEMES } from "../../lib/themes";
import { STORE_SKINS, accountVars, skinFor, storeRootProps } from "../../components/storefront/commerce/skins";
import { THEME_COMPONENTS, resolveThemeComponent } from "../../themes/registry";

/**
 * The nine-theme collection (docs/storefront-commerce.md, "Theme collection"):
 * every theme is complete, genuinely different in composition (not a
 * colourway), renders through the one shared renderer with the same real
 * data, and its motion never hides server-rendered content.
 */

const NOW = new Date("2026-10-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function product(id: string, over: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: id.padStart(24, "a"),
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: "Made by hand.",
    price: 100,
    currency: "USD",
    imageUrl: `https://cdn.example.com/p${id}.jpg`,
    category: "",
    compareAtPrice: null,
    availability: "in_stock",
    createdAt: daysAgo(400),
    ...over,
  };
}

function view(themeId: ThemeId, products: StorefrontProduct[], over: Partial<StorefrontView> = {}): StorefrontView {
  return {
    id: "b".repeat(24),
    name: "Demo Store",
    subdomain: "demo",
    category: "retail",
    about: "We make things.",
    logoUrl: "",
    contactEmail: "help@example.com",
    phone: "",
    address: "",
    currency: "USD",
    themeId,
    theme: { primaryColor: "#4f46e5", accentColor: "#0ea5e9", font: "sans", heroHeadline: "Hello", heroSubheadline: "", about: "", showProducts: true },
    products,
    removeBranding: false,
    ...over,
  };
}

const ITEMS = [
  product("1", { name: "Green Tea", category: "Tea", compareAtPrice: 150, createdAt: daysAgo(2), hoverImageUrl: "https://cdn.example.com/p1-b.jpg" }),
  product("2", { name: "Black Coffee", category: "Coffee", availability: "out_of_stock" }),
  product("3", {
    name: "Cocoa",
    category: "Cocoa",
    availability: "low_stock",
    options: [{ name: "Size", values: ["Small", "Large"] }],
    variants: [
      { id: "v1", options: [{ name: "Size", value: "Small" }], label: "Small", price: 8, compareAtPrice: null, availability: "low_stock" },
      { id: "v2", options: [{ name: "Size", value: "Large" }], label: "Large", price: 12, compareAtPrice: null, availability: "in_stock" },
    ],
  }),
];

const CONFIG = {
  announcement: { enabled: true, text: "Free delivery today" },
  sections: [
    { id: "categories", type: "categories" },
    { id: "featured", type: "featured" },
    { id: "story", type: "story" },
  ],
};

async function render(themeId: ThemeId, products = ITEMS, over: Partial<StorefrontView> = {}, props: { editable?: boolean; preview?: boolean } = {}) {
  const { default: ThemeRenderer } = await import("../../components/storefront/ThemeRenderer");
  const v = view(themeId, products, over);
  const commerce = buildCommerceData(v, CONFIG, { now: NOW, pageSlugs: [], accountsEnabled: false });
  return renderToString(React.createElement(ThemeRenderer, { view: v, productHrefBase: "/product", commerce, ...props }));
}

test("every theme id has metadata, a registered component and a complete skin", () => {
  assert.deepEqual(THEMES.map((t) => t.id), [...THEME_IDS]);
  for (const id of THEME_IDS) {
    assert.ok(THEME_COMPONENTS[id], `${id}: component`);
    const skin = STORE_SKINS[id];
    assert.equal(skin.id, id);
    for (const key of ["header", "heading", "hero", "rail", "card", "categories", "benefits", "promo", "story", "footer", "productPage", "gallery", "catalog", "account"] as const) {
      assert.ok(skin.layout[key], `${id}: layout.${key}`);
    }
    assert.match(skin.grid, /grid-cols-/, `${id}: grid`);
    assert.match(skin.catalogGrid, /grid-cols-/, `${id}: catalog grid`);
    assert.match(skin.media, /^aspect-/, `${id}: fixed media proportion (no layout shift)`);
    assert.match(skin.fonts.display, /^var\(--sf-font-/, `${id}: system font stack only`);
    assert.match(skin.motion.duration, /^\d(\.\d+)?s$/, `${id}: motion duration`);
    // Tailwind only generates literal classes: no interpolation left in any token.
    for (const [key, value] of Object.entries(skin)) {
      if (typeof value === "string") assert.ok(!value.includes("${"), `${id}.${key}: literal classes`);
    }
    const meta = THEMES.find((t) => t.id === id)!;
    assert.ok(meta.name && meta.tagline && meta.description && meta.palette.length === 3, `${id}: metadata`);
  }
  assert.equal(skinFor("unknown").id, "aurora", "unknown ids fall back like the registry");
  assert.equal(resolveThemeComponent("unknown"), THEME_COMPONENTS.aurora);
});

test("nine genuinely different compositions, not colourways of one layout", () => {
  const signatures = THEME_IDS.map((id) => {
    const l = STORE_SKINS[id].layout;
    return `${l.hero}|${l.card}|${l.categories}`;
  });
  assert.equal(new Set(signatures).size, 9, "hero, card and category compositions differ for every theme");
  assert.equal(new Set(THEME_IDS.map((id) => STORE_SKINS[id].layout.hero)).size, 9, "nine hero compositions");
  assert.equal(new Set(THEME_IDS.map((id) => STORE_SKINS[id].layout.card)).size, 9, "nine card compositions");
  assert.equal(new Set(THEME_IDS.map((id) => STORE_SKINS[id].layout.categories)).size, 9, "nine category compositions");
  for (const key of ["header", "heading", "rail", "benefits", "promo", "story", "footer"] as const) {
    assert.equal(new Set(THEME_IDS.map((id) => STORE_SKINS[id].layout[key])).size, 9, `nine ${key} compositions`);
  }
});

test("rails, headers and footers really differ in the rendered store, and the data does not", async () => {
  const many = Array.from({ length: 8 }, (_, i) => product(String(i + 10), { name: `Item ${i + 10}`, category: i % 2 ? "Tea" : "Coffee" }));
  const pages = await Promise.all(THEME_IDS.map((id) => render(id, many)));
  assert.equal(new Set(pages.map((html) => /data-footer="(\w+)"/.exec(html)?.[1])).size, 9, "nine footers");
  assert.ok(pages[THEME_IDS.indexOf("launch")].includes("lg:row-span-2"), "Launch sets one large product");
  assert.ok(pages[THEME_IDS.indexOf("harvest")].includes("snap-x"), "Harvest shelves scroll sideways");
  assert.ok(pages[THEME_IDS.indexOf("studio")].includes("lg:sticky"), "Studio's heading has its own column");
  for (const [i, id] of THEME_IDS.entries()) {
    for (const item of many) assert.ok(pages[i].includes(item.name) && pages[i].includes(`/product/${item.slug}`), `${id}: ${item.name} and its address`);
  }
});

test("account tokens exist for every theme and account pages never need platform styles", () => {
  for (const id of THEME_IDS) {
    const vars = accountVars(STORE_SKINS[id]) as Record<string, string>;
    for (const key of ["--acc-surface", "--acc-text", "--acc-muted", "--acc-line", "--acc-field", "--acc-danger", "--acc-radius", "--acc-control"]) {
      assert.ok(vars[key], `${id}: ${key}`);
    }
  }
});

test("each theme renders its own composition through the shared renderer, with the same real data", async () => {
  for (const id of THEME_IDS) {
    const skin = STORE_SKINS[id];
    const html = await render(id);
    assert.ok(html.includes(`data-theme="${id}"`), `${id}: theme root`);
    assert.ok(html.includes(`data-layout="${skin.layout.header}"`), `${id}: header composition`);
    assert.ok(html.includes(`data-hero="${skin.layout.hero}"`), `${id}: hero composition`);
    assert.ok(html.includes(`data-card="${skin.layout.card}"`), `${id}: card composition`);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${id}: one h1`);
    // The same facts in every theme.
    for (const fact of ["Green Tea", "Black Coffee", "Cocoa", "Sold out", "Only a few left", "Add Green Tea to cart", "Choose options for Cocoa", 'href="/products?category=Tea"', "Free delivery today"]) {
      assert.ok(html.includes(fact), `${id}: ${fact}`);
    }
    assert.ok(/−(<!-- -->)?33(<!-- -->)?%/.test(html), `${id}: real discount`);
    for (const fabricated of ["review", "rating", "★", "testimonial", "Best sellers"]) {
      assert.ok(!html.toLowerCase().includes(fabricated.toLowerCase()), `${id}: no "${fabricated}"`);
    }
  }
});

test("the owner's brand colour is visible in every theme's header, even for an empty store without a logo", async () => {
  for (const id of THEME_IDS) {
    const html = await render(id, []);
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    assert.ok(/background:\s*#4f46e5/i.test(header), `${id}: brand colour in the header`);
  }
});

test("theme typography and motion tokens are set on the root; the owner's serif or mono choice wins", async () => {
  const atelier = await render("atelier");
  assert.match(atelier, /--sf-display:var\(--sf-font-didone\)/);
  assert.match(atelier, /--sf-ease:cubic-bezier/);
  const serif = await render("atelier", ITEMS, { theme: { ...view("atelier", []).theme, font: "serif" } });
  assert.match(serif, /--sf-display:var\(--sf-font-serif\)/);
  assert.match(serif, /--sf-body:var\(--sf-font-serif\)/);
  const props = storeRootProps(STORE_SKINS.volt, { font: "mono", primaryColor: "#22d3ee", accentColor: "#6366f1" });
  assert.equal((props.style as Record<string, string>)["--sf-display"], "var(--sf-font-mono)");
  assert.equal((props.style as Record<string, string>)["--sf-on-primary"], "#111827", "readable text on a light brand colour");
});

test("motion never hides server-rendered content and stays out of the editor", async () => {
  for (const id of THEME_IDS) {
    const html = await render(id);
    assert.ok(html.includes("data-reveal"), `${id}: reveal targets exist`);
    assert.ok(!html.includes("data-reveal-state"), `${id}: nothing is hidden by the server`);
    assert.ok(/<span hidden=""><\/span>/.test(html), `${id}: the motion island is mounted on the public store`);
    const editor = await render(id, ITEMS, {}, { editable: true, preview: true });
    assert.ok(!/<span hidden=""><\/span>/.test(editor), `${id}: no motion island in the editor`);
  }
});

test("the second image appears only where the theme uses image rollover and only when a different real image exists", async () => {
  for (const id of THEME_IDS) {
    const html = await render(id);
    const rollover = ["lift", "couture", "plain", "gallery"].includes(STORE_SKINS[id].layout.card);
    assert.equal(html.includes("p1-b.jpg"), rollover, `${id}: rollover image`);
  }
  const none = await render("atelier", [product("9", { hoverImageUrl: undefined })]);
  assert.ok(!none.includes("group-hover:opacity-100"), "no rollover without a second image");
});

test("Launch's marquee shows real category names once to assistive tech; the Harvest dock and Volt option chips are theme-specific", async () => {
  const launch = await render("launch");
  assert.ok(launch.includes("sf-marquee"), "marquee");
  assert.ok(launch.includes('aria-hidden="true"') && launch.includes("sf-marquee-copy"), "loop copies are decorative");
  for (const id of THEME_IDS.filter((t) => t !== "launch")) assert.ok(!(await render(id)).includes("sf-marquee"), `${id}: no marquee`);

  const harvest = await render("harvest");
  assert.ok(harvest.includes('aria-label="Quick links"'), "harvest dock");
  assert.ok(!(await render("market")).includes('aria-label="Quick links"'), "no dock elsewhere");

  const volt = await render("volt");
  assert.ok(volt.includes('aria-label="Size options"') && volt.includes(">Small<") && volt.includes(">Large<"), "real option values as chips");
});

test("theme thumbnails render for every theme from its own skin", async () => {
  const { default: ThemeThumbnail } = await import("../../components/dashboard/ThemeThumbnail");
  for (const id of THEME_IDS) {
    const html = renderToString(React.createElement(ThemeThumbnail, { themeId: id }));
    assert.ok(html.includes(`data-thumb="${id}"`) && html.includes('aria-hidden="true"'), `${id}: decorative thumbnail`);
  }
});

test("a store without chosen colours uses its theme's palette and follows it; chosen colours always win", async () => {
  const { DEFAULT_THEME_SETTINGS, themeBrandColors } = await import("../../lib/storefront");
  for (const id of THEME_IDS) {
    const meta = THEMES.find((t) => t.id === id)!;
    assert.deepEqual(themeBrandColors(id, DEFAULT_THEME_SETTINGS), { primaryColor: meta.palette[1], accentColor: meta.palette[2], usesThemeColors: true }, id);
    assert.deepEqual(themeBrandColors(id, { primaryColor: "#123456", accentColor: DEFAULT_THEME_SETTINGS.accentColor }), { primaryColor: "#123456", accentColor: DEFAULT_THEME_SETTINGS.accentColor, usesThemeColors: false }, id);
  }
});

test("automatic rails that only repeat products already shown stay off the page; the rest stay", async () => {
  const { repeatedRailIds } = await import("../../lib/storefront-home");
  const data = buildCommerceData(view("market", ITEMS), { sections: [{ id: "featured", type: "featured", title: "Featured" }, { id: "new", type: "newArrivals", title: "New" }, { id: "sale", type: "sale", title: "Sale" }] }, { now: NOW, pageSlugs: [], accountsEnabled: false });
  const repeated = repeatedRailIds(data.sections);
  assert.ok(repeated.has("new"), "new arrivals repeat the featured products");
  assert.ok(!repeated.has("featured") && !repeated.has("sale"));
});

test("every theme has its own typeface, and a hero without any image still has a composition", async () => {
  const faces = new Set(THEME_IDS.map((id) => STORE_SKINS[id].fonts.display));
  assert.ok(faces.size >= 8, "almost every theme has its own display face");
  for (const id of THEME_IDS) {
    const html = await render(id, []);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${id}: one h1`);
    assert.ok(!html.includes("<img"), `${id}: no invented images`);
  }
});

test("every theme has a finished sample store: photos on disk, a preview picture, and no invented sales or ratings", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { sampleCommerceData, sampleStoreView } = await import("../../components/marketing/sample-store");
  const onDisk = (url: string) => fs.existsSync(path.join(process.cwd(), "public", url));
  for (const id of THEME_IDS) {
    const view = sampleStoreView(id);
    const commerce = sampleCommerceData(id);
    assert.ok(view.products.length >= 5, `${id}: enough products for its layouts`);
    for (const product of view.products) {
      assert.ok(onDisk(product.imageUrl), `${id}: ${product.imageUrl}`);
      assert.equal(product.compareAtPrice, null, `${id}: no invented discount`);
      assert.equal(product.rating, undefined, `${id}: no invented rating`);
    }
    assert.ok(commerce.hero?.imageUrl && onDisk(commerce.hero.imageUrl), `${id}: hero photo`);
    assert.ok(commerce.promotions.length > 0, `${id}: promotions kept by the config`);
    for (const promo of commerce.promotions) assert.ok(onDisk(promo.imageUrl), `${id}: ${promo.imageUrl}`);
    assert.ok(onDisk(`theme-previews/${id}.webp`) && onDisk(`theme-previews/${id}-mobile.webp`), `${id}: preview pictures`);
  }
});

test("owner configs still refuse sample photos: only media-library images are accepted", async () => {
  const { readStorefrontConfig } = await import("../../lib/storefront-config");
  const config = readStorefrontConfig({ hero: { imageUrl: "/samples/hero-aurora.webp" } }, "retail");
  assert.equal(config.hero.imageUrl, "", "a local sample path never reaches an owner's hero");
});
