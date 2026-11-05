import assert from "node:assert/strict";
import test from "node:test";

import { env, isProduction } from "../../lib/env";

// Self-contained valid configuration. Values are set on the module body so they
// are in place before env()'s first (caching) call, regardless of test order.
// Only safe dummy values are used; no real secrets.

process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(32); // exactly the 32-char minimum
process.env.PAYMENT_PROVIDER = "manual";
process.env.ALLOW_MANUAL_BILLING = "1";
process.env.TRUSTED_IP_HEADER = " X-Real-IP ";
delete process.env.ROOT_DOMAINS;
delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
delete process.env.PAYMENT_WEBHOOK_SECRET;
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "test";

test("accepts the minimum-length SESSION_SECRET and returns parsed config", () => {
  const config = env();
  assert.equal(config.SESSION_SECRET, "a".repeat(32));
  assert.equal(config.MONGODB_URI, "mongodb://dummy-host:27017/dummy_db");
  assert.equal(config.PAYMENT_PROVIDER, "manual");
});

test("applies defaults for unset optional values", () => {
  const config = env();
  assert.equal(config.ROOT_DOMAINS, "localhost:3000");
  assert.equal(config.NEXT_PUBLIC_ROOT_DOMAIN, "localhost:3000");
  assert.equal(config.PAYMENT_WEBHOOK_SECRET, "");
});

test("coerces ALLOW_MANUAL_BILLING '1' to true", () => {
  assert.equal(env().ALLOW_MANUAL_BILLING, true);
});

test("normalizes TRUSTED_IP_HEADER by trimming and lowercasing", () => {
  assert.equal(env().TRUSTED_IP_HEADER, "x-real-ip");
});

test("env().NODE_ENV is cached while isProduction() reads NODE_ENV live", () => {
  assert.equal(env().NODE_ENV, "test");
  assert.equal(isProduction(), false);

  const previous = process.env.NODE_ENV;
  try {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV =
      "production";
    assert.equal(isProduction(), true);
    // env() is cached, so its snapshot is unchanged for this process.
    assert.equal(env().NODE_ENV, "test");
  } finally {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV =
      previous;
  }
});
