import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import {
  createBusinessWithOwner,
  createMembership,
  createPlan,
  createSubscription,
  tenantSuffix,
} from "./helpers/tenant";
import { POST as domainsPOST, GET as domainsGET, DELETE as domainsDELETE } from "@/app/api/businesses/[id]/domains/route";
import { POST as verifyPOST } from "@/app/api/businesses/[id]/domains/verify/route";
import {
  DomainVerification,
  domainStatusOf,
  generateDomainVerificationToken,
  hashDomainVerificationToken,
} from "@/models/DomainVerification";
import { Business } from "@/models/Business";
import { Subscription } from "@/models/Subscription";
import { getPublicStorefront } from "@/lib/tenant";
import { setTxtResolverForTesting } from "@/lib/domain-dns";

/**
 * Phase 4.26.1 — custom-domain lifecycle regression suite.
 *
 * Covers: verified-record persistence (C1), retryable verification (C2),
 * routing revocation (H1), pending cancellation (H2), single-active-domain
 * consistency (H3), token hash validation (M1), entitlement recheck (M2),
 * duplicate mapping (M3), cross-tenant isolation, and legacy records.
 *
 * DNS is always stubbed; the suite never performs a live lookup.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let dnsRecords: string[][] = [];
let dnsError: (Error & { code?: string }) | null = null;

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
  setTxtResolverForTesting(async () => {
    if (dnsError) throw dnsError;
    return dnsRecords;
  });
});

after(async () => {
  setTxtResolverForTesting(null);
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
  dnsRecords = [];
  dnsError = null;
});

function suffix(): string {
  return tenantSuffix().replace(/[^a-z0-9]/g, "");
}

/** A domain that is neither reserved nor a tenant subdomain of the harness. */
function uniqueDomain(label = "shop"): string {
  return `${label}-${suffix()}.example-store.com`;
}

function routes(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(
  method: string,
  path: string,
  body: unknown,
  headers: { cookie: string },
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface DomainApiResponse {
  domain?: string;
  status?: string;
  token?: string;
  expiresAt?: string | null;
  instructions?: { type: string; name: string; value: string; ttl: number };
  previousDomain?: string | null;
  removed?: boolean;
  wasActive?: boolean;
  error?: string;
  code?: string;
  domains?: Array<{
    domain: string;
    status: string;
    verified: boolean;
    active: boolean;
    verifiedAt: string | null;
    expiresAt: string | null;
    attempts: number;
    lastError: string | null;
  }>;
  currentCustomDomain?: string | null;
}

async function readBody(res: Response): Promise<DomainApiResponse> {
  return (await res.json()) as DomainApiResponse;
}

async function postDomain(
  businessId: string,
  headers: { cookie: string },
  domain: string,
): Promise<{ res: Response; body: DomainApiResponse }> {
  const res = await callHandler(
    domainsPOST,
    jsonRequest("POST", `/api/businesses/${businessId}/domains`, { domain }, headers),
    routes(businessId),
  );
  return { res, body: await readBody(res as Response) };
}

async function verifyDomain(
  businessId: string,
  headers: { cookie: string },
  body: { domain: string; token?: string },
): Promise<{ res: Response; body: DomainApiResponse }> {
  const res = await callHandler(
    verifyPOST,
    jsonRequest("POST", `/api/businesses/${businessId}/domains/verify`, body, headers),
    routes(businessId),
  );
  return { res, body: await readBody(res as Response) };
}

async function deleteDomain(
  businessId: string,
  headers: { cookie: string },
  domain: string,
): Promise<{ res: Response; body: DomainApiResponse }> {
  const res = await callHandler(
    domainsDELETE,
    jsonRequest("DELETE", `/api/businesses/${businessId}/domains`, { domain }, headers),
    routes(businessId),
  );
  return { res, body: await readBody(res as Response) };
}

async function listDomains(
  businessId: string,
  headers: { cookie: string },
): Promise<{ res: Response; body: DomainApiResponse }> {
  const res = await callHandler(
    domainsGET,
    jsonRequest("GET", `/api/businesses/${businessId}/domains`, undefined, headers),
    routes(businessId),
  );
  return { res, body: await readBody(res as Response) };
}

interface StoreOptions {
  status?: "draft" | "published";
  customDomain?: boolean;
  price?: number;
}

async function setupStore(options: StoreOptions = {}) {
  const { owner, business } = await createBusinessWithOwner({
    status: options.status ?? "published",
  });
  const plan = await createPlan({
    price: options.price ?? 2900,
    customDomain: options.customDomain ?? true,
  });
  const subscription = await createSubscription(business._id, plan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS),
  });
  const headers = await createAuthHeadersForUser(
    String(owner._id),
    "user",
    owner.tokenVersion,
  );
  return { owner, business, plan, subscription, headers };
}

/** Requests a domain and returns the raw token together with the response. */
async function requestToken(
  store: Awaited<ReturnType<typeof setupStore>>,
  domain: string,
): Promise<string> {
  const { res, body } = await postDomain(String(store.business._id), store.headers, domain);
  assert.equal(res.status, 201, `request failed: ${body.error ?? "unknown"}`);
  assert.ok(body.token, "the raw token is returned once");
  return body.token!;
}

function txtFor(token: string): string[][] {
  return [[`siteforge-verification=${token}`]];
}

async function recordFor(domain: string) {
  const record = await DomainVerification.findOne({ domain }).lean();
  assert.ok(record, `expected a verification record for ${domain}`);
  return record!;
}

// ============================================================
// A. Request / pending state
// ============================================================

test("requesting a domain stores only a hash and a pending expiry", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();

  const { res, body } = await postDomain(String(store.business._id), store.headers, domain);
  assert.equal(res.status, 201);
  assert.equal(body.domain, domain);
  assert.equal(body.status, "pending");
  assert.ok(body.token && body.token.length >= 32);
  assert.equal(
    body.instructions?.value,
    `siteforge-verification=${body.token}`,
    "DNS instructions use the raw token exactly once",
  );
  assert.equal(body.instructions?.name, `_siteforge-verification.${domain}`);

  const record = await recordFor(domain);
  assert.equal(record.status, "pending");
  assert.equal(record.tokenHash, hashDomainVerificationToken(body.token!));
  assert.ok(record.tokenHash !== body.token);
  assert.equal(record.usedAt, null);
  assert.equal(record.verifiedAt, null);
  assert.ok(record.expiresAt instanceof Date);
  assert.ok(record.expiresAt!.getTime() > Date.now());

  // The raw token is never persisted.
  const serialized = JSON.stringify({ ...record, tokenHash: undefined });
  assert.equal(serialized.includes(body.token!), false);
});

test("verifying rejects invalid domains and reserved hosts before creating a record", async () => {
  const store = await setupStore();
  const id = String(store.business._id);

  const localhost = await postDomain(id, store.headers, "localhost");
  assert.equal(localhost.res.status, 400);
  assert.equal(localhost.body.code, "invalid_domain");

  const reserved = await postDomain(id, store.headers, "api.example.com");
  assert.equal(reserved.res.status, 400);
  assert.equal(reserved.body.code, "reserved_domain");

  assert.equal(await DomainVerification.countDocuments({ business: id }), 0);
});

// ============================================================
// B. Successful verification + C1 persistence
// ============================================================

test("successful verification activates the domain and clears the pending expiry", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);

  dnsRecords = txtFor(token);
  const { res, body } = await verifyDomain(String(store.business._id), store.headers, {
    domain,
    token,
  });
  assert.equal(res.status, 200, body.error);
  assert.equal(body.previousDomain, null);

  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "verified");
  assert.equal(record.status, "verified");
  assert.ok(record.verifiedAt instanceof Date);
  // C1: a verified record must not be TTL-collectable when the token expires.
  assert.equal(record.expiresAt, null);

  const business = await Business.findById(store.business._id).lean();
  assert.equal(business?.customDomain, domain);

  const storefront = await getPublicStorefront(domain);
  assert.ok(storefront, "the verified custom domain resolves");
  assert.equal(storefront!.business._id.toString(), String(store.business._id));

  // A second request for an already-verified domain is refused with a stable code.
  const again = await postDomain(String(store.business._id), store.headers, domain);
  assert.equal(again.res.status, 409);
  assert.equal(again.body.code, "domain_already_verified");
});

test("a verified domain keeps routing even if its token expiry is in the past (C1)", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  dnsRecords = txtFor(token);
  const verified = await verifyDomain(String(store.business._id), store.headers, {
    domain,
    token,
  });
  assert.equal(verified.res.status, 200);

  // Simulate a legacy verified document whose token expiry was never cleared.
  await DomainVerification.updateOne(
    { domain },
    { $set: { expiresAt: new Date(Date.now() - DAY_MS) } },
  );

  // Routing must not depend on the pending-token expiry.
  const storefront = await getPublicStorefront(domain);
  assert.ok(storefront, "a verified domain is not hidden by its old token expiry");
  assert.equal(storefront!.business._id.toString(), String(store.business._id));
});

test("pending or expired verification records never route (fail closed)", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  assert.ok(token);

  // Even if the business document were (incorrectly) pointed at the domain,
  // a pending record must not resolve.
  await Business.updateOne(
    { _id: store.business._id },
    { $set: { customDomain: domain } },
  );
  assert.equal(await getPublicStorefront(domain), null);

  await DomainVerification.updateOne(
    { domain },
    { $set: { expiresAt: new Date(Date.now() - DAY_MS) } },
  );
  assert.equal(await getPublicStorefront(domain), null);
});

// ============================================================
// C. Retryable verification (C2)
// ============================================================

test("a failed DNS check does not consume the token and can be retried (C2)", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  const before = await recordFor(domain);

  dnsRecords = [];
  const first = await verifyDomain(String(store.business._id), store.headers, {
    domain,
    token,
  });
  assert.equal(first.res.status, 400);
  assert.equal(first.body.code, "dns_not_found");
  // The error must not echo the token back to the caller/client log.
  assert.equal(JSON.stringify(first.body).includes(token), false);

  const afterFailure = await recordFor(domain);
  assert.equal(domainStatusOf(afterFailure), "pending");
  assert.equal(afterFailure.usedAt, null);
  assert.equal(afterFailure.verifiedAt, null);
  assert.equal(afterFailure.attempts, 1);
  assert.equal(afterFailure.lastError, "not_found");
  assert.equal(
    afterFailure.expiresAt?.getTime(),
    before.expiresAt?.getTime(),
    "the pending expiry is not shortened by a failed attempt",
  );

  // Retry with the same token once the record has propagated.
  dnsRecords = txtFor(token);
  const second = await verifyDomain(String(store.business._id), store.headers, {
    domain,
    token,
  });
  assert.equal(second.res.status, 200, second.body.error);

  const record = await recordFor(domain);
  assert.equal(record.status, "verified");
  assert.equal(record.attempts, 2);
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, domain);
});

test("DNS failures are classified: mismatch, missing record, resolver outage", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);

  dnsRecords = [["siteforge-verification=some-other-value"]];
  const mismatch = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(mismatch.res.status, 400);
  assert.equal(mismatch.body.code, "dns_mismatch");

  dnsError = Object.assign(new Error("temporary failure"), { code: "EAI_AGAIN" });
  const outage = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(outage.res.status, 502);
  assert.equal(outage.body.code, "dns_lookup_failed");

  dnsError = Object.assign(new Error("no such name"), { code: "ENOTFOUND" });
  const missing = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(missing.res.status, 400);
  assert.equal(missing.body.code, "dns_not_found");

  // Every failure leaves the same pending, retryable record behind.
  const record = await recordFor(domain);
  assert.equal(record.status, "pending");
  assert.equal(record.usedAt, null);
  assert.equal(record.attempts, 3);

  dnsError = null;
  dnsRecords = txtFor(token);
  const success = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(success.res.status, 200, success.body.error);
});

test("an expired request is rejected and can be refreshed with a new token", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const oldToken = await requestToken(store, domain);

  await DomainVerification.updateOne(
    { domain },
    { $set: { expiresAt: new Date(Date.now() - DAY_MS) } },
  );

  dnsRecords = txtFor(oldToken);
  const expired = await verifyDomain(id, store.headers, { domain, token: oldToken });
  assert.equal(expired.res.status, 400);
  assert.equal(expired.body.code, "token_expired");

  // Re-request refreshes the same record with a brand-new token.
  const newToken = await requestToken(store, domain);
  assert.notEqual(newToken, oldToken);
  assert.equal(await DomainVerification.countDocuments({ domain }), 1);

  const staleToken = await verifyDomain(id, store.headers, { domain, token: oldToken });
  assert.equal(staleToken.res.status, 400);
  assert.equal(staleToken.body.code, "invalid_token");

  dnsRecords = txtFor(newToken);
  const success = await verifyDomain(id, store.headers, { domain, token: newToken });
  assert.equal(success.res.status, 200, success.body.error);
});

// ============================================================
// D. Token validation (M1)
// ============================================================

test("the stored token hash is enforced (M1)", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);

  const wrongToken = generateDomainVerificationToken();
  dnsRecords = txtFor(wrongToken);
  const rejected = await verifyDomain(id, store.headers, {
    domain,
    token: wrongToken,
  });
  assert.equal(rejected.res.status, 400);
  assert.equal(rejected.body.code, "invalid_token");

  const record = await recordFor(domain);
  assert.equal(record.status, "pending");
  assert.equal(record.lastError, "invalid_token");
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, null);

  dnsRecords = txtFor(token);
  const accepted = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(accepted.res.status, 200, accepted.body.error);
});

test("verification without a token is rejected while pending", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  await requestToken(store, domain);

  const missing = await verifyDomain(String(store.business._id), store.headers, { domain });
  assert.equal(missing.res.status, 400);
  assert.equal(missing.body.code, "token_required");
});

// ============================================================
// E. Single active domain (H3)
// ============================================================

test("verifying a second domain revokes the first and reports the switch (H3)", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const first = uniqueDomain("first");
  const second = uniqueDomain("second");

  const firstToken = await requestToken(store, first);
  dnsRecords = txtFor(firstToken);
  assert.equal((await verifyDomain(id, store.headers, { domain: first, token: firstToken })).res.status, 200);

  const secondToken = await requestToken(store, second);
  dnsRecords = txtFor(secondToken);
  const switched = await verifyDomain(id, store.headers, {
    domain: second,
    token: secondToken,
  });
  assert.equal(switched.res.status, 200, switched.body.error);
  assert.equal(switched.body.previousDomain, first);

  const business = await Business.findById(store.business._id).lean();
  assert.equal(business?.customDomain, second);

  const firstRecord = await recordFor(first);
  assert.equal(domainStatusOf(firstRecord), "revoked");
  assert.equal(firstRecord.expiresAt, null);

  // Routing follows the single active domain immediately.
  assert.equal(await getPublicStorefront(first), null);
  assert.ok(await getPublicStorefront(second));

  const listed = await listDomains(id, store.headers);
  assert.equal(listed.res.status, 200);
  const visible = listed.body.domains ?? [];
  assert.deepEqual(
    visible.map((entry) => entry.domain),
    [second],
    "revoked records are not presented as verified domains",
  );
  assert.equal(visible[0].active, true);
  assert.equal(listed.body.currentCustomDomain, second);
});

test("concurrent verification attempts activate the domain exactly once", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  dnsRecords = txtFor(token);

  const results = await Promise.all([
    verifyDomain(id, store.headers, { domain, token }),
    verifyDomain(id, store.headers, { domain, token }),
  ]);

  for (const result of results) {
    assert.equal(result.res.status, 200, result.body.error);
  }

  assert.equal(await DomainVerification.countDocuments({ domain }), 1);
  const record = await recordFor(domain);
  assert.equal(record.status, "verified");
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, domain);
});

// ============================================================
// F. Removal (H1 / H2)
// ============================================================

test("removing the active domain stops routing immediately (H1)", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  dnsRecords = txtFor(token);
  assert.equal((await verifyDomain(id, store.headers, { domain, token })).res.status, 200);
  assert.ok(await getPublicStorefront(domain));

  const removed = await deleteDomain(id, store.headers, domain);
  assert.equal(removed.res.status, 200);
  assert.equal(removed.body.removed, true);
  assert.equal(removed.body.wasActive, true);

  assert.equal(await getPublicStorefront(domain), null, "routing stops in the same request");

  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "revoked");
  assert.equal(record.expiresAt, null);
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, null);

  // The record is preserved (no data loss) but hidden from the dashboard list.
  const listed = await listDomains(id, store.headers);
  assert.deepEqual(listed.body.domains, []);
});

test("pending domains can be cancelled and requested again (H2)", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  await requestToken(store, domain);

  const cancelled = await deleteDomain(id, store.headers, domain);
  assert.equal(cancelled.res.status, 200);
  assert.equal(cancelled.body.wasActive, false);

  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "revoked");
  // The cancelled request can no longer be verified with its old token.
  const verifyCancelled = await verifyDomain(id, store.headers, {
    domain,
    token: generateDomainVerificationToken(),
  });
  assert.equal(verifyCancelled.res.status, 404);

  // Re-adding the same domain reuses the record and issues a new token.
  const newToken = await requestToken(store, domain);
  assert.equal(await DomainVerification.countDocuments({ domain }), 1);
  dnsRecords = txtFor(newToken);
  const verified = await verifyDomain(id, store.headers, { domain, token: newToken });
  assert.equal(verified.res.status, 200, verified.body.error);
});

test("a verified non-active domain can be removed", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  dnsRecords = txtFor(token);
  assert.equal((await verifyDomain(id, store.headers, { domain, token })).res.status, 200);

  // Simulate another verified domain having become active: the record for
  // `domain` is still verified, but it is no longer the active one.
  await Business.updateOne(
    { _id: store.business._id },
    { $set: { customDomain: uniqueDomain("other") } },
  );

  const listed = await listDomains(id, store.headers);
  assert.equal(listed.body.domains?.length, 1);
  assert.equal(listed.body.domains?.[0].active, false, "verified but not active");

  const removed = await deleteDomain(id, store.headers, domain);
  assert.equal(removed.res.status, 200, removed.body.error);
  assert.equal(removed.body.wasActive, false);
  assert.equal(domainStatusOf(await recordFor(domain)), "revoked");
  // The unrelated active domain is untouched.
  assert.equal(
    (await Business.findById(store.business._id).lean())?.customDomain,
    listed.body.currentCustomDomain,
  );
});

test("removing an unknown domain returns 404", async () => {
  const store = await setupStore();
  const result = await deleteDomain(String(store.business._id), store.headers, uniqueDomain());
  assert.equal(result.res.status, 404);
  assert.equal(result.body.code, "not_found");
});

// ============================================================
// G. Entitlement recheck (M2)
// ============================================================

test("a downgraded subscription cannot activate a pending custom domain (M2)", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);

  // Downgrade between request and verification.
  const freePlan = await createPlan({ price: 0, customDomain: false });
  await Subscription.updateOne(
    { _id: store.subscription._id },
    { $set: { plan: freePlan._id } },
  );

  dnsRecords = txtFor(token);
  const result = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(result.res.status, 402);
  assert.equal(result.body.code, "limit_reached");

  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "pending");
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, null);
  assert.equal(await getPublicStorefront(domain), null);
});

// ============================================================
// H. Duplicate / cross-tenant handling (M3 / M5)
// ============================================================

test("duplicate-domain errors are generic and leak no tenant information (M5)", async () => {
  const first = await setupStore();
  const second = await setupStore();
  const domain = uniqueDomain();

  const pending = await postDomain(String(first.business._id), first.headers, domain);
  assert.equal(pending.res.status, 201);

  const blocked = await postDomain(String(second.business._id), second.headers, domain);
  assert.equal(blocked.res.status, 409);
  assert.equal(blocked.body.code, "domain_in_use");
  assert.equal(JSON.stringify(blocked.body).includes(String(first.business._id)), false);
  assert.equal(JSON.stringify(blocked.body).includes(first.business.name), false);

  // A verified domain owned by another business is equally opaque.
  dnsRecords = txtFor(pending.body.token!);
  const verified = await verifyDomain(String(first.business._id), first.headers, {
    domain,
    token: pending.body.token!,
  });
  assert.equal(verified.res.status, 200);

  const stillBlocked = await postDomain(String(second.business._id), second.headers, domain);
  assert.equal(stillBlocked.res.status, 409);
  assert.equal(stillBlocked.body.code, "domain_in_use");
});

test("activation conflicts with another business's active domain map to domain_in_use (M3)", async () => {
  const owner = await setupStore();
  const other = await setupStore();
  const domain = uniqueDomain();

  // Another tenant already carries the domain as its active custom domain.
  await Business.updateOne(
    { _id: owner.business._id },
    { $set: { customDomain: domain } },
  );

  const token = await requestToken(other, domain);
  dnsRecords = txtFor(token);
  const conflict = await verifyDomain(String(other.business._id), other.headers, {
    domain,
    token,
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.code, "domain_in_use");

  assert.equal(
    (await Business.findById(other.business._id).lean())?.customDomain,
    null,
    "the losing business never ends up with the domain",
  );
  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "revoked");
});

test("cross-tenant access to another business's domain APIs is forbidden", async () => {
  const owner = await setupStore();
  const intruder = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(owner, domain);

  const ownerId = String(owner.business._id);
  const intruderHeaders = intruder.headers;

  const post = await postDomain(ownerId, intruderHeaders, uniqueDomain());
  assert.equal(post.res.status, 403);

  const verify = await verifyDomain(ownerId, intruderHeaders, { domain, token });
  assert.equal(verify.res.status, 403);

  const remove = await deleteDomain(ownerId, intruderHeaders, domain);
  assert.equal(remove.res.status, 403);

  const list = await listDomains(ownerId, intruderHeaders);
  assert.equal(list.res.status, 403);

  // The owner's pending record is untouched.
  const record = await recordFor(domain);
  assert.equal(domainStatusOf(record), "pending");
});

test("managers and staff can read but not mutate domains", async () => {
  const store = await setupStore();
  const manager = await createUser();
  await createMembership(store.business._id, manager._id, "manager");
  const managerHeaders = await createAuthHeadersForUser(
    String(manager._id),
    "user",
    manager.tokenVersion,
  );

  const list = await listDomains(String(store.business._id), managerHeaders);
  assert.equal(list.res.status, 200);

  const post = await postDomain(String(store.business._id), managerHeaders, uniqueDomain());
  assert.equal(post.res.status, 403);
});

// ============================================================
// I. Legacy records
// ============================================================

test("legacy pending records without a status field can still be verified", async () => {
  const store = await setupStore();
  const id = String(store.business._id);
  const domain = uniqueDomain();
  const token = generateDomainVerificationToken();
  const now = new Date();

  await DomainVerification.collection.insertOne({
    business: store.business._id,
    domain,
    tokenHash: hashDomainVerificationToken(token),
    expiresAt: new Date(now.getTime() + DAY_MS),
    usedAt: null,
    verifiedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  const legacy = await recordFor(domain);
  assert.equal(legacy.status, undefined, "the fixture predates the status field");
  assert.equal(domainStatusOf(legacy), "pending");

  dnsRecords = txtFor(token);
  const result = await verifyDomain(id, store.headers, { domain, token });
  assert.equal(result.res.status, 200, result.body.error);

  const record = await recordFor(domain);
  assert.equal(record.status, "verified");
  assert.equal(record.expiresAt, null);
  assert.equal((await Business.findById(store.business._id).lean())?.customDomain, domain);
});

test("legacy verified and legacy removed records keep the correct effective state", async () => {
  const verifiedStore = await setupStore();
  const verifiedDomain = uniqueDomain("legacy-verified");
  const verifiedAt = new Date(Date.now() - 2 * DAY_MS);
  const consumedAt = new Date(verifiedAt.getTime() - 1000);

  await DomainVerification.collection.insertOne({
    business: verifiedStore.business._id,
    domain: verifiedDomain,
    tokenHash: hashDomainVerificationToken(generateDomainVerificationToken()),
    // Legacy TTL expiry that has already passed: routing must ignore it.
    expiresAt: new Date(Date.now() - DAY_MS),
    usedAt: consumedAt,
    verifiedAt,
    createdAt: verifiedAt,
    updatedAt: verifiedAt,
  });
  await Business.updateOne(
    { _id: verifiedStore.business._id },
    { $set: { customDomain: verifiedDomain } },
  );

  assert.ok(await getPublicStorefront(verifiedDomain), "legacy verified domain resolves");

  const removedStore = await setupStore();
  const removedDomain = uniqueDomain("legacy-removed");
  const removedVerifiedAt = new Date(Date.now() - 2 * DAY_MS);
  const removedUsedAt = new Date(Date.now() - DAY_MS);

  await DomainVerification.collection.insertOne({
    business: removedStore.business._id,
    domain: removedDomain,
    tokenHash: hashDomainVerificationToken(generateDomainVerificationToken()),
    expiresAt: new Date(Date.now() + DAY_MS),
    usedAt: removedUsedAt,
    verifiedAt: removedVerifiedAt,
    createdAt: removedVerifiedAt,
    updatedAt: removedUsedAt,
  });

  const removedRecord = await recordFor(removedDomain);
  assert.equal(domainStatusOf(removedRecord), "revoked");
  assert.equal(await getPublicStorefront(removedDomain), null);

  const listed = await listDomains(String(removedStore.business._id), removedStore.headers);
  assert.deepEqual(listed.body.domains, [], "legacy revoked records are hidden");
});

// ============================================================
// J. Response hygiene
// ============================================================

test("the domain list never exposes token hashes or raw tokens", async () => {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);

  const listed = await listDomains(String(store.business._id), store.headers);
  assert.equal(listed.res.status, 200);
  const serialized = JSON.stringify(listed.body);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(hashDomainVerificationToken(token)), false);
  assert.equal(listed.body.domains?.length, 1);
  assert.equal(listed.body.domains?.[0].status, "pending");
  assert.equal(listed.body.domains?.[0].active, false);
});

// ============================================================
// M4. Ownership freshness and renewal
// ============================================================

const FRESH_LIMIT_MS = 90 * DAY_MS;

async function verifiedStore() {
  const store = await setupStore();
  const domain = uniqueDomain();
  const token = await requestToken(store, domain);
  dnsRecords = txtFor(token);
  const verified = await verifyDomain(String(store.business._id), store.headers, { domain, token });
  assert.equal(verified.res.status, 200, verified.body.error);
  return { store, domain, id: String(store.business._id) };
}

async function ageOwnership(domain: string, ms: number) {
  const past = new Date(Date.now() - ms);
  await DomainVerification.updateOne(
    { domain },
    { $set: { ownershipCheckedAt: past, verifiedAt: past } },
  );
}

async function renewalRequest(
  store: Awaited<ReturnType<typeof setupStore>>,
  businessId: string,
  domain: string,
) {
  const res = (await callHandler(
    domainsPOST,
    jsonRequest("POST", `/api/businesses/${businessId}/domains`, { domain, renew: true }, store.headers),
    routes(businessId),
  )) as Response;
  return { res, body: await readBody(res) };
}

async function requestRenewal(
  store: Awaited<ReturnType<typeof setupStore>>,
  domain: string,
): Promise<string> {
  const { res, body } = await renewalRequest(store, String(store.business._id), domain);
  assert.equal(res.status, 201, body.error);
  assert.ok(body.token);
  return body.token!;
}

test("ownership proof is recorded at verification and a fresh domain routes", async () => {
  const { domain } = await verifiedStore();
  const record = await recordFor(domain);
  assert.ok(record.ownershipCheckedAt instanceof Date);
  assert.ok(await getPublicStorefront(domain));
});

test("a domain whose ownership proof is older than the limit stops routing but is not deleted", async () => {
  const { store, domain, id } = await verifiedStore();
  await ageOwnership(domain, FRESH_LIMIT_MS + DAY_MS);

  assert.equal(await getPublicStorefront(domain), null, "stale proof fails closed");
  assert.equal((await recordFor(domain)).status, "verified", "nothing is revoked or deleted");

  const list = await listDomains(id, store.headers);
  const row = list.body.domains!.find((d) => d.domain === domain)! as {
    active: boolean;
    ownershipStale?: boolean;
  };
  assert.equal(row.ownershipStale, true);
  assert.equal(row.active, false, "a stale domain is not reported as active");
});

test("legacy verified records without ownershipCheckedAt fall back to verifiedAt", async () => {
  const { domain } = await verifiedStore();
  await DomainVerification.collection.updateOne(
    { domain },
    { $unset: { ownershipCheckedAt: "" }, $set: { verifiedAt: new Date(Date.now() - DAY_MS) } },
  );
  assert.ok(await getPublicStorefront(domain), "recent legacy proof still routes");

  await DomainVerification.collection.updateOne(
    { domain },
    { $set: { verifiedAt: new Date(Date.now() - FRESH_LIMIT_MS - DAY_MS) } },
  );
  assert.equal(await getPublicStorefront(domain), null, "old legacy proof fails closed");
});

test("renewal restores a stale domain only after DNS proof; failed checks change nothing", async () => {
  const { store, domain, id } = await verifiedStore();
  await ageOwnership(domain, FRESH_LIMIT_MS + DAY_MS);

  const renewalToken = await requestRenewal(store, domain);
  const issued = await recordFor(domain);
  assert.equal(issued.status, "verified");
  assert.equal(issued.renewalTokenHash, hashDomainVerificationToken(renewalToken));
  assert.ok(issued.renewalExpiresAt instanceof Date);

  dnsRecords = [];
  const failed = await verifyDomain(id, store.headers, { domain, token: renewalToken });
  assert.equal(failed.res.status, 400);
  assert.equal(failed.body.code, "dns_not_found");
  assert.equal(await getPublicStorefront(domain), null);

  dnsRecords = txtFor(renewalToken);
  const renewed = await verifyDomain(id, store.headers, { domain, token: renewalToken });
  assert.equal(renewed.res.status, 200, renewed.body.error);
  assert.ok(await getPublicStorefront(domain), "renewed domain routes again");

  const after = await recordFor(domain);
  assert.equal(after.renewalTokenHash, null);
  assert.equal(after.expiresAt, null);
});

test("a transient resolver failure during renewal does not change the domain's state", async () => {
  const { store, domain, id } = await verifiedStore();
  const renewalToken = await requestRenewal(store, domain);
  const before = await recordFor(domain);

  dnsError = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
  const failed = await verifyDomain(id, store.headers, { domain, token: renewalToken });
  assert.equal(failed.res.status, 502);
  assert.equal(failed.body.code, "dns_lookup_failed");

  const after = await recordFor(domain);
  assert.equal(after.status, "verified");
  assert.equal(String(after.ownershipCheckedAt), String(before.ownershipCheckedAt));
  assert.equal(after.renewalTokenHash, before.renewalTokenHash, "token stays retryable");
  assert.ok(await getPublicStorefront(domain), "a fresh domain keeps serving");
});

test("renewal rejects a wrong token and a request with no renewal outstanding", async () => {
  const { store, domain, id } = await verifiedStore();

  const none = await verifyDomain(id, store.headers, {
    domain,
    token: generateDomainVerificationToken(),
  });
  assert.equal(none.res.status, 400);
  assert.equal(none.body.code, "invalid_token");

  await requestRenewal(store, domain);
  const wrong = await verifyDomain(id, store.headers, {
    domain,
    token: generateDomainVerificationToken(),
  });
  assert.equal(wrong.res.status, 400);
  assert.equal(wrong.body.code, "invalid_token");
});

test("activating a verified domain with stale ownership requires renewal", async () => {
  const { store, domain, id } = await verifiedStore();
  await ageOwnership(domain, FRESH_LIMIT_MS + DAY_MS);
  const attempt = await verifyDomain(id, store.headers, { domain });
  assert.equal(attempt.res.status, 409);
  assert.equal(attempt.body.code, "ownership_stale");
});

test("another tenant cannot start a renewal for a domain it does not own", async () => {
  const mine = await verifiedStore();
  const other = await setupStore();
  const { res, body } = await renewalRequest(other, String(other.business._id), mine.domain);
  assert.equal(res.status, 409);
  assert.equal(body.code, "domain_in_use");
  assert.equal((await recordFor(mine.domain)).renewalTokenHash ?? null, null);
});

test("a downgraded plan cannot renew ownership", async () => {
  const { store, domain } = await verifiedStore();
  await Subscription.deleteMany({ business: store.business._id });
  const { res } = await renewalRequest(store, String(store.business._id), domain);
  assert.ok([402, 403].includes(res.status), `unexpected status ${res.status}`);
});
