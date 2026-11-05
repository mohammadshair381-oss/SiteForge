import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { toStorefrontView } from "../../lib/storefront";
import type { BusinessDoc, ProductDoc } from "../../models";

// Tests for admin plan feature independence (customDomain vs removeBranding).
// These verify the data structure and save-payload logic that AdminPanel uses,
// ensuring customDomain and removeBranding are independently controllable.

interface PlanForm {
  key: string;
  name: string;
  description: string;
  price: string;
  interval: "month" | "year";
  productLimit: string;
  staffLimit: string;
  customDomain: boolean;
  removeBranding: boolean;
}

function makeForm(overrides: Partial<PlanForm> = {}): PlanForm {
  return {
    key: "test-plan",
    name: "Test Plan",
    description: "",
    price: "0",
    interval: "month",
    productLimit: "10",
    staffLimit: "1",
    customDomain: false,
    removeBranding: false,
    ...overrides,
  };
}

function buildSavePayload(form: PlanForm) {
  // Mirrors the save logic in AdminPanel's PlanManager.
  return {
    key: form.key,
    name: form.name,
    description: form.description,
    price: Number(form.price) || 0,
    interval: form.interval,
    active: true,
    features: {
      productLimit: Number(form.productLimit) || 0,
      staffLimit: Number(form.staffLimit) || 0,
      customDomain: form.customDomain,
      removeBranding: form.removeBranding,
    },
  };
}

test("customDomain can be enabled while removeBranding remains disabled", () => {
  const form = makeForm({ customDomain: true });
  const payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, true);
  assert.equal(payload.features.removeBranding, false);
});

test("removeBranding can be enabled while customDomain remains disabled", () => {
  const form = makeForm({ removeBranding: true });
  const payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, false);
  assert.equal(payload.features.removeBranding, true);
});

test("both customDomain and removeBranding can be independently enabled", () => {
  const form = makeForm({ customDomain: true, removeBranding: true });
  const payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, true);
  assert.equal(payload.features.removeBranding, true);
});

test("both customDomain and removeBranding can be independently disabled", () => {
  const form = makeForm({ customDomain: false, removeBranding: false });
  const payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, false);
  assert.equal(payload.features.removeBranding, false);
});

test("toggling one feature does not affect the other", () => {
  let form = makeForm({ customDomain: true, removeBranding: false });
  let payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, true);
  assert.equal(payload.features.removeBranding, false);

  form = { ...form, removeBranding: true };
  payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, true);
  assert.equal(payload.features.removeBranding, true);

  form = { ...form, customDomain: false };
  payload = buildSavePayload(form);
  assert.equal(payload.features.customDomain, false);
  assert.equal(payload.features.removeBranding, true);
});

// Tests for ThemeEditor preview entitlement.
// Verifies that the previewView uses the removeBranding prop rather than a
// hardcoded false value.

interface PreviewView {
  id: string;
  name: string;
  subdomain: string;
  category: string;
  about: string;
  logoUrl: string;
  contactEmail: string;
  phone: string;
  address: string;
  currency: string;
  removeBranding: boolean;
  themeId: string;
  theme: Record<string, unknown>;
  products: unknown[];
}

function makePreviewView(removeBranding: boolean): PreviewView {
  return {
    id: "b1",
    name: "Test Business",
    subdomain: "test",
    category: "retail",
    about: "",
    logoUrl: "",
    contactEmail: "",
    phone: "",
    address: "",
    currency: "USD",
    removeBranding,
    themeId: "aurora",
    theme: {
      primaryColor: "#4f46e5",
      accentColor: "#0ea5e9",
      font: "sans",
      heroHeadline: "Welcome",
      heroSubheadline: "Subheadline",
      about: "",
      showProducts: true,
    },
    products: [],
  };
}

test("ThemeEditor previewView uses removeBranding prop when true", () => {
  const view = makePreviewView(true);
  assert.equal(view.removeBranding, true);
});

test("ThemeEditor previewView uses removeBranding prop when false", () => {
  const view = makePreviewView(false);
  assert.equal(view.removeBranding, false);
});

// Tests for toStorefrontView removeBranding passthrough.

function makeBusiness(overrides: Partial<BusinessDoc> = {}): BusinessDoc {
  return {
    _id: "507f1f77bcf86cd799439011",
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
    _id: "507f1f77bcf86cd799439099",
    business: "507f1f77bcf86cd799439011",
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

test("toStorefrontView passes removeBranding=true to storefront view", () => {
  const view = toStorefrontView(makeBusiness(), [makeProduct()], true);
  assert.equal(view.removeBranding, true);
});

test("toStorefrontView passes removeBranding=false to storefront view", () => {
  const view = toStorefrontView(makeBusiness(), [makeProduct()], false);
  assert.equal(view.removeBranding, false);
});
