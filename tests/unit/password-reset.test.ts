import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { forgotPasswordSchema, resetPasswordSchema } from "../../backend/lib/validation";

test("forgotPasswordSchema trims and normalizes the email", () => {
  assert.equal(forgotPasswordSchema.parse({ email: "  User@Example.COM " }).email, "user@example.com");
  assert.equal(forgotPasswordSchema.safeParse({ email: "not-an-email" }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({}).success, false);
});

test("resetPasswordSchema requires a six-digit code and the shared password policy", () => {
  assert.equal(resetPasswordSchema.safeParse({ code: "042042", password: "password123" }).success, true);
  assert.equal(resetPasswordSchema.parse({ code: " 042042 ", password: "password123" }).code, "042042");
  for (const code of ["", "12345", "1234567", "abcdef", undefined]) {
    assert.equal(resetPasswordSchema.safeParse({ code, password: "password123" }).success, false, String(code));
  }
  // A link token is not accepted any more.
  assert.equal(resetPasswordSchema.safeParse({ token: "abc", password: "password123" }).success, false);
  // Password policy is shared with registration/change-password.
  assert.equal(resetPasswordSchema.safeParse({ code: "042042", password: "short" }).success, false);
});
