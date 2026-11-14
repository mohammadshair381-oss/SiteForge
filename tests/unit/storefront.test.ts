import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import type { BusinessDoc, ThemeSettings } from "../../backend/models/Business";
import type { ProductDoc } from "../../backend/models/Product";
import { DEFAULT_THEME_SETTINGS, toStorefrontView } from "../../backend/lib/storefront";

const BUSINESS_ID = "507f1f77bcf86cd799439011";
const PRODUCT_ID = "507f1f77bcf86cd799439099";

function makeBusiness(overrides: Partial<BusinessDoc> = {}): BusinessDoc {
  return {
    _id: BUSINESS_ID,
    name: "Demo Co",
    slug: "demo-co",
    subdomain: "demo",
    category: "retail",
    owner: "507f1f77bcf86cd799439012",
    description: "",
    logoUrl: "",
    contactEmail: "",
    phone: "",
    address: "",
    currency: "USD",
    themeId: "aurora",
    themeSettings: undefined,
    customDomain: null,
    status: "published",
    publishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as BusinessDoc;
}

function makeProduct(overrides: Partial<ProductDoc> = {}): ProductDoc {
  return {
    _id: PRODUCT_ID,
    business: BUSINESS_ID,
    name: "Widget",
    slug: "widget",
    description: "A widget",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "SKU-1",
    category: "gadgets",
    stock: 0,
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as ProductDoc;
}

test("DEFAULT_THEME_SETTINGS has the expected baseline values", () => {
  assert.deepEqual(DEFAULT_THEME_SETTINGS, {
    primaryColor: "#4f46e5",
    accentColor: "#0ea5e9",
    font: "sans",
    heroHeadline: "Welcome to our store",
    heroSubheadline: "Quality you can trust, service you will love.",
    about: "",
    showProducts: true,
  });
});

test("theme falls back to defaults when themeSettings is absent, as a copy", () => {
  const view = toStorefrontView(makeBusiness(), [], false);
  assert.deepEqual(view.theme, DEFAULT_THEME_SETTINGS);
  assert.notStrictEqual(view.theme, DEFAULT_THEME_SETTINGS);
});

test("theme overrides merge over defaults", () => {
  const view = toStorefrontView(
    makeBusiness({
      themeSettings: { primaryColor: "#000000" } as ThemeSettings,
    }),
    [],
    false,
  );
  assert.deepEqual(view.theme, {
    ...DEFAULT_THEME_SETTINGS,
    primaryColor: "#000000",
  });
});

test("about prefers the business description, falling back to theme.about", () => {
  const withDescription = toStorefrontView(
    makeBusiness({
      description: "Biz description",
      themeSettings: { about: "Theme about" } as ThemeSettings,
    }),
    [],
    false,
  );
  assert.equal(withDescription.about, "Biz description");

  const withThemeAbout = toStorefrontView(
    makeBusiness({
      description: "",
      themeSettings: { about: "Theme about" } as ThemeSettings,
    }),
    [],
    false,
  );
  assert.equal(withThemeAbout.about, "Theme about");

  const withNeither = toStorefrontView(
    makeBusiness({ description: "", themeSettings: { about: "" } as ThemeSettings }),
    [],
    false,
  );
  assert.equal(withNeither.about, "");
});

test("product currency falls back to the business currency", () => {
  const fallback = toStorefrontView(makeBusiness({ currency: "GBP" }), [
    makeProduct({ currency: "" }),
  ], false);
  assert.equal(fallback.products[0].currency, "GBP");

  const explicit = toStorefrontView(makeBusiness({ currency: "GBP" }), [
    makeProduct({ currency: "EUR" }),
  ], false);
  assert.equal(explicit.products[0].currency, "EUR");
});

test("product imageUrl falls back to the first images entry", () => {
  const fromImages = toStorefrontView(makeBusiness(), [
    makeProduct({ imageUrl: "", images: ["https://x.com/a.png", "https://x.com/b.png"] }),
  ], false);
  assert.equal(fromImages.products[0].imageUrl, "https://x.com/a.png");

  const explicit = toStorefrontView(makeBusiness(), [
    makeProduct({ imageUrl: "https://x.com/main.png", images: ["https://x.com/a.png"] }),
  ], false);
  assert.equal(explicit.products[0].imageUrl, "https://x.com/main.png");

  const noImages = toStorefrontView(makeBusiness(), [
    makeProduct({ imageUrl: "", images: [] }),
  ], false);
  assert.equal(noImages.products[0].imageUrl, "");

  const missingImages = toStorefrontView(makeBusiness(), [
    makeProduct({ imageUrl: "", images: undefined as unknown as string[] }),
  ], false);
  assert.equal(missingImages.products[0].imageUrl, "");
});

test("business and product ids are exposed as strings", () => {
  const view = toStorefrontView(makeBusiness(), [makeProduct()], false);
  assert.equal(typeof view.id, "string");
  assert.equal(view.id, BUSINESS_ID);
  assert.equal(typeof view.products[0].id, "string");
  assert.equal(view.products[0].id, PRODUCT_ID);
});

test("only the intended storefront fields are returned", () => {
  const view = toStorefrontView(makeBusiness(), [makeProduct()], false);

  assert.deepEqual(Object.keys(view).sort(), [
    "about",
    "address",
    "category",
    "contactEmail",
    "currency",
    "id",
    "logoUrl",
    "name",
    "phone",
    "products",
    "removeBranding",
    "subdomain",
    "theme",
    "themeId",
    "usesThemeColors",
  ]);

  assert.deepEqual(Object.keys(view.products[0]).sort(), [
    "availability",
    "category",
    "compareAtPrice",
    "createdAt",
    "currency",
    "description",
    "id",
    "imageUrl",
    "name",
    "price",
    "slug",
  ]);
});
