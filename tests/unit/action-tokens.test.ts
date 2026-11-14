import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";

import {
  ActionTokenError,
  consumeActionToken,
  createActionToken,
  generateActionToken,
  hashActionToken,
  isActionTokenType,
} from "../../backend/lib/auth/action-tokens";

// Pure behaviour only: these cases must never reach the database, so no
// connection is required. Database-backed semantics are covered by
// tests/integration/action-tokens.test.ts.

test("generateActionToken returns a URL-safe token with 256 bits of entropy", () => {
  const token = generateActionToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.ok(token.length >= 43);
});

test("generateActionToken never repeats across many draws", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 250; i += 1) {
    seen.add(generateActionToken());
  }
  assert.equal(seen.size, 250);
});

test("hashActionToken is deterministic, fixed-width and hides the raw token", () => {
  const token = generateActionToken();
  const hash = hashActionToken(token);
  assert.equal(hash, hashActionToken(token));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
});

test("isActionTokenType accepts only the known token types", () => {
  assert.ok(isActionTokenType("password_reset"));
  assert.ok(isActionTokenType("email_verification"));
  assert.ok(!isActionTokenType("other"));
  assert.ok(!isActionTokenType(undefined));
  assert.ok(!isActionTokenType(42));
});

test("createActionToken rejects invalid TTLs before touching the database", async () => {
  const userId = new Types.ObjectId();
  for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      createActionToken(userId, "password_reset", ttl),
      (error: unknown) =>
        error instanceof ActionTokenError && error.code === "invalid_ttl",
    );
  }
});

test("createActionToken rejects an unsupported token type", async () => {
  await assert.rejects(
    // @ts-expect-error deliberately invalid type
    createActionToken(new Types.ObjectId(), "definitely_not_a_type", 60_000),
    (error: unknown) =>
      error instanceof ActionTokenError && error.code === "invalid_type",
  );
});

test("createActionToken rejects a malformed userId", async () => {
  await assert.rejects(
    createActionToken("not-an-object-id", "password_reset", 60_000),
    (error: unknown) =>
      error instanceof ActionTokenError && error.code === "invalid_user",
  );
});

test("consumeActionToken returns a uniform invalid result for malformed input without a database round trip", async () => {
  for (const bad of ["", "   ", "short", "<script>alert(1)</script>", "a".repeat(600)]) {
    const result = await consumeActionToken(bad, "password_reset");
    assert.deepEqual(result, { ok: false, reason: "invalid" });
  }
});

test("consumeActionToken rejects an unsupported expected type", async () => {
  await assert.rejects(
    // @ts-expect-error deliberately invalid type
    consumeActionToken(generateActionToken(), "definitely_not_a_type"),
    (error: unknown) =>
      error instanceof ActionTokenError && error.code === "invalid_type",
  );
});
