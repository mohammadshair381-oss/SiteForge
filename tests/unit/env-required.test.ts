import assert from "node:assert/strict";
import test from "node:test";

import { assertRuntimeConfig, assertStartupEnv } from "../../backend/lib/env";

// Safe dummy values only; no real secrets are used or printed anywhere below.
process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "test";
delete process.env.TRUSTED_IP_HEADER;

// ---------------------------------------------------------------------------
// Pure rules (`assertRuntimeConfig`)
// ---------------------------------------------------------------------------
// These take plain objects, so they never read, mutate or cache process.env.

test("production requires TRUSTED_IP_HEADER to be set", () => {
  assert.throws(
    () => assertRuntimeConfig({ NODE_ENV: "production", TRUSTED_IP_HEADER: "" }),
    /TRUSTED_IP_HEADER is required in production/,
  );
});

test("production passes once a trusted header is configured", () => {
  assert.doesNotThrow(() =>
    assertRuntimeConfig({ NODE_ENV: "production", TRUSTED_IP_HEADER: "x-real-ip" }),
  );
});

test("non-production may leave TRUSTED_IP_HEADER unset", () => {
  assert.doesNotThrow(() =>
    assertRuntimeConfig({ NODE_ENV: "development", TRUSTED_IP_HEADER: "" }),
  );
  assert.doesNotThrow(() =>
    assertRuntimeConfig({ NODE_ENV: "test", TRUSTED_IP_HEADER: "" }),
  );
});

test("failure message names the variable without including any value", () => {
  let message = "";
  try {
    assertRuntimeConfig({ NODE_ENV: "production", TRUSTED_IP_HEADER: "" });
    assert.fail("expected assertRuntimeConfig to throw");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /TRUSTED_IP_HEADER/);
  assert.match(message, /^Invalid environment configuration ->/);
  assert.doesNotMatch(message, /x-real-ip|x-forwarded-for/);
});

// ---------------------------------------------------------------------------
// Startup entry point (`assertStartupEnv` = env() + rules)
// ---------------------------------------------------------------------------

test("assertStartupEnv accepts a valid non-production configuration", () => {
  assert.doesNotThrow(() => assertStartupEnv());
});
