import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDomain,
  validateDomain,
  isReservedPlatformDomain,
  isIpAddress,
} from "../../backend/lib/domain";

test("normalizeDomain lowercases and trims", () => {
  assert.equal(normalizeDomain("  Example.COM  "), "example.com");
});

test("normalizeDomain removes trailing dot", () => {
  assert.equal(normalizeDomain("example.com."), "example.com");
});

test("normalizeDomain strips https scheme", () => {
  assert.equal(normalizeDomain("https://example.com"), "example.com");
});

test("normalizeDomain strips http scheme", () => {
  assert.equal(normalizeDomain("http://example.com"), "example.com");
});

test("normalizeDomain strips path and query", () => {
  assert.equal(normalizeDomain("example.com/path?query=1#frag"), "example.com");
});

test("normalizeDomain returns empty for empty input", () => {
  assert.equal(normalizeDomain(""), "");
  assert.equal(normalizeDomain(null), "");
  assert.equal(normalizeDomain(undefined), "");
});

test("validateDomain accepts valid domain", () => {
  assert.equal(validateDomain("example.com"), "example.com");
  assert.equal(validateDomain("sub.example.com"), "sub.example.com");
  assert.equal(validateDomain("my-business.example.com"), "my-business.example.com");
});

test("validateDomain rejects empty domain", () => {
  assert.throws(() => validateDomain(""), /domain is required/);
  assert.throws(() => validateDomain(null), /domain is required/);
  assert.throws(() => validateDomain(undefined), /domain is required/);
});

test("validateDomain rejects IP addresses", () => {
  assert.throws(() => validateDomain("192.168.1.1"), /IP addresses/);
  assert.throws(() => validateDomain("10.0.0.1"), /IP addresses/);
});

test("validateDomain strips scheme from URL", () => {
  assert.equal(validateDomain("https://example.com"), "example.com");
  assert.equal(validateDomain("http://example.com"), "example.com");
});

test("validateDomain strips path and query remnants", () => {
  // normalizeDomain strips paths, so example.com/path becomes example.com
  assert.equal(validateDomain("example.com/path"), "example.com");
});

test("validateDomain rejects labels longer than 63 chars", () => {
  assert.throws(() => validateDomain("a".repeat(64) + ".com"), /1-63 characters/);
});

test("validateDomain rejects total length over 253 chars", () => {
  // 5 labels of 63 chars each = 315 + 4 dots = 319 > 253
  const longLabel = "a".repeat(63);
  const longDomain = [longLabel, longLabel, longLabel, longLabel, longLabel].join(".");
  assert.ok(longDomain.length > 253);
  assert.throws(() => validateDomain(longDomain), /too long/);
});

test("validateDomain rejects invalid label characters", () => {
  assert.throws(() => validateDomain("-example.com"), /start and end/);
  assert.throws(() => validateDomain("example-.com"), /start and end/);
  assert.throws(() => validateDomain("example..com"), /1-63/);
});

test("removeBranding removes reserved domain names", () => {
  assert.ok(isReservedPlatformDomain("api.example.com"));
  assert.ok(isReservedPlatformDomain("www.example.com"));
  assert.ok(isReservedPlatformDomain("admin.example.com"));
});

test("isReservedPlatformDomain detects root domains", () => {
  assert.equal(isReservedPlatformDomain("localhost:3000"), true);
  assert.equal(isReservedPlatformDomain("example.com"), false);
});

test("isReservedPlatformDomain detects reserved subdomains", () => {
  assert.equal(isReservedPlatformDomain("www.example.com"), true);
  assert.equal(isReservedPlatformDomain("api.example.com"), true);
  assert.equal(isReservedPlatformDomain("shop.example.com"), false);
});

test("isIpAddress detects IPv4", () => {
  assert.equal(isIpAddress("192.168.1.1"), true);
  assert.equal(isIpAddress("10.0.0.1"), true);
  assert.equal(isIpAddress("255.255.255.255"), true);
});

test("isIpAddress rejects invalid IPv4", () => {
  assert.equal(isIpAddress("999.999.999.999"), false);
  assert.equal(isIpAddress("example.com"), false);
});

test("isIpAddress detects IPv6", () => {
  assert.equal(isIpAddress("::1"), true);
  assert.equal(isIpAddress("2001:db8::1"), true);
});

test("validateDomain rejects IPv4 addresses", () => {
  assert.throws(() => validateDomain("192.168.1.1"), /IP addresses/);
});

test("validateDomain accepts hyphenated labels", () => {
  assert.equal(validateDomain("my-business.example.com"), "my-business.example.com");
});

test("validateDomain accepts numeric labels", () => {
  assert.equal(validateDomain("123.example.com"), "123.example.com");
});
