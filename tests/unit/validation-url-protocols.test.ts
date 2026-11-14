import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  businessUpdateSchema,
  productCreateSchema,
  productUpdateSchema,
} from "../../backend/lib/validation";

// Focused tests for the protocol allowlist added to the image/logo URL schemas
// in Phase 4.10. `z.string().url()` alone accepts `javascript:`, `data:` and
// `vbscript:` (verified against the installed zod), so these guard the stored
// values that get re-rendered by the themes and the storefront.

const UNSAFE_SCHEMES = [
  "javascript:alert(1)",
  "javascript:/*--></title></style></textarea></script></xmp><img/id=onerror='alert(1)'>/.source",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "ftp://example.com/a.png",
  "mailto:someone@example.com",
  "tel:+15551234567",
  "about:blank",
  // Protocol-relative and scheme-less values are rejected by `.url()` already,
  // but they must stay rejected by the composed schema.
  "//example.com/a.png",
  "/images/a.png",
];

test("productCreateSchema.imageUrl accepts https URLs, including uppercase host/path", () => {
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      imageUrl: "https://example.com/a.png",
    }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      imageUrl: "  https://example.com/a.png?version=2  ",
    }).success,
    true,
  );
  assert.equal(
    productCreateSchema.parse({
      name: "W",
      price: 1,
      imageUrl: "  https://example.com/a.png  ",
    }).imageUrl,
    "https://example.com/a.png",
  );
});

test("productCreateSchema.imageUrl keeps accepting blank and absent values", () => {
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, imageUrl: "" }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, imageUrl: undefined })
      .success,
    true,
  );
  assert.equal(productCreateSchema.safeParse({ name: "W", price: 1 }).success, true);
});

test("productCreateSchema.imageUrl rejects dangerous and non-https protocols", () => {
  for (const scheme of UNSAFE_SCHEMES) {
    const result = productCreateSchema.safeParse({
      name: "W",
      price: 1,
      imageUrl: scheme,
    });
    assert.equal(result.success, false, `expected ${scheme} to be rejected`);
  }

  const httpResult = productCreateSchema.safeParse({
    name: "W",
    price: 1,
    imageUrl: "http://example.com/a.png",
  });
  assert.equal(httpResult.success, false);
  assert.match(
    JSON.stringify(httpResult.success ? [] : httpResult.error.issues),
    /Only https:\/\/ URLs are allowed/,
  );
});

test("productCreateSchema.images applies the same protocol allowlist", () => {
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      images: ["https://example.com/a.png", "https://cdn.example.org/b.png"],
    }).success,
    true,
  );
  for (const scheme of UNSAFE_SCHEMES) {
    assert.equal(
      productCreateSchema.safeParse({ name: "W", price: 1, images: [scheme] })
        .success,
      false,
      `expected ${scheme} to be rejected inside images`,
    );
  }
  // A single bad entry must fail the whole array, not just that item.
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      images: ["https://example.com/a.png", "javascript:alert(1)"],
    }).success,
    false,
  );
  // Pre-existing behaviour: blank strings are still rejected inside `images`
  // (unlike the single `imageUrl` field, which allows "" to clear the value).
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, images: [""] }).success,
    false,
  );
});

test("productUpdateSchema enforces the same protocol allowlist", () => {
  assert.equal(
    productUpdateSchema.safeParse({ imageUrl: "https://example.com/a.png" }).success,
    true,
  );
  assert.equal(
    productUpdateSchema.safeParse({ imageUrl: "data:image/png;base64,AAAA" }).success,
    false,
  );
  assert.equal(
    productUpdateSchema.safeParse({ images: ["javascript:alert(1)"] }).success,
    false,
  );
  // Clearing a field explicitly still works.
  assert.equal(productUpdateSchema.safeParse({ imageUrl: "" }).success, true);
});

test("businessUpdateSchema.logoUrl enforces the protocol allowlist", () => {
  assert.equal(
    businessUpdateSchema.safeParse({ logoUrl: "https://example.com/logo.png" })
      .success,
    true,
  );
  assert.equal(businessUpdateSchema.safeParse({ logoUrl: "" }).success, true);
  assert.equal(businessUpdateSchema.safeParse({ logoUrl: undefined }).success, true);
  for (const scheme of UNSAFE_SCHEMES) {
    assert.equal(
      businessUpdateSchema.safeParse({ logoUrl: scheme }).success,
      false,
      `expected ${scheme} to be rejected for logoUrl`,
    );
  }
});

test("businessUpdateSchema.logoUrl rejects plain http", () => {
  const result = businessUpdateSchema.safeParse({ logoUrl: "http://example.com/logo.png" });
  assert.equal(result.success, false);
  assert.match(
    JSON.stringify(result.success ? [] : result.error.issues),
    /Only https:\/\/ URLs are allowed/,
  );
});

test("unrelated business validation behaviour is unchanged", () => {
  assert.equal(businessUpdateSchema.safeParse({}).success, true);
  assert.equal(
    businessUpdateSchema.safeParse({ logoUrl: "not-a-url" }).success,
    false,
  );
  assert.equal(
    businessUpdateSchema.safeParse({ contactEmail: "" }).success,
    true,
  );
  const parsed = businessUpdateSchema.parse({ currency: "usd", logoUrl: "" });
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.logoUrl, "");
});
