import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

// Set before the first env() call; env() is lazy, so module body order is fine.
process.env.APP_URL = "https://app.example.com";

import {
  buildVerificationUrl,
  EMAIL_VERIFICATION_TTL_MS,
} from "../../lib/auth/email-verification";
import { isEmailVerified } from "../../lib/auth/guards";
import { verifyEmailSchema } from "../../lib/validation";

test("EMAIL_VERIFICATION_TTL_MS is 24 hours", () => {
  assert.equal(EMAIL_VERIFICATION_TTL_MS, 24 * 60 * 60 * 1000);
});

test("buildVerificationUrl produces an absolute link on APP_URL", () => {
  assert.equal(
    buildVerificationUrl("raw-token_123"),
    "https://app.example.com/verify-email#token=raw-token_123",
  );
});

test("buildVerificationUrl URL-encodes the token", () => {
  assert.equal(
    buildVerificationUrl("a b/c"),
    "https://app.example.com/verify-email#token=a%20b%2Fc",
  );
});

test("isEmailVerified: null is unverified; Date and legacy undefined are verified", () => {
  assert.equal(isEmailVerified({ emailVerifiedAt: null }), false);
  assert.equal(isEmailVerified({ emailVerifiedAt: new Date() }), true);
  assert.equal(isEmailVerified({ emailVerifiedAt: undefined }), true);
  assert.equal(isEmailVerified({}), true, "legacy accounts (field absent) stay verified");
});

test("verifyEmailSchema trims and requires a bounded token", () => {
  assert.equal(verifyEmailSchema.parse({ token: "  abc  ", password: "x" }).token, "abc");
  assert.equal(verifyEmailSchema.safeParse({ token: "abc" }).success, false, "the link alone is not enough");
  assert.equal(verifyEmailSchema.safeParse({}).success, false);
  assert.equal(verifyEmailSchema.safeParse({ token: "", password: "x" }).success, false);
  assert.equal(verifyEmailSchema.safeParse({ token: "   ", password: "x" }).success, false);
  assert.equal(verifyEmailSchema.safeParse({ token: "a".repeat(513), password: "x" }).success, false);
  assert.equal(verifyEmailSchema.safeParse({ token: "a".repeat(512), password: "x" }).success, true);
});
