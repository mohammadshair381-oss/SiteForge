import "../helpers/env";

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  extractSubdomain,
  getRootDomains,
  isRootHost,
  normalizeHost,
  storeLinkRoot,
} from "../../lib/host";

const originalRootDomains = process.env.ROOT_DOMAINS;
const originalPublicRootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN;

beforeEach(() => {
  process.env.ROOT_DOMAINS = "example.com, localhost:3000";
  delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
});

afterEach(() => {
  if (originalRootDomains === undefined) delete process.env.ROOT_DOMAINS;
  else process.env.ROOT_DOMAINS = originalRootDomains;
  if (originalPublicRootDomain === undefined) {
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  } else {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalPublicRootDomain;
  }
});

test("getRootDomains splits, trims, lowercases, and drops empties", () => {
  process.env.ROOT_DOMAINS = " Example.COM ,, localhost:3000 ";
  assert.deepEqual(getRootDomains(), ["example.com", "localhost:3000"]);
});

test("getRootDomains falls back to NEXT_PUBLIC_ROOT_DOMAIN then localhost", () => {
  delete process.env.ROOT_DOMAINS;
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = "MyApp.io";
  assert.deepEqual(getRootDomains(), ["myapp.io"]);

  delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  assert.deepEqual(getRootDomains(), ["localhost:3000"]);
});

test("normalizeHost lowercases and trims, tolerating null/undefined", () => {
  assert.equal(normalizeHost("  DEMO.Example.com "), "demo.example.com");
  assert.equal(normalizeHost(null), "");
  assert.equal(normalizeHost(undefined), "");
});

test("isRootHost treats empty and apex hosts as root", () => {
  assert.equal(isRootHost(null), true);
  assert.equal(isRootHost(""), true);
  assert.equal(isRootHost("example.com"), true);
  assert.equal(isRootHost("demo.example.com"), false);
});

test("extractSubdomain returns the tenant label for storefront hosts", () => {
  assert.equal(extractSubdomain("demo.example.com"), "demo");
  assert.equal(extractSubdomain("a.b.example.com"), "a.b");
  assert.equal(extractSubdomain("example.com"), null);
  assert.equal(extractSubdomain(null), null);
});

test("extractSubdomain ignores hosts outside the configured roots", () => {
  assert.equal(extractSubdomain("127.0.0.1:3000"), null);
  assert.equal(extractSubdomain("other.com"), null);
});

test("extractSubdomain matches a local subdomain when a root carries a port", () => {
  assert.equal(extractSubdomain("demo.localhost:3000"), "demo");
  assert.equal(extractSubdomain("localhost:3000"), null);
  assert.equal(isRootHost("localhost:3000"), true);
  assert.equal(isRootHost("demo.localhost:3000"), false);
});

test("extractSubdomain rejects near-miss suffixes of a configured root", () => {
  assert.equal(extractSubdomain("notexample.com"), null);
  assert.equal(extractSubdomain("example.com.evil.com"), null);
});

test("extractSubdomain normalizes case and whitespace", () => {
  assert.equal(extractSubdomain("  Demo.Example.COM "), "demo");
  assert.equal(extractSubdomain("EXAMPLE.com"), null);
});

test("extractSubdomain does not treat a port on a tenant host as a subdomain", () => {
  // A port terminates the host before the ".root" suffix can match.
  assert.equal(extractSubdomain("demo.example.com:3000"), null);
});

test("isRootHost treats a non-configured host with a port as non-root", () => {
  assert.equal(isRootHost("example.com:3000"), false);
});

test("development: localhost hosts are recognised on any port", () => {
  assert.equal(isRootHost("localhost:3001"), true);
  assert.equal(isRootHost("localhost"), true);
  assert.equal(extractSubdomain("localhost:3001"), null);
  assert.equal(extractSubdomain("demo.localhost:3001"), "demo");
  assert.equal(isRootHost("demo.localhost:3001"), false);
  // Only localhost: other hosts and look-alikes still have to match exactly.
  assert.equal(isRootHost("example.com:3001"), false);
  assert.equal(isRootHost("notlocalhost:3000"), false);
  assert.equal(extractSubdomain("evil.example:3000"), null);
});

test("production: the port must match exactly", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.NODE_ENV;
  env.NODE_ENV = "production";
  try {
    assert.equal(isRootHost("localhost:3000"), true);
    assert.equal(isRootHost("localhost:3001"), false);
    assert.equal(extractSubdomain("demo.localhost:3001"), null);
  } finally {
    if (original === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = original;
  }
});

test("store links on the platform follow the port in use in development only", () => {
  const env = process.env as Record<string, string | undefined>;
  const originalNodeEnv = env.NODE_ENV;
  process.env.ROOT_DOMAINS = "localhost:3000";
  try {
    env.NODE_ENV = "development";
    assert.equal(storeLinkRoot("localhost:3001"), "localhost:3001", "the dev server moved to another port");
    assert.equal(storeLinkRoot("localhost:3000"), "localhost:3000");
    assert.equal(storeLinkRoot("demo.localhost:3001"), "localhost:3000", "a store host is not the platform");
    assert.equal(storeLinkRoot("evil.example:3001"), "localhost:3000", "other hosts are never reflected");
    assert.equal(storeLinkRoot(null), "localhost:3000");
    env.NODE_ENV = "production";
    assert.equal(storeLinkRoot("localhost:3001"), "localhost:3000", "production uses the configured domain");
  } finally {
    env.NODE_ENV = originalNodeEnv;
  }
});

test("the platform host never counts as a store, whichever port it runs on", () => {
  process.env.ROOT_DOMAINS = "localhost:3000";
  assert.equal(extractSubdomain("localhost:3001"), null);
  assert.equal(isRootHost("localhost:3001"), true);
  assert.equal(extractSubdomain("demo.localhost:3001"), "demo");
  assert.equal(isRootHost("demo.localhost:3001"), false);
});
