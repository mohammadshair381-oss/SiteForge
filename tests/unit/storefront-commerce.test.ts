import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";

(globalThis as unknown as { React?: typeof React }).React = React;

import type { StorefrontProduct, StorefrontView } from "../../lib/storefront";
import {
  DEFAULT_STOREFRONT_CONFIG,
  orderedHomeSections,
  readStorefrontConfig,
  resolveInternalHref,
  storefrontConfigSchema,
  HOME_SECTION_KEYS,
} from "../../lib/storefront-config";
import { buildCommerceData, discountPercent } from "../../lib/storefront-home";
import { THEME_IDS } from "../../lib/constants";
import { isValidCompareAtPrice, productCreateSchema } from "../../lib/validation";

const NOW = new Date("2026-10-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function product(id: string, over: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: id.padStart(24, "a"),
    name: `Product ${id}`,
    slug: `product-${id}`,
    description: "",
    price: 100,
    currency: "INR",
    imageUrl: "",
    category: "",
    compareAtPrice: null,
    availability: "in_stock",
    createdAt: daysAgo(400),
    ...over,
  };
}

function view(products: StorefrontProduct[], over: Partial<StorefrontView> = {}): StorefrontView {
  return {
    id: "b".repeat(24),
    name: "Demo Store",
    subdomain: "demo",
    category: "retail",
    about: "",
    logoUrl: "",
    contactEmail: "",
    phone: "",
    address: "",
    currency: "INR",
    themeId: "market",
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Theme headline",
      heroSubheadline: "Theme copy",
      about: "",
      showProducts: true,
    },
    products,
    removeBranding: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

test("storefront config: defaults are the general-retail preset (version 2)", () => {
  assert.equal(DEFAULT_STOREFRONT_CONFIG.version, 2);
  assert.equal(DEFAULT_STOREFRONT_CONFIG.preset, "general");
  assert.equal(DEFAULT_STOREFRONT_CONFIG.hero.enabled, true);
  assert.deepEqual(
    DEFAULT_STOREFRONT_CONFIG.sections.map((s) => [s.type, s.title]),
    [["categories", "Shop by category"], ["featured", "Featured products"], ["newArrivals", "New arrivals"], ["bestSellers", "Best sellers"], ["promotions", ""], ["story", ""], ["benefits", "Shopping information"]],
  );
  // The version-1 helper still lists every key once.
  assert.deepEqual(orderedHomeSections(DEFAULT_STOREFRONT_CONFIG).map((s) => s.key).sort(), [...HOME_SECTION_KEYS].sort());
});

test("storefront config: rejects HTML, external or script links and foreign social hosts", () => {
  const bad = [
    { hero: { headline: "<script>x</script>" } },
    { hero: { primaryCta: { label: "Go", href: "https://evil.example" } } },
    { hero: { primaryCta: { label: "Go", href: "javascript:alert(1)" } } },
    { hero: { primaryCta: { label: "Go", href: "//evil.example/x" } } },
    { announcement: { enabled: true, text: "Hi", href: "http://x.test" } },
    { hero: { imageUrl: "http://insecure.example/a.png" } },
    { hero: { imageUrl: "javascript:alert(1)" } },
    // Bare local paths are rewritten to /store/... on store hosts and never load.
    { hero: { imageUrl: "/images/hero.png" } },
    { hero: { imageUrl: "/api/businesses/not-an-id/local-media?key=abc" } },
    { footer: { social: { instagram: "https://evil.example/instagram.com" } } },
    { footer: { social: { facebook: "http://facebook.com/demo" } } },
    { sections: [{ key: "featured", enabled: true }, { key: "featured", enabled: false }] },
    { categories: [{ name: "Tea" }, { name: "tea" }] },
    { featuredProductIds: ["not-an-id"] },
    { promotions: [{}, {}, {}, {}] },
    { hero: { overlay: 95 } },
  ];
  for (const input of bad) {
    assert.equal(storefrontConfigSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("storefront config: accepts store links, HTTPS images and allowed social profiles", () => {
  const parsed = storefrontConfigSchema.parse({
    hero: { primaryCta: { label: "Shop tea", href: "/products?category=Tea" }, imageUrl: "https://cdn.example.com/hero.jpg" },
    footer: { social: { instagram: "https://www.instagram.com/demo", x: "https://x.com/demo" } },
  });
  assert.equal(parsed.hero.primaryCta.href, "/products?category=Tea");
  assert.equal(parsed.footer.social.instagram, "https://www.instagram.com/demo");
  const local = `/api/businesses/${"a".repeat(24)}/local-media?key=bWVkaWEvYS9iLnBuZw==`;
  assert.equal(storefrontConfigSchema.parse({ hero: { imageUrl: local } }).hero.imageUrl, local);
});

test("storefront config: a broken stored value falls back to defaults", () => {
  assert.deepEqual(readStorefrontConfig({ hero: { headline: 42 } }), DEFAULT_STOREFRONT_CONFIG);
  assert.deepEqual(readStorefrontConfig(null), DEFAULT_STOREFRONT_CONFIG);
});

test("resolveInternalHref keeps only links that lead somewhere real", () => {
  const targets = {
    productSlugs: new Set(["mug"]),
    categories: new Set(["tea"]),
    pageSlugs: new Set(["about"]),
    hasPolicies: false,
  };
  assert.equal(resolveInternalHref("/", targets), "/");
  assert.equal(resolveInternalHref("/cart", targets), "/cart");
  assert.equal(resolveInternalHref("/products", targets), "/products");
  assert.equal(resolveInternalHref("/products?category=Tea", targets), "/products?category=Tea");
  assert.equal(resolveInternalHref("/products?category=Coffee", targets), null);
  assert.equal(resolveInternalHref("/product/mug", targets), "/product/mug");
  assert.equal(resolveInternalHref("/product/gone", targets), null);
  assert.equal(resolveInternalHref("/about", targets), "/about");
  assert.equal(resolveInternalHref("/draft-page", targets), null);
  assert.equal(resolveInternalHref("/policies", targets), null);
  assert.equal(resolveInternalHref("/policies", { ...targets, hasPolicies: true }), "/policies");
  assert.equal(resolveInternalHref("https://evil.example", targets), null);
  assert.equal(resolveInternalHref("", targets), null);
});

// ---------------------------------------------------------------------------
// Sale pricing
// ---------------------------------------------------------------------------

test("compare-at price: on sale only when strictly higher than the price", () => {
  assert.equal(isValidCompareAtPrice(100, null), true);
  assert.equal(isValidCompareAtPrice(100, undefined), true);
  assert.equal(isValidCompareAtPrice(100, 120), true);
  assert.equal(isValidCompareAtPrice(100, 100), false);
  assert.equal(isValidCompareAtPrice(100, 80), false);
  assert.equal(productCreateSchema.safeParse({ name: "A", price: 100, compareAtPrice: 90 }).success, false);
  assert.equal(productCreateSchema.safeParse({ name: "A", price: 100, compareAtPrice: "" }).success, true);
  assert.equal(discountPercent({ price: 75, compareAtPrice: 100 }), 25);
  assert.equal(discountPercent({ price: 100, compareAtPrice: 100 }), null);
  assert.equal(discountPercent({ price: 100, compareAtPrice: null }), null);
});

// ---------------------------------------------------------------------------
// Homepage data: nothing invented, empty sections hidden
// ---------------------------------------------------------------------------

test("homepage data: empty store shows no product sections and no shop button", () => {
  const data = buildCommerceData(view([]), undefined, { now: NOW });
  assert.deepEqual(data.sectionOrder, []);
  assert.equal(data.hero?.primaryCta, null);
  assert.equal(data.hero?.headline, "Theme headline");
  assert.deepEqual(data.footer.shopLinks, []);
  assert.deepEqual(data.benefits, []);
});

test("homepage data: best sellers only from real order data, with a minimum", () => {
  const items = [product("1"), product("2"), product("3")];
  assert.deepEqual(buildCommerceData(view(items), undefined, { now: NOW }).bestSellers, []);
  assert.deepEqual(buildCommerceData(view(items), undefined, { now: NOW, bestSellerIds: [items[0].id] }).bestSellers, []);
  const data = buildCommerceData(view(items), undefined, { now: NOW, bestSellerIds: [items[2].id, items[0].id, "c".repeat(24)] });
  assert.deepEqual(data.bestSellers.map((p) => p.id), [items[2].id, items[0].id]);
  assert.ok(data.sectionOrder.includes("bestSellers"));
});

test("homepage data: sale and new arrivals come from real prices and dates", () => {
  const items = [
    product("1", { compareAtPrice: 150, createdAt: daysAgo(3) }),
    product("2", { compareAtPrice: 100 }), // equal: not a sale
    product("3", { createdAt: daysAgo(10) }),
    product("4"),
  ];
  const data = buildCommerceData(view(items), { featuredProductIds: [items[3].id] }, { now: NOW });
  assert.deepEqual(data.sale.map((p) => p.id), [items[0].id]);
  assert.deepEqual(data.newArrivals.map((p) => p.id), [items[0].id, items[2].id]);
  assert.deepEqual(data.featured.map((p) => p.id), [items[3].id]);
  assert.equal(data.featuredTitle, "Featured products");
});

test("homepage data: new arrivals are hidden when they repeat the featured list", () => {
  const items = [product("1", { createdAt: daysAgo(1) })];
  const data = buildCommerceData(view(items), undefined, { now: NOW });
  assert.deepEqual(data.newArrivals, []);
  // The general preset titles its product collection "Featured products".
  assert.equal(data.featuredTitle, "Featured products");
  assert.ok(data.hiddenSections.some((h) => h.id === "new-arrivals" && /Same products/.test(h.reason)));
});

test("homepage data: categories need two real categories with products", () => {
  const one = buildCommerceData(view([product("1", { category: "Tea" })]), undefined, { now: NOW });
  assert.equal(one.sectionOrder.includes("categories"), false);
  const two = buildCommerceData(
    view([product("1", { category: "Tea" }), product("2", { category: "Coffee" }), product("3", { category: "tea" })]),
    { categories: [{ name: "Coffee" }, { name: "Cocoa" }, { name: "Tea" }] },
    { now: NOW },
  );
  assert.deepEqual(two.categories.map((c) => [c.name, c.count]), [["Coffee", 1], ["Tea", 2]]);
  assert.ok(two.sectionOrder.includes("categories"));
});

test("homepage data: buttons with dead links and incomplete promotions are dropped", () => {
  const items = [product("1", { category: "Tea" })];
  const data = buildCommerceData(
    view(items),
    {
      hero: { primaryCta: { label: "Coffee", href: "/products?category=Coffee" }, secondaryCta: { label: "About", href: "/about" } },
      promotions: [
        { title: "", text: "No title" },
        { title: "Tea week", cta: { label: "See tea", href: "/products?category=Tea" } },
        { title: "Dead link", cta: { label: "Go", href: "/product/missing" } },
      ],
    },
    { now: NOW, pageSlugs: [] },
  );
  assert.equal(data.hero?.primaryCta, null);
  assert.equal(data.hero?.secondaryCta, null);
  assert.deepEqual(data.promotions.map((p) => [p.title, p.cta?.href ?? null]), [["Tea week", "/products?category=Tea"], ["Dead link", null]]);
  const hidden = buildCommerceData(view(items), { promotions: [{ title: "Hidden", enabled: false }] }, { now: NOW });
  assert.deepEqual(hidden.promotions, []);
  assert.equal(hidden.sectionOrder.includes("promotions"), false);
});

test("homepage data: benefits only state what the store backs", () => {
  const base = view([product("1")], { contactEmail: "help@example.com" });
  const none = buildCommerceData(base, undefined, { now: NOW });
  assert.deepEqual(none.benefits.map((b) => b.key), ["support"]);
  const all = buildCommerceData(base, { benefits: { shipping: "Ships in 2 days" } }, { now: NOW, onlinePayments: true, codAvailable: true });
  assert.deepEqual(all.benefits.map((b) => b.key), ["shipping", "secure", "cod", "support"]);
});

test("homepage data: the show-products switch hides every product rail", () => {
  const items = [product("1", { compareAtPrice: 200 }), product("2")];
  const data = buildCommerceData(view(items, { theme: { ...view([]).theme, showProducts: false } }), undefined, {
    now: NOW,
    bestSellerIds: items.map((p) => p.id),
  });
  for (const key of ["featured", "bestSellers", "newArrivals", "sale"] as const) {
    assert.equal(data.sectionOrder.includes(key), false, key);
  }
});

test("homepage data: owner order and disabled sections are respected", () => {
  const items = [product("1", { compareAtPrice: 200 }), product("2")];
  const data = buildCommerceData(
    view(items, { about: "Our story" }),
    { sections: [{ key: "story", enabled: true }, { key: "featured", enabled: false }] },
    { now: NOW },
  );
  assert.deepEqual(data.sectionOrder, ["story", "sale"]);
});

test("homepage data: policies link only with policy text and a free /policies path", () => {
  const items = [product("1")];
  const withText = { policies: { shipping: "We ship daily." } };
  assert.equal(buildCommerceData(view(items), withText, { now: NOW }).hasPolicies, true);
  assert.equal(buildCommerceData(view(items), withText, { now: NOW, pageSlugs: ["policies"] }).hasPolicies, false);
  assert.equal(buildCommerceData(view(items), undefined, { now: NOW }).hasPolicies, false);
});

// ---------------------------------------------------------------------------
// Rendering: every theme, no fabricated content, accessible controls
// ---------------------------------------------------------------------------

const THEMES = THEME_IDS;

async function renderStore(themeId: (typeof THEMES)[number], products: StorefrontProduct[], config?: unknown) {
  const { default: ThemeRenderer } = await import("../../components/storefront/ThemeRenderer");
  const v = view(products, {
    themeId,
    about: "We make tea.",
    contactEmail: "help@example.com",
    navigation: { header: [{ pageId: "p1", label: "About", slug: "about" }], footer: [{ pageId: "p2", label: "Contact", slug: "contact" }] },
  });
  const commerce = buildCommerceData(v, config, { now: NOW, pageSlugs: ["about", "contact"], accountsEnabled: true });
  return renderToString(React.createElement(ThemeRenderer, { view: v, productHrefBase: "/product", commerce }));
}

test("commerce homepage renders in every theme with header, footer and real data only", async () => {
  const items = [
    product("1", { name: "Green Tea", category: "Tea", compareAtPrice: 150, createdAt: daysAgo(2) }),
    product("2", { name: "Black Coffee", category: "Coffee", availability: "out_of_stock" }),
    product("3", { name: "Cocoa", category: "Cocoa", availability: "low_stock" }),
  ];
  for (const themeId of THEMES) {
    const html = await renderStore(themeId, items, {
      announcement: { enabled: true, text: "Free delivery today" },
      sections: [
        { id: "categories", type: "categories" },
        { id: "featured", type: "featured" },
        { id: "sale", type: "sale", title: "On sale", subtitle: "Reduced prices" },
        { id: "story", type: "story" },
      ],
    });
    assert.equal((html.match(/<header\b/g) ?? []).length, 1, `${themeId}: one header`);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${themeId}: one h1`);
    assert.ok(html.includes(`data-theme="${themeId}"`), `${themeId}: theme id`);
    assert.ok(html.includes("Free delivery today"), `${themeId}: announcement`);
    assert.ok(html.includes('href="/cart"'), `${themeId}: cart link`);
    // Some headers have a search box and others a search link to the catalog, which has the box.
    assert.ok(html.includes('action="/products"') || /<a href="\/products"[^>]*>(?:(?!<\/a>).)*Search products/.test(html), `${themeId}: search`);
    assert.ok(html.includes('href="/account/login"'), `${themeId}: account link`);
    assert.ok(html.includes('aria-expanded="false"'), `${themeId}: mobile menu button`);
    assert.ok(html.includes('href="/about"') && html.includes('href="/contact"'), `${themeId}: page links`);
    assert.ok(html.includes('href="/products?category=Tea"'), `${themeId}: category link`);
    assert.ok(html.includes('href="/product/product-1"'), `${themeId}: product link`);
    assert.ok(html.includes("Shop by category"), `${themeId}: categories`);
    assert.ok(html.includes("On sale") && /−(<!-- -->)?33(<!-- -->)?%/.test(html), `${themeId}: real discount`);
    assert.ok(html.includes("Sold out"), `${themeId}: stock state`);
    assert.ok(html.includes("Only a few left"), `${themeId}: low stock from real stock`);
    assert.ok(html.includes("Add Green Tea to cart"), `${themeId}: add to cart`);
    assert.ok(html.includes("Powered by SiteForge"), `${themeId}: platform credit`);
    assert.ok(!html.includes('href="#"'), `${themeId}: no dead links`);
    assert.ok(!html.includes("data-editor-id"), `${themeId}: no editor targets when published`);
    for (const fabricated of ["Information coming soon", "review", "rating", "★", "Best sellers", "testimonial"]) {
      assert.ok(!html.toLowerCase().includes(fabricated.toLowerCase()), `${themeId}: no "${fabricated}"`);
    }
  }
});

test("empty store renders a calm empty state without product sections", async () => {
  for (const themeId of THEMES) {
    const html = await renderStore(themeId, []);
    assert.ok(!html.includes("Shop now"), `${themeId}: no shop button`);
    assert.ok(!html.includes("Featured products") && !html.includes("Shop our products"), `${themeId}: no empty rails`);
    assert.ok(!html.includes('action="/products"'), `${themeId}: no search without products`);
    assert.ok(html.includes("We make tea."), `${themeId}: story still shown`);
  }
});

test("removeBranding hides only the platform credit, never the store name", async () => {
  const { default: ThemeRenderer } = await import("../../components/storefront/ThemeRenderer");
  const v = view([product("1")], { removeBranding: true });
  const html = renderToString(React.createElement(ThemeRenderer, { view: v, productHrefBase: "/product" }));
  assert.ok(html.includes("Demo Store"));
  assert.ok(!html.includes("Powered by SiteForge"));
});
