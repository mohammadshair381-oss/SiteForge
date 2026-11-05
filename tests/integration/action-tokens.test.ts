import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import {
  startIntegrationSuite,
  stopIntegrationSuite,
  getTestMongoUri,
} from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { AuthToken } from "@/models/AuthToken";
import {
  consumeActionToken,
  createActionToken,
  generateActionToken,
  hashActionToken,
} from "@/lib/auth/action-tokens";

const TTL = 60 * 60 * 1000; // 1 hour

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
});

test("stores only the SHA-256 hash, never the raw token", async () => {
  const user = await createUser();
  const created = await createActionToken(user._id, "password_reset", TTL);

  const stored = await AuthToken.findOne({ user: user._id }).select("+tokenHash");
  assert.ok(stored);
  assert.equal(stored.tokenHash, hashActionToken(created.rawToken));
  assert.notEqual(stored.tokenHash, created.rawToken);

  // The raw token must not be findable anywhere in the collection.
  assert.equal(await AuthToken.countDocuments({ tokenHash: created.rawToken }), 0);
});

test("consumes a valid token exactly once", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(user._id, "email_verification", TTL);

  const first = await consumeActionToken(rawToken, "email_verification");
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(String(first.token.user), String(user._id));
    assert.equal(first.token.type, "email_verification");
    assert.ok(first.token.usedAt instanceof Date);
  }

  const second = await consumeActionToken(rawToken, "email_verification");
  assert.deepEqual(second, { ok: false, reason: "invalid" });
});

test("rejects an expired token even before TTL cleanup removes it", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(user._id, "password_reset", TTL);
  await AuthToken.updateOne(
    { user: user._id },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  const result = await consumeActionToken(rawToken, "password_reset");
  assert.deepEqual(result, { ok: false, reason: "invalid" });

  const stillStored = await AuthToken.findOne({ user: user._id });
  assert.ok(stillStored);
  assert.equal(stillStored.usedAt, null);
});

test("rejects a token presented with the wrong type", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(user._id, "password_reset", TTL);

  const result = await consumeActionToken(rawToken, "email_verification");
  assert.deepEqual(result, { ok: false, reason: "invalid" });

  // The correct type still works afterwards.
  assert.equal((await consumeActionToken(rawToken, "password_reset")).ok, true);
});

test("rejects an unknown but well-formed token", async () => {
  const user = await createUser();
  await createActionToken(user._id, "password_reset", TTL);

  const result = await consumeActionToken(generateActionToken(), "password_reset");
  assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("issuing a replacement invalidates the previous token of the same type", async () => {
  const user = await createUser();
  const first = await createActionToken(user._id, "password_reset", TTL);
  const second = await createActionToken(user._id, "password_reset", TTL);

  assert.deepEqual(await consumeActionToken(first.rawToken, "password_reset"), {
    ok: false,
    reason: "invalid",
  });
  assert.equal((await consumeActionToken(second.rawToken, "password_reset")).ok, true);
});

test("different token types do not invalidate each other", async () => {
  const user = await createUser();
  const reset = await createActionToken(user._id, "password_reset", TTL);
  const verify = await createActionToken(user._id, "email_verification", TTL);

  assert.equal((await consumeActionToken(reset.rawToken, "password_reset")).ok, true);
  assert.equal(
    (await consumeActionToken(verify.rawToken, "email_verification")).ok,
    true,
  );
});

test("concurrent consumption succeeds for exactly one caller", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(user._id, "password_reset", TTL);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => consumeActionToken(rawToken, "password_reset")),
  );

  const successes = results.filter((result) => result.ok);
  assert.equal(successes.length, 1);
  assert.equal(results.length, 8);
});

test("defines a unique tokenHash index and a TTL index on expiresAt", async () => {
  const indexes = await AuthToken.collection.indexes();

  const hashIndex = indexes.find((index) => index.key?.tokenHash === 1);
  assert.ok(hashIndex, "expected a tokenHash index");
  assert.equal(hashIndex.unique, true);

  const ttlIndex = indexes.find(
    (index) => index.key?.expiresAt === 1 && index.expireAfterSeconds === 0,
  );
  assert.ok(ttlIndex, "expected a TTL index on expiresAt");
});

test("does not expose tokenHash through toJSON", async () => {
  const user = await createUser();
  await createActionToken(user._id, "email_verification", TTL);

  const stored = await AuthToken.findOne({ user: user._id }).select("+tokenHash");
  assert.ok(stored);

  const serialized = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
  assert.ok(!("tokenHash" in serialized));
});
