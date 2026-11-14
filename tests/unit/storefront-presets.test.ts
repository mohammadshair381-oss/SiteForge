import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import type { StorefrontProduct, StorefrontView } from "../../backend/lib/storefront";
import {
  createHomeSection,
  duplicateHomeSection,
  presetConfig,
  readStorefrontConfig,
  storefrontConfigSchema,
  type HomeSection,
} from "../../backend/lib/storefront-config";
import { storeVocabulary, PRESET_SECTIONS, presetForBusinessType } from "../../backend/lib/storefront-presets";
import { buildCommerceData } from "../../backend/lib/storefront-home";

const NOW = new Date("2026-10-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function product(id: string, over: Partial<StorefrontProduct> = {}): StorefrontProduct {
  return {
    id: id.padStart(24, "a"), name: `Product ${id}`, slug: `product-${id}`, description: "", price: 100, currency: "INR",
    imageUrl: "", category: "", compareAtPrice: null, availability: "in_stock", createdAt: daysAgo(400), ...over,
  };
}

function view(products: StorefrontProduct[], over: Partial<StorefrontView> = {}): StorefrontView {
  return {
    id: "b".repeat(24), name: "Demo Store", subdomain: "demo", category: "retail", about: "", logoUrl: "", contactEmail: "",
    phone: "", address: "", currency: "INR", themeId: "market",
    theme: { primaryColor: "#4f46e5", accentColor: "#0ea5e9", font: "sans", heroHeadline: "Welcome to our store", heroSubheadline: "Quality you can trust, service you will love.", about: "", showProducts: true },
    products, removeBranding: false, ...over,
  };
}

const typesAndTitles = (sections: HomeSection[]) => sections.map((s) => `${s.type}:${s.title}`);

test("business type selects the preset; product categories never do", () => {
  assert.equal(presetForBusinessType("clothing"), "clothing");
  assert.equal(presetForBusinessType("shoes"), "shoes");
  assert.equal(presetForBusinessType("electronics"), "electronics");
  assert.equal(presetForBusinessType("technology"), "electronics");
  assert.equal(presetForBusinessType("grocery"), "grocery");
  assert.equal(presetForBusinessType("food"), "grocery");
  assert.equal(presetForBusinessType("furniture"), "furniture");
  assert.equal(presetForBusinessType("beauty"), "cosmetics");
  assert.equal(presetForBusinessType("hardware"), "hardware");
  assert.equal(presetForBusinessType("services"), "services");
  assert.equal(presetForBusinessType("realestate"), "realestate");
  assert.equal(presetForBusinessType("fitness"), "fitness");
  assert.equal(presetForBusinessType("education"), "education");
  assert.equal(presetForBusinessType("creative"), "creative");
  for (const other of ["retail", "other", "", null, undefined, "Tea"]) {
    assert.equal(presetForBusinessType(other as string), "general", String(other));
  }
});

test("presets follow the requested structure for each business type", () => {
  assert.deepEqual(typesAndTitles(presetConfig("clothing").sections), [
    "categories:Shop by category", "newArrivals:New arrivals", "featured:Featured collection", "bestSellers:Best sellers", "promotions:", "story:About us", "benefits:Shopping information",
  ]);
  assert.deepEqual(typesAndTitles(presetConfig("shoes").sections).slice(0, 5), [
    "categories:Shop by style", "featured:Featured shoes", "bestSellers:Best sellers", "newArrivals:New arrivals", "promotions:",
  ]);
  assert.deepEqual(typesAndTitles(presetConfig("electronics").sections).slice(0, 5), [
    "categories:Product categories", "featured:Featured electronics", "newArrivals:Latest products", "sale:Best deals", "benefits:Shopping information",
  ]);
  assert.deepEqual(typesAndTitles(presetConfig("grocery").sections).slice(0, 5), [
    "categories:Shop by category", "featured:Daily essentials", "bestSellers:Popular products", "sale:Best deals", "benefits:Delivery information",
  ]);
  assert.deepEqual(typesAndTitles(presetConfig("furniture").sections).slice(0, 5), [
    "categories:Shop by room", "featured:Featured furniture", "bestSellers:Best sellers", "promotions:", "story:About us",
  ]);
  assert.deepEqual(typesAndTitles(presetConfig("hardware").sections).slice(0, 4), [
    "categories:Product categories", "featured:Featured products", "bestSellers:Popular tools", "promotions:",
  ]);
  // No brand data exists, so no preset includes a brands section.
  for (const sections of Object.values(PRESET_SECTIONS)) {
    assert.ok(sections.every((s) => (s.type as string) !== "brands"));
  }
  // Every preset is valid input.
  for (const key of Object.keys(PRESET_SECTIONS)) {
    assert.equal(storefrontConfigSchema.safeParse(presetConfig(key)).success, true, key);
  }
});

test("a store without settings gets its business-type preset; same type, same structure", () => {
  const a = readStorefrontConfig(undefined, "electronics");
  const b = readStorefrontConfig(null, "electronics");
  assert.deepEqual(a, b);
  assert.equal(a.preset, "electronics");
  // A stored config without sections keeps its other settings and gets the preset sections.
  const partial = readStorefrontConfig({ announcement: { enabled: true, text: "Hi" } }, "grocery");
  assert.equal(partial.announcement.text, "Hi");
  assert.equal(partial.sections.find((s) => s.type === "featured")?.title, "Daily essentials");
});

test("version-1 settings are upgraded without losing anything", () => {
  const id = "c".repeat(24);
  const upgraded = readStorefrontConfig({
    version: 1,
    sections: [{ key: "story", enabled: true }, { key: "featured", enabled: false }],
    featuredProductIds: [id],
    categories: [{ name: "Tea", imageUrl: "https://cdn.example.com/t.png" }],
    promotions: [{ title: "Tea week" }],
    benefits: { shipping: "Ships daily" },
  }, "retail");
  assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.sections.slice(0, 2).map((s) => [s.type, s.enabled]), [["story", true], ["featured", false]]);
  assert.equal(upgraded.sections.length, 8, "every v1 key appears once");
  const featured = upgraded.sections.find((s) => s.type === "featured");
  assert.ok(featured?.type === "featured" && featured.productIds[0] === id);
  const categories = upgraded.sections.find((s) => s.type === "categories");
  assert.ok(categories?.type === "categories" && categories.categories[0].name === "Tea");
  const promotions = upgraded.sections.find((s) => s.type === "promotions");
  assert.ok(promotions?.type === "promotions" && promotions.items[0].title === "Tea week");
  const benefits = upgraded.sections.find((s) => s.type === "benefits");
  assert.ok(benefits?.type === "benefits" && benefits.shipping === "Ships daily");
});

test("section rules: unique ids, single-instance types, duplicable collections, size limit", () => {
  const base = presetConfig("retail");
  const dupId = [...base.sections, { ...base.sections[0] }];
  assert.equal(storefrontConfigSchema.safeParse({ ...base, sections: dupId }).success, false);
  const twoStories = [...base.sections, { ...createHomeSection("story", base.sections), id: "story-x" }];
  assert.equal(storefrontConfigSchema.safeParse({ ...base, sections: twoStories }).success, false);
  const featured = base.sections.find((s) => s.type === "featured")!;
  const copy = duplicateHomeSection(featured, base.sections)!;
  assert.equal(copy.id, "featured-2");
  assert.equal(storefrontConfigSchema.safeParse({ ...base, sections: [...base.sections, copy] }).success, true);
  assert.equal(duplicateHomeSection(base.sections.find((s) => s.type === "categories")!, base.sections), null);
  assert.equal(createHomeSection("featured", [...base.sections, copy]).id, "featured-3");
  const tooMany = Array.from({ length: 17 }, (_, i) => ({ id: `p${i}`, type: "promotions" }));
  assert.equal(storefrontConfigSchema.safeParse({ ...base, sections: tooMany }).success, false);
  assert.equal(storefrontConfigSchema.safeParse({ ...base, sections: [{ id: "Bad Id!", type: "story" }] }).success, false);
});

test("rendered sections use only real data; duplicates render their own products; reasons for hidden sections", () => {
  const items = [product("1", { category: "Tea" }), product("2", { category: "Coffee" }), product("3", { category: "Tea", createdAt: daysAgo(2) })];
  const config = {
    sections: [
      { id: "categories", type: "categories", title: "Shop by category" },
      { id: "featured", type: "featured", title: "Teas", productIds: [items[0].id, items[2].id] },
      { id: "featured-2", type: "featured", title: "Coffee", productIds: [items[1].id] },
      { id: "best-sellers", type: "bestSellers" },
      { id: "sale", type: "sale" },
      { id: "story", type: "story", enabled: false },
    ],
  };
  const data = buildCommerceData(view(items), config, { now: NOW });
  assert.deepEqual(data.sections.map((s) => s.id), ["categories", "featured", "featured-2"]);
  const rails = data.sections.filter((s): s is Extract<typeof s, { products: StorefrontProduct[] }> => "products" in s);
  assert.deepEqual(rails.map((r) => [r.title, r.products.map((p) => p.id)]), [["Teas", [items[0].id, items[2].id]], ["Coffee", [items[1].id]]]);
  assert.deepEqual(data.hiddenSections.map((h) => h.id), ["best-sellers", "sale"], "disabled sections are not reported as hidden");
  assert.match(data.hiddenSections[0].reason, /paid orders/);
});

test("hero never shows the platform's generic default texts", () => {
  const data = buildCommerceData(view([], { about: "Hand-roasted coffee from Kerala." }), undefined, { now: NOW });
  assert.equal(data.hero?.headline, "Demo Store");
  assert.equal(data.hero?.description, "Hand-roasted coffee from Kerala.");
  const custom = buildCommerceData(view([], { theme: { ...view([]).theme, heroHeadline: "Fresh roasts weekly" } }), undefined, { now: NOW });
  assert.equal(custom.hero?.headline, "Fresh roasts weekly");
});

test("each business type speaks its own language; a shop stays a shop", () => {
  assert.equal(storeVocabulary("retail").heroCta, "Shop now");
  assert.equal(storeVocabulary("clothing").shopAll, "Shop all");
  assert.equal(storeVocabulary("services").shopAll, "All services");
  assert.equal(storeVocabulary("realestate").heroCta, "View listings");
  assert.equal(storeVocabulary("food").catalogTitle, "Our menu");
  assert.equal(storeVocabulary("beauty").shopHeading, "Treatments");
  assert.equal(storeVocabulary(null).shopHeading, "Shop");
});
