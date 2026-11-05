import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainVerification,
  domainStatusOf,
  domainVerificationTokenMatches,
  generateDomainVerificationToken,
  hashDomainVerificationToken,
} from "../../models/DomainVerification";
import {
  isInternalDomain,
  isReservedPlatformDomain,
  isSingleLabelDomain,
  validateDomain,
} from "../../lib/domain";
import {
  checkDomainTxtRecord,
  domainTxtRecordName,
  domainTxtRecordValue,
  setTxtResolverForTesting,
} from "../../lib/domain-dns";

/**
 * Phase 4.26.1 — custom-domain lifecycle.
 *
 * These cover the pure pieces that the lifecycle fix depends on: legacy status
 * normalization, constant-time token comparison, the schema/index definition
 * that keeps verified records alive, and domain input hardening.
 */

const HOUR_MS = 60 * 60 * 1000;

// ============================================================
// Legacy status normalization
// ============================================================

test("domainStatusOf prefers an explicit lifecycle status", () => {
  assert.equal(domainStatusOf({ status: "pending" }), "pending");
  assert.equal(domainStatusOf({ status: "verified" }), "verified");
  assert.equal(domainStatusOf({ status: "revoked" }), "revoked");
});

test("legacy record consumed before verification is treated as verified", () => {
  // The old implementation set usedAt first, then verifiedAt on success.
  const usedAt = new Date("2026-01-01T00:00:00Z");
  const verifiedAt = new Date(usedAt.getTime() + 2 * 1000);
  assert.equal(domainStatusOf({ usedAt, verifiedAt }), "verified");
});

test("legacy removed record is treated as revoked", () => {
  // DELETE stamped usedAt after the domain had been verified.
  const verifiedAt = new Date("2026-01-01T00:00:00Z");
  const usedAt = new Date(verifiedAt.getTime() + HOUR_MS);
  assert.equal(domainStatusOf({ usedAt, verifiedAt }), "revoked");
});

test("legacy record with only usedAt is treated as revoked (consumed, never verified)", () => {
  assert.equal(domainStatusOf({ usedAt: new Date(), verifiedAt: null }), "revoked");
});

test("legacy record with neither marker is pending", () => {
  assert.equal(domainStatusOf({ usedAt: null, verifiedAt: null }), "pending");
  assert.equal(domainStatusOf({}), "pending");
});

// ============================================================
// Token hash comparison
// ============================================================

test("domainVerificationTokenMatches accepts the matching raw token", () => {
  const raw = generateDomainVerificationToken();
  assert.ok(domainVerificationTokenMatches(raw, hashDomainVerificationToken(raw)));
});

test("domainVerificationTokenMatches rejects a different token", () => {
  const raw = generateDomainVerificationToken();
  const other = generateDomainVerificationToken();
  assert.equal(
    domainVerificationTokenMatches(other, hashDomainVerificationToken(raw)),
    false,
  );
});

test("domainVerificationTokenMatches rejects empty and malformed values", () => {
  const raw = generateDomainVerificationToken();
  const hash = hashDomainVerificationToken(raw);
  assert.equal(domainVerificationTokenMatches("", hash), false);
  assert.equal(domainVerificationTokenMatches(null, hash), false);
  assert.equal(domainVerificationTokenMatches(raw, null), false);
  assert.equal(domainVerificationTokenMatches(raw, "not-a-hash"), false);
  assert.equal(domainVerificationTokenMatches(raw, "abc123"), false);
});

// ============================================================
// Schema / index definition (C1)
// ============================================================

test("expiresAt is optional so verified records can be excluded from TTL", () => {
  const path = DomainVerification.schema.path("expiresAt");
  assert.ok(path, "expiresAt path must exist");
  assert.equal(path!.options.required, undefined);
  assert.equal(path!.options.default, null);
});

test("the TTL index still targets expiresAt with expireAfterSeconds 0", () => {
  const indexes = DomainVerification.schema.indexes() as Array<
    [Record<string, unknown>, Record<string, unknown>?]
  >;
  const ttl = indexes.find(
    ([fields, options]) => fields.expiresAt === 1 && options?.expireAfterSeconds === 0,
  );
  assert.ok(ttl, "TTL index definition must be preserved");
});

test("existing uniqueness indexes are unchanged (no destructive migration)", () => {
  const indexes = DomainVerification.schema.indexes() as Array<
    [Record<string, unknown>, Record<string, unknown>?]
  >;

  const byDomain = indexes.find(
    ([fields, options]) => fields.domain === 1 && options?.unique === true,
  );
  assert.ok(byDomain, "unique {domains: 1} index must be preserved");
  assert.deepEqual(byDomain![1]?.partialFilterExpression, { domain: { $gt: "" } });

  const byBusinessDomain = indexes.find(
    ([fields, options]) =>
      fields.business === 1 && fields.domain === 1 && options?.unique === true,
  );
  assert.ok(byBusinessDomain, "unique {business, domain} index must be preserved");
});

// ============================================================
// Domain validation hardening (L1 / L2)
// ============================================================

test("single-label and internal hostnames are rejected", () => {
  assert.equal(isSingleLabelDomain("localhost"), true);
  assert.equal(isSingleLabelDomain("example.com"), false);
  assert.throws(() => validateDomain("localhost"), /full domain name/);
  assert.throws(() => validateDomain("intranet"), /full domain name/);

  assert.equal(isInternalDomain("printer.local"), true);
  assert.equal(isInternalDomain("app.internal"), true);
  assert.equal(isInternalDomain("example.com"), false);
  assert.throws(() => validateDomain("printer.local"), /Internal domain/);
  assert.throws(() => validateDomain("app.internal"), /Internal domain/);
});

test("hosts under a configured platform root are reserved", () => {
  const previous = process.env.ROOT_DOMAINS;
  process.env.ROOT_DOMAINS = "example.com,localhost:3000";
  try {
    assert.equal(isReservedPlatformDomain("example.com"), true);
    // Non-reserved label, but still under the platform root.
    assert.equal(isReservedPlatformDomain("myshop.example.com"), true);
    // A real custom domain must stay valid.
    assert.equal(isReservedPlatformDomain("example-shop.com"), false);
    assert.equal(validateDomain("example-shop.com"), "example-shop.com");
  } finally {
    if (previous === undefined) delete process.env.ROOT_DOMAINS;
    else process.env.ROOT_DOMAINS = previous;
  }
});

// ============================================================
// DNS classification (no live lookups)
// ============================================================

test("TXT record name and value helpers are stable", () => {
  assert.equal(
    domainTxtRecordName("example.com"),
    "_siteforge-verification.example.com",
  );
  assert.equal(
    domainTxtRecordValue("token"),
    "siteforge-verification=token",
  );
});

test("checkDomainTxtRecord classifies matches, mismatches and resolver failures", async (t) => {
  t.after(() => setTxtResolverForTesting(null));

  setTxtResolverForTesting(async () => [
    ["siteforge-verification=", "abc"],
  ]);
  assert.deepEqual(
    await checkDomainTxtRecord("example.com", "siteforge-verification=abc"),
    { kind: "match" },
  );

  setTxtResolverForTesting(async () => [["siteforge-verification=other"]]);
  assert.deepEqual(
    await checkDomainTxtRecord("example.com", "siteforge-verification=abc"),
    { kind: "not_found", reason: "mismatch" },
  );

  setTxtResolverForTesting(async () => {
    throw Object.assign(new Error("no such record"), { code: "ENOTFOUND" });
  });
  assert.deepEqual(
    await checkDomainTxtRecord("example.com", "siteforge-verification=abc"),
    { kind: "not_found", reason: "not_found" },
  );

  setTxtResolverForTesting(async () => {
    throw Object.assign(new Error("temporary failure"), { code: "EAI_AGAIN" });
  });
  assert.deepEqual(
    await checkDomainTxtRecord("example.com", "siteforge-verification=abc"),
    { kind: "resolver_error", code: "EAI_AGAIN" },
  );

  setTxtResolverForTesting(async () => []);
  assert.deepEqual(
    await checkDomainTxtRecord("example.com", "siteforge-verification=abc"),
    { kind: "not_found", reason: "not_found" },
  );
});
