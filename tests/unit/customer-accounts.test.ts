import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../../lib/api";
import { CUSTOMER_RATE_LIMITS, customerAuthErrorCategory } from "../../lib/auth/customer-accounts";
import { safeStorefrontPath } from "../../lib/auth/customer-redirect";
import { EmailConfigurationError, EmailSendError } from "../../lib/email";
import { isCustomerAccountsEnabled } from "../../lib/env";
import {
  renderCustomerAccountExistsEmail,
  renderCustomerPasswordResetEmail,
  renderCustomerVerificationEmail,
} from "../../lib/email-templates";
import {
  customerEmailOnlySchema,
  customerLoginSchema,
  customerRegisterSchema,
  customerResetPasswordSchema,
  customerVerifyEmailSchema,
  normalizeAccountEmail,
  pageSlugSchema,
} from "../../lib/validation";

const PASSWORD = "correct horse battery";

test("register schema normalises email and enforces name/password rules", () => {
  const parsed = customerRegisterSchema.parse({ name: "  Ada  ", email: "  Ada@Example.COM ", password: PASSWORD });
  assert.deepEqual(parsed, { name: "Ada", email: "ada@example.com", password: PASSWORD });

  for (const body of [
    { name: "A", email: "a@example.com", password: PASSWORD },
    { name: "Ada", email: "nope", password: PASSWORD },
    { name: "Ada", email: "a@example.com", password: "1234567" },
    { name: "Ada", email: "a@example.com", password: "x".repeat(201) },
    { name: "x".repeat(121), email: "a@example.com", password: PASSWORD },
    { name: "Ada", email: `${"a".repeat(250)}@example.com`, password: PASSWORD },
  ]) {
    assert.equal(customerRegisterSchema.safeParse(body).success, false, JSON.stringify(body).slice(0, 80));
  }
});

test("login, email-only, verify and reset schemas", () => {
  assert.equal(customerLoginSchema.parse({ email: "A@B.co", password: "x" }).email, "a@b.co");
  assert.equal(customerLoginSchema.safeParse({ email: "a@b.co", password: "" }).success, false);
  assert.equal(customerEmailOnlySchema.parse({ email: " X@Y.io " }).email, "x@y.io");

  const token = "A".repeat(43);
  assert.deepEqual(customerVerifyEmailSchema.parse({ token: ` ${token} `, password: "p" }), { token, password: "p" });
  assert.equal(customerVerifyEmailSchema.safeParse({ token }).success, false, "password required");
  assert.equal(customerVerifyEmailSchema.safeParse({ token: "x".repeat(513), password: "p" }).success, false);
  assert.equal(customerResetPasswordSchema.safeParse({ token, password: "short" }).success, false);
  assert.equal(customerResetPasswordSchema.safeParse({ token, password: PASSWORD }).success, true);
});

test("account email normalisation matches the Customer model setters", () => {
  assert.equal(normalizeAccountEmail("  Ada@Example.COM\t"), "ada@example.com");
});

test("the account storefront route is reserved for page slugs", () => {
  assert.equal(pageSlugSchema.safeParse("account").success, false);
  assert.equal(pageSlugSchema.safeParse("accounts").success, true);
});

test("safeStorefrontPath allows only same-site paths", () => {
  for (const ok of ["/", "/cart", "/product/mug?x=1", "/about#team"]) {
    assert.equal(safeStorefrontPath(ok), ok);
  }
  for (const bad of [
    undefined,
    null,
    42,
    "",
    "cart",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
    "/ok\nSet-Cookie:x",
    "/account/login",
    "/account/register?next=/",
    `/${"a".repeat(250)}`,
  ]) {
    assert.equal(safeStorefrontPath(bad), "/", String(bad));
  }
});

test("customer templates escape store and customer names and include the link", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const verify = renderCustomerVerificationEmail({
    storeName: evil,
    name: evil,
    verifyUrl: "https://shop.example.com/account/verify-email?token=abc",
    expiresInHours: 24,
  });
  const reset = renderCustomerPasswordResetEmail({
    storeName: evil,
    name: evil,
    resetUrl: "https://shop.example.com/account/reset-password?token=def",
    expiresInMinutes: 60,
  });
  const exists = renderCustomerAccountExistsEmail({
    storeName: evil,
    name: evil,
    loginUrl: "https://shop.example.com/account/login",
    forgotPasswordUrl: "https://shop.example.com/account/forgot-password",
  });
  for (const email of [verify, reset, exists]) {
    assert.ok(!email.html.includes("<img src=x"), "html escaped");
    assert.ok(email.subject.length > 0 && !email.subject.includes("\n"));
  }
  assert.ok(verify.text.includes("/account/verify-email?token=abc"));
  assert.ok(reset.text.includes("/account/reset-password?token=def"));
  assert.ok(exists.text.includes("/account/forgot-password"));
  assert.ok(!exists.text.includes("token="));
});

test("the customer-accounts gate is off unless the value is exactly true", () => {
  const previous = process.env.CUSTOMER_ACCOUNTS_ENABLED;
  try {
    for (const value of [undefined, "", "false", "0", "1", "TRUE", "True", "yes", "on", "enabled"]) {
      if (value === undefined) delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
      else process.env.CUSTOMER_ACCOUNTS_ENABLED = value;
      assert.equal(isCustomerAccountsEnabled(), false, String(value));
    }
    for (const value of ["true", " true "]) {
      process.env.CUSTOMER_ACCOUNTS_ENABLED = value;
      assert.equal(isCustomerAccountsEnabled(), true, value);
    }
  } finally {
    if (previous === undefined) delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
    else process.env.CUSTOMER_ACCOUNTS_ENABLED = previous;
  }
});

test("error categories never carry the error message", () => {
  const cases: Array<[unknown, string]> = [
    [new EmailConfigurationError("EMAIL_API_KEY missing"), "email_configuration"],
    [new EmailSendError("x", "resend"), "email_provider_unreachable"],
    [new EmailSendError("x", "resend", 503), "email_provider_unavailable"],
    [new EmailSendError("x", "resend", 429), "email_provider_unavailable"],
    [new EmailSendError("x", "resend", 422), "email_provider_rejected"],
    [new HttpError(429, "x"), "http_429"],
    [Object.assign(new Error("dup key a@b.co"), { name: "MongoServerError" }), "database"],
    [new Error("anything"), "unknown"],
    ["a string", "unknown"],
  ];
  for (const [error, category] of cases) assert.equal(customerAuthErrorCategory(error), category);
});

test("login failure budgets: per (email, IP) below the account-wide cap", () => {
  const { failuresPerEmailIp, failuresPerEmail, perIp } = CUSTOMER_RATE_LIMITS.login;
  assert.ok(failuresPerEmailIp.limit < failuresPerEmail.limit);
  assert.ok(failuresPerEmail.limit / failuresPerEmailIp.limit >= 10, "locking an account needs at least 10 sources");
  assert.ok(perIp.limit >= failuresPerEmailIp.limit);
});

test("the account-exists notice explains the pending-verification case without a token", () => {
  const base = {
    storeName: "Shop",
    name: "Ada",
    loginUrl: "https://shop.example.com/account/login",
    forgotPasswordUrl: "https://shop.example.com/account/forgot-password",
  };
  const verified = renderCustomerAccountExistsEmail(base);
  const pending = renderCustomerAccountExistsEmail({ ...base, pendingVerification: true });
  assert.doesNotMatch(verified.text, /not confirmed yet/);
  assert.match(pending.text, /not confirmed yet/);
  assert.match(pending.html, /not confirmed yet/);
  assert.ok(!pending.text.includes("token="));
});
