import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, verifyPassword } from "../../lib/auth/password";

test("hashPassword produces a bcrypt hash, not the plaintext", async () => {
  const hash = await hashPassword("correct horse battery");
  assert.equal(typeof hash, "string");
  assert.match(hash, /^\$2[aby]\$/);
  assert.notEqual(hash, "correct horse battery");
});

test("hashPassword salts, so identical inputs hash differently", async () => {
  const [a, b] = await Promise.all([
    hashPassword("same-password"),
    hashPassword("same-password"),
  ]);
  assert.notEqual(a, b);
});

test("verifyPassword accepts the correct password", async () => {
  const hash = await hashPassword("s3cret-pass");
  assert.equal(await verifyPassword("s3cret-pass", hash), true);
});

test("verifyPassword rejects the wrong password", async () => {
  const hash = await hashPassword("s3cret-pass");
  assert.equal(await verifyPassword("wrong-pass", hash), false);
});

test("hashes use the configured bcrypt cost factor of 12", async () => {
  const hash = await hashPassword("cost-factor-check");
  const match = /^\$2[aby]\$(\d{2})\$/.exec(hash);
  assert.ok(match, `unexpected bcrypt hash format: ${hash}`);
  assert.equal(Number(match[1]), 12);
});
