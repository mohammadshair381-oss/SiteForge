import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  isReservedSubdomain,
  isValidSubdomain,
  RESERVED_SUBDOMAINS,
  slugify,
} from "../../lib/slug";

test("slugify normalizes accents, case, and separators", () => {
  assert.equal(slugify("Café Déjà Vu!"), "cafe-deja-vu");
  assert.equal(slugify("  Hello   World  "), "hello-world");
  // Underscores are stripped by the character filter before dashes collapse.
  assert.equal(slugify("foo_bar--baz"), "foobar-baz");
  assert.equal(slugify("--Trim Me--"), "trim-me");
  assert.equal(slugify(""), "");
});

test("slugify caps output at 64 characters", () => {
  assert.equal(slugify("a".repeat(200)).length, 64);
});

test("isReservedSubdomain is case- and whitespace-insensitive", () => {
  assert.equal(isReservedSubdomain("admin"), true);
  assert.equal(isReservedSubdomain("  ADMIN "), true);
  assert.equal(isReservedSubdomain("myshop"), false);
  assert.equal(RESERVED_SUBDOMAINS.has("api"), true);
});

test("isValidSubdomain rejects empty, reserved, and malformed labels", () => {
  assert.equal(isValidSubdomain(""), false);
  assert.equal(isValidSubdomain("admin"), false);
  assert.equal(isValidSubdomain("MyShop"), false);
  assert.equal(isValidSubdomain("-bad"), false);
  assert.equal(isValidSubdomain("bad-"), false);
  assert.equal(isValidSubdomain("has space"), false);
  assert.equal(isValidSubdomain("a".repeat(64)), false);
});

test("isValidSubdomain accepts single-char and >=3-char labels", () => {
  assert.equal(isValidSubdomain("a"), true);
  assert.equal(isValidSubdomain("abc"), true);
  assert.equal(isValidSubdomain("my-shop-1"), true);
});

test("isValidSubdomain accepts a 63-character label and rejects 64", () => {
  assert.equal(isValidSubdomain("a".repeat(63)), true);
  assert.equal(isValidSubdomain("a".repeat(64)), false);
});

test("slugify yields an empty string when no ASCII-safe characters remain", () => {
  assert.equal(slugify("日本語"), "");
  assert.equal(slugify("–"), "");
  assert.equal(slugify("Ünïcödé"), "unicode");
});
