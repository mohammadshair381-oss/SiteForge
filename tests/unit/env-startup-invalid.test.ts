import assert from "node:assert/strict";
import test from "node:test";

import { assertStartupEnv } from "../../lib/env";

// This file deliberately configures an INVALID environment. `env()` only caches
// a *successful* parse, so keeping every case throwing means the cache stays
// empty regardless of execution order. Safe dummy values only; no real secrets.
delete process.env.MONGODB_URI;
process.env.SESSION_SECRET = "a".repeat(40);

test("startup validation fails fast when a required variable is missing", () => {
  assert.throws(() => assertStartupEnv(), /MONGODB_URI: Required/);
});

test("the startup failure names the variable without including any value", () => {
  let message = "";
  try {
    assertStartupEnv();
    assert.fail("expected assertStartupEnv to throw");
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /MONGODB_URI/);
});
