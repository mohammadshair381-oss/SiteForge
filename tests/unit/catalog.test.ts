import assert from "node:assert/strict";
import test from "node:test";

import { catalogCategories, filterCatalog, parseCatalogQuery, type CatalogProduct } from "../../lib/catalog";

const product = (overrides: Partial<CatalogProduct>): CatalogProduct => ({
  id: overrides.slug ?? "p",
  name: "Item",
  slug: "item",
  description: "",
  price: 10,
  currency: "USD",
  imageUrl: "",
  category: "",
  stock: 1,
  ...overrides,
});

// Newest first, as loaded by getPublicStorefront.
const PRODUCTS = [
  product({ slug: "mug", name: "Blue Mug", description: "Ceramic coffee mug", price: 12, category: "Kitchen" }),
  product({ slug: "tee", name: "Logo Tee", description: "Cotton shirt", price: 25, category: "Clothing" }),
  product({ slug: "bowl", name: "Bowl", description: "Blue ceramic bowl", price: 8, category: "kitchen " }),
  product({ slug: "cap", name: "Cap", description: "", price: 15, category: "" }),
];

test("parseCatalogQuery bounds and normalises URL input", () => {
  assert.deepEqual(parseCatalogQuery({}), { q: "", category: "", sort: "newest" });
  assert.deepEqual(parseCatalogQuery({ q: "  mug  ", category: ["Kitchen", "x"], sort: "price-asc" }), { q: "mug", category: "Kitchen", sort: "price-asc" });
  assert.equal(parseCatalogQuery({ sort: "$where" }).sort, "newest", "unknown sort falls back");
  assert.equal(parseCatalogQuery({ q: "x".repeat(500) }).q.length, 100);
});

test("catalogCategories de-duplicates case-insensitively and skips empty categories", () => {
  assert.deepEqual(catalogCategories(PRODUCTS), ["Clothing", "Kitchen"]);
});

test("filterCatalog searches name, description and category; every word must match", () => {
  const slugs = (q: string) => filterCatalog(PRODUCTS, { q, category: "", sort: "newest" }).map((p) => p.slug);
  assert.deepEqual(slugs("blue"), ["mug", "bowl"]);
  assert.deepEqual(slugs("BLUE ceramic"), ["mug", "bowl"]);
  assert.deepEqual(slugs("blue cotton"), []);
  assert.deepEqual(slugs("clothing"), ["tee"]);
  assert.deepEqual(slugs(""), ["mug", "tee", "bowl", "cap"], "empty search keeps the loaded order");
});

test("filterCatalog filters by category (case-insensitive) and sorts", () => {
  const kitchen = filterCatalog(PRODUCTS, { q: "", category: "kitchen", sort: "price-asc" });
  assert.deepEqual(kitchen.map((p) => p.slug), ["bowl", "mug"]);
  assert.deepEqual(filterCatalog(PRODUCTS, { q: "", category: "", sort: "price-desc" }).map((p) => p.price), [25, 15, 12, 8]);
  assert.deepEqual(filterCatalog(PRODUCTS, { q: "", category: "", sort: "name" }).map((p) => p.name), ["Blue Mug", "Bowl", "Cap", "Logo Tee"]);
  assert.deepEqual(filterCatalog(PRODUCTS, { q: "", category: "Garden", sort: "newest" }), []);
  assert.equal(PRODUCTS[0].slug, "mug", "the input array is not mutated");
});

test("filterCatalog: the in-stock filter is opt-in (?stock=in) and uses server-side stock", () => {
  assert.equal(parseCatalogQuery({}).inStock, undefined, "absent unless requested");
  assert.equal(parseCatalogQuery({ stock: "in" }).inStock, true);
  assert.equal(parseCatalogQuery({ stock: "yes" }).inStock, undefined, "unknown values are ignored");
  const items = [...PRODUCTS, product({ slug: "sold-out", name: "Sold Out Mug", category: "Kitchen", stock: 0 })];
  const kitchen = filterCatalog(items, { q: "mug", category: "kitchen", sort: "newest" });
  const kitchenInStock = filterCatalog(items, { q: "mug", category: "kitchen", sort: "newest", inStock: true });
  assert.deepEqual(kitchen.map((p) => p.slug), ["mug", "sold-out"]);
  assert.deepEqual(kitchenInStock.map((p) => p.slug), ["mug"], "combines with search and category");
});
