import assert from "node:assert/strict";
import test from "node:test";

import { computeTotals, discountFor, readShippingSettings, shippingAddressSchema, shippingFor } from "../../backend/lib/checkout-pricing";
import { availabilityOf, lowStockLevel, LOW_STOCK_DEFAULT } from "../../backend/lib/inventory-rules";
import { effectiveCompareAt, effectivePrice, normalizeVariants, priceRange, productOptionsSchema, variantLabel } from "../../backend/lib/product-variants";
import { jsonLdScript, absolutize } from "../../backend/lib/structured-data";
import { resolveInternalHref } from "../../backend/lib/storefront-config";

test("totals: discount on the subtotal, shipping after the discount, rounded to cents", () => {
  const shipping = readShippingSettings({ enabled: true, flatRate: 4.99, freeOver: 50 });
  assert.deepEqual(computeTotals(40, { type: "percent", value: 10 }, shipping), { subtotal: 40, discountTotal: 4, shippingTotal: 4.99, total: 40.99 });
  assert.deepEqual(computeTotals(60, { type: "percent", value: 10 }, shipping), { subtotal: 60, discountTotal: 6, shippingTotal: 0, total: 54 });
  // A fixed discount never exceeds the subtotal; percentages are capped at 100.
  assert.equal(discountFor(8, { type: "fixed", value: 20 }), 8);
  assert.equal(discountFor(8, { type: "percent", value: 250 }), 8);
  assert.equal(discountFor(0.1 + 0.2, { type: "percent", value: 33.333 }), 0.1);
  assert.equal(discountFor(10, null), 0);
  // No shipping configured: unchanged behaviour (no charge).
  assert.deepEqual(computeTotals(19.999, null, readShippingSettings(undefined)), { subtotal: 20, discountTotal: 0, shippingTotal: 0, total: 20 });
  assert.equal(shippingFor(readShippingSettings({ enabled: true, flatRate: 5, freeOver: null }), 1_000_000), 5);
  // Invalid stored settings fall back to "no shipping".
  assert.equal(readShippingSettings({ enabled: true, flatRate: -3 }).enabled, false);
});

test("delivery address: required fields, plain text only", () => {
  assert.equal(shippingAddressSchema.safeParse({ name: "A", line1: "1 St", city: "X", postalCode: "1", country: "UK" }).success, true);
  assert.equal(shippingAddressSchema.safeParse({ name: "A", line1: "", city: "X", postalCode: "1", country: "UK" }).success, false);
  assert.equal(shippingAddressSchema.safeParse({ name: "<b>A</b>", line1: "1", city: "X", postalCode: "1", country: "UK" }).success, false);
  assert.equal(shippingAddressSchema.safeParse({ name: "A", line1: "1", city: "X", postalCode: "1", country: "UK", phone: "call me" }).success, false);
});

test("availability: thresholds, never a count", () => {
  assert.equal(LOW_STOCK_DEFAULT, 5);
  assert.equal(availabilityOf(0), "out_of_stock");
  assert.equal(availabilityOf(-2), "out_of_stock");
  assert.equal(availabilityOf(5), "low_stock");
  assert.equal(availabilityOf(6), "in_stock");
  assert.equal(availabilityOf(10, 10), "low_stock");
  assert.equal(availabilityOf(1, 0), "in_stock");
  assert.equal(lowStockLevel(null), 5);
});

test("variants: option rules, matrix validation, prices and labels", () => {
  assert.equal(productOptionsSchema.safeParse([{ name: "Size", values: ["S", "s"] }]).success, false, "duplicate values");
  assert.equal(productOptionsSchema.safeParse([{ name: "Size", values: ["S"] }, { name: "size", values: ["M"] }]).success, false, "duplicate names");
  assert.equal(productOptionsSchema.safeParse([1, 2, 3, 4].map((n) => ({ name: `O${n}`, values: ["a"] }))).success, false, "max 3 options");

  const options = [{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red"] }];
  const ok = normalizeVariants(options, [{ options: { size: "s", COLOR: "red" }, sku: "", price: null, compareAtPrice: null, archived: false }], 10);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.variants[0].optionList, [{ name: "Size", value: "S" }, { name: "Color", value: "Red" }]);
  const bad = normalizeVariants(options, [{ options: { Size: "S", Color: "Red" }, sku: "", price: 12, compareAtPrice: 11, archived: false }], 10);
  assert.equal(bad.ok, false, "compare-at must exceed the variant price");

  assert.equal(effectivePrice(10, { price: null }), 10);
  assert.equal(effectivePrice(10, { price: 0 }), 0, "a free variant is a real price");
  assert.equal(effectiveCompareAt({ price: 10, compareAtPrice: 15 }, { price: null, compareAtPrice: null }), 15);
  assert.equal(effectiveCompareAt({ price: 10, compareAtPrice: 15 }, { price: 20, compareAtPrice: null }), null, "product compare-at never applies to a different variant price");
  assert.deepEqual(priceRange(10, [{ options: [], price: 12 }, { options: [], price: null }, { options: [], price: 99, archived: true }]), { min: 10, max: 12 });
  assert.equal(variantLabel([{ name: "Size", value: "M" }, { name: "Color", value: "Red" }]), "Size: M / Color: Red");
});

test("JSON-LD is safe inside a script tag and round-trips", () => {
  const evil = { name: "</script><script>alert(1)</script> " };
  const out = jsonLdScript(evil);
  assert.ok(!out.includes("<"), out);
  assert.ok(!out.includes(" "));
  assert.deepEqual(JSON.parse(out), evil);
  assert.equal(absolutize("https://s.example", "/api/businesses/x/local-media?key=a"), "https://s.example/api/businesses/x/local-media?key=a");
  assert.equal(absolutize("https://s.example", "https://cdn.example/a.png"), "https://cdn.example/a.png");
});

test("category links resolve only for active categories with products", () => {
  const targets = { productSlugs: new Set<string>(), categories: new Set(["tea"]), pageSlugs: new Set<string>(), hasPolicies: false, categorySlugs: new Set(["tea"]) };
  assert.equal(resolveInternalHref("/category/tea", targets), "/category/tea");
  assert.equal(resolveInternalHref("/category/coffee", targets), null);
});
