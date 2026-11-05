import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../../lib/env";

// Every case below configures an INVALID environment. env() only caches a
// *successful* parse, so each call here throws and the cache stays empty. The
// cases are therefore independent of execution order. Valid configuration is
// covered separately in env-valid.test.ts.
//
// All values are safe dummies; no real secrets are used or printed.

test("throws when MONGODB_URI is missing", () => {
  delete process.env.MONGODB_URI;
  process.env.SESSION_SECRET = "a".repeat(40);
  assert.throws(() => env(), /MONGODB_URI: Required/);
});

test("throws when MONGODB_URI is blank", () => {
  process.env.MONGODB_URI = "";
  process.env.SESSION_SECRET = "a".repeat(40);
  assert.throws(() => env(), /MONGODB_URI is required/);
});

test("throws when SESSION_SECRET is missing", () => {
  process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
  delete process.env.SESSION_SECRET;
  assert.throws(() => env(), /SESSION_SECRET: Required/);
});

test("throws when SESSION_SECRET is shorter than 32 characters", () => {
  process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
  process.env.SESSION_SECRET = "a".repeat(31);
  assert.throws(() => env(), /SESSION_SECRET must be at least 32 characters/);
});
