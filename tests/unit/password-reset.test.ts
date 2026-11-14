import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

// Set before the first env() call; env() is lazy, so module body order is fine.
process.env.APP_URL = "https://app.example.com";

import {
  buildPasswordResetUrl,
  PASSWORD_RESET_TTL_MS,
} from "../../backend/lib/auth/password-reset";
import { forgotPasswordSchema, resetPasswordSchema } from "../../backend/lib/validation";

test("PASSWORD_RESET_TTL_MS is one hour", () => {
  assert.equal(PASSWORD_RESET_TTL_MS, 60 * 60 * 1000);
});

test("buildPasswordResetUrl produces an absolute link on APP_URL", () => {
  assert.equal(
    buildPasswordResetUrl("raw-token_123"),
    "https://app.example.com/reset-password#token=raw-token_123",
  );
});

test("buildPasswordResetUrl URL-encodes the token", () => {
  assert.equal(
    buildPasswordResetUrl("a b/c"),
    "https://app.example.com/reset-password#token=a%20b%2Fc",
  );
});

test("forgotPasswordSchema trims and normalizes the email", () => {
  assert.equal(
    forgotPasswordSchema.parse({ email: "  User@Example.COM " }).email,
    "user@example.com",
  );
  assert.equal(forgotPasswordSchema.safeParse({ email: "not-an-email" }).success, false);
  assert.equal(forgotPasswordSchema.safeParse({}).success, false);
});

test("resetPasswordSchema requires a token and the shared password policy", () => {
  const ok = resetPasswordSchema.safeParse({ token: "abc", password: "password123" });
  assert.equal(ok.success, true);

  assert.equal(resetPasswordSchema.parse({ token: "  abc  ", password: "password123" }).token, "abc");

  assert.equal(resetPasswordSchema.safeParse({ password: "password123" }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ token: "", password: "password123" }).success, false);
  assert.equal(
    resetPasswordSchema.safeParse({ token: "a".repeat(513), password: "password123" }).success,
    false,
  );
  // Password policy is shared with registration/change-password.
  assert.equal(resetPasswordSchema.safeParse({ token: "abc", password: "short" }).success, false);
});
