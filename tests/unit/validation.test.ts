import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  businessCreateSchema,
  businessUpdateSchema,
  changePasswordSchema,
  checkoutSchema,
  customerCreateSchema,
  emailSchema,
  hexColor,
  loginSchema,
  membershipInviteSchema,
  membershipRoleUpdateSchema,
  passwordSchema,
  productCreateSchema,
  productUpdateSchema,
  publishSchema,
  registerSchema,
  subdomainSchema,
  themeSettingsSchema,
} from "../../backend/lib/validation";

test("emailSchema trims, lowercases, and validates", () => {
  assert.equal(emailSchema.parse("  Foo@Bar.com "), "foo@bar.com");
  assert.equal(emailSchema.safeParse("not-an-email").success, false);
  assert.equal(emailSchema.safeParse("").success, false);
});

test("passwordSchema enforces a minimum length of 8", () => {
  assert.equal(passwordSchema.safeParse("short").success, false);
  assert.equal(passwordSchema.safeParse("12345678").success, true);
  assert.equal(passwordSchema.safeParse("x".repeat(201)).success, false);
});

test("registerSchema requires a name of at least 2 characters", () => {
  assert.equal(
    registerSchema.safeParse({
      name: "A",
      email: "a@b.com",
      password: "12345678",
    }).success,
    false,
  );
  const parsed = registerSchema.parse({
    name: "  Ada  ",
    email: "A@B.com",
    password: "12345678",
  });
  assert.equal(parsed.name, "Ada");
  assert.equal(parsed.email, "a@b.com");
});

test("loginSchema requires a non-empty password", () => {
  assert.equal(
    loginSchema.safeParse({ email: "a@b.com", password: "" }).success,
    false,
  );
  assert.equal(
    loginSchema.safeParse({ email: "a@b.com", password: "x" }).success,
    true,
  );
});

test("changePasswordSchema validates both passwords", () => {
  assert.equal(
    changePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "12345678",
    }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({
      currentPassword: "old-pass",
      newPassword: "short",
    }).success,
    false,
  );
  assert.equal(
    changePasswordSchema.safeParse({
      currentPassword: "old-pass",
      newPassword: "12345678",
    }).success,
    true,
  );
});

test("hexColor only accepts 6-digit hex colors", () => {
  assert.equal(hexColor.safeParse("#4f46e5").success, true);
  assert.equal(hexColor.safeParse("#FFF").success, false);
  assert.equal(hexColor.safeParse("4f46e5").success, false);
  assert.equal(hexColor.safeParse("#gggggg").success, false);
});

test("themeSettingsSchema restricts font and headline length", () => {
  assert.equal(themeSettingsSchema.safeParse({ font: "sans" }).success, true);
  assert.equal(themeSettingsSchema.safeParse({ font: "comic" }).success, false);
  assert.equal(
    themeSettingsSchema.safeParse({ heroHeadline: "x".repeat(161) }).success,
    false,
  );
  assert.equal(themeSettingsSchema.safeParse({ showProducts: "yes" }).success, false);
});

test("subdomainSchema normalizes and rejects reserved/invalid values", () => {
  assert.equal(subdomainSchema.parse("  My-Shop "), "my-shop");
  assert.equal(subdomainSchema.safeParse("admin").success, false);
  assert.equal(subdomainSchema.safeParse("My Shop!").success, false);
  assert.equal(subdomainSchema.safeParse("a-").success, false);
  assert.equal(subdomainSchema.safeParse("a").success, true);
  // Quirk: the pattern allows 1 char or >=3 chars, but rejects 2-char labels.
  assert.equal(subdomainSchema.safeParse("ab").success, false);
  assert.equal(subdomainSchema.safeParse("abc").success, true);
});

test("businessCreateSchema requires a valid category", () => {
  assert.equal(
    businessCreateSchema.safeParse({ name: "Cafe", category: "food" }).success,
    true,
  );
  assert.equal(
    businessCreateSchema.safeParse({ name: "Cafe", category: "nope" }).success,
    false,
  );
  assert.equal(
    businessCreateSchema.safeParse({ name: "C", category: "food" }).success,
    false,
  );
});

test("businessUpdateSchema is fully optional and normalizes currency/urls", () => {
  assert.equal(businessUpdateSchema.safeParse({}).success, true);
  const parsed = businessUpdateSchema.parse({ currency: "usd", logoUrl: "" });
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.logoUrl, "");
  assert.equal(businessUpdateSchema.safeParse({ logoUrl: "not-a-url" }).success, false);
  assert.equal(businessUpdateSchema.safeParse({ contactEmail: "" }).success, true);
});

test("productCreateSchema coerces price/stock and validates status", () => {
  const parsed = productCreateSchema.parse({ name: "Widget", price: "9.99" });
  assert.equal(parsed.price, 9.99);
  assert.equal(parsed.stock, 0);
  assert.equal(productCreateSchema.safeParse({ name: "W", price: -1 }).success, false);
  assert.equal(productCreateSchema.safeParse({ name: "W", price: 2_000_000 }).success, false);
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, status: "gone" }).success,
    false,
  );
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      images: Array.from({ length: 11 }, () => "https://x.com/a.png"),
    }).success,
    false,
  );
});

test("productUpdateSchema allows a partial update", () => {
  assert.equal(productUpdateSchema.safeParse({}).success, true);
  assert.equal(productUpdateSchema.safeParse({ name: "New" }).success, true);
});

test("customerCreateSchema requires name and a valid email", () => {
  assert.equal(
    customerCreateSchema.safeParse({ name: "Jo", email: "jo@x.com" }).success,
    true,
  );
  assert.equal(
    customerCreateSchema.safeParse({ name: "", email: "jo@x.com" }).success,
    false,
  );
  assert.equal(
    customerCreateSchema.safeParse({ name: "Jo", email: "bad" }).success,
    false,
  );
});

test("membership schemas only accept owner/staff roles", () => {
  assert.equal(
    membershipInviteSchema.safeParse({ email: "a@b.com", role: "owner" }).success,
    true,
  );
  assert.equal(
    membershipInviteSchema.safeParse({ email: "a@b.com", role: "admin" }).success,
    false,
  );
  assert.equal(membershipRoleUpdateSchema.safeParse({ role: "staff" }).success, true);
});

test("checkoutSchema and publishSchema validate their payloads", () => {
  assert.equal(checkoutSchema.safeParse({ planKey: "pro" }).success, true);
  assert.equal(checkoutSchema.safeParse({ planKey: "" }).success, false);
  assert.equal(publishSchema.safeParse({ publish: true }).success, true);
  assert.equal(publishSchema.safeParse({ publish: "yes" }).success, false);
});

test("productCreateSchema accepts every product status including archived", () => {
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, status: "draft" }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, status: "active" }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, status: "archived" }).success,
    true,
  );
});

test("productUpdateSchema accepts an archived status (reactivation path)", () => {
  assert.equal(productUpdateSchema.safeParse({ status: "archived" }).success, true);
  assert.equal(productUpdateSchema.safeParse({ status: "deleted" }).success, false);
});

test("productCreateSchema imageUrl accepts blank or a URL and rejects other values", () => {
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, imageUrl: "" }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      imageUrl: "https://x.com/a.png",
    }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, imageUrl: "not-a-url" }).success,
    false,
  );
});

test("productCreateSchema images must each be a valid URL", () => {
  assert.equal(
    productCreateSchema.safeParse({
      name: "W",
      price: 1,
      images: ["https://x.com/a.png"],
    }).success,
    true,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, images: ["not-a-url"] }).success,
    false,
  );
  assert.equal(
    productCreateSchema.safeParse({ name: "W", price: 1, images: [""] }).success,
    false,
  );
});

test("businessUpdateSchema enforces phone and address length limits", () => {
  assert.equal(businessUpdateSchema.safeParse({ phone: "x".repeat(40) }).success, true);
  assert.equal(businessUpdateSchema.safeParse({ phone: "x".repeat(41) }).success, false);
  assert.equal(
    businessUpdateSchema.safeParse({ address: "x".repeat(240) }).success,
    true,
  );
  assert.equal(
    businessUpdateSchema.safeParse({ address: "x".repeat(241) }).success,
    false,
  );
});

test("businessUpdateSchema requires a 3-letter currency", () => {
  assert.equal(businessUpdateSchema.safeParse({ currency: "us" }).success, false);
  assert.equal(businessUpdateSchema.safeParse({ currency: "usdd" }).success, false);
});

test("checkoutSchema trims and lowercases the plan key but rejects blank input", () => {
  assert.equal(checkoutSchema.parse({ planKey: "  pro  " }).planKey, "pro");
  assert.equal(checkoutSchema.parse({ planKey: "  PRO  " }).planKey, "pro");
  assert.equal(checkoutSchema.parse({ planKey: "Starter" }).planKey, "starter");
  assert.equal(checkoutSchema.safeParse({ planKey: "   " }).success, false);
  assert.equal(checkoutSchema.safeParse({ planKey: "" }).success, false);
});

test("object schemas strip unknown keys", () => {
  const parsed = registerSchema.parse({
    name: "Ada",
    email: "a@b.com",
    password: "12345678",
    role: "super_admin",
  });
  assert.deepEqual(Object.keys(parsed).sort(), ["email", "name", "password"]);
});
