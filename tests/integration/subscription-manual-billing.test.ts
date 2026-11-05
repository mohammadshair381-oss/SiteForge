import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createBusinessWithOwner, createPlan, tenantSuffix } from "./helpers/tenant";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
} from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { isManualBillingAllowed } from "@/lib/billing";
import { env } from "@/lib/env";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

// lib/env.ts caches configuration on its first call with no reset, so this file
// cannot share a process with tests that need a different configuration. Each
// test FILE runs in its own Node process: the overrides below are applied after
// the harness sets its defaults but BEFORE connectTestDB() triggers the first
// env() call, so the cached configuration is the production one we assert here.
before(async () => {
  await startIntegrationSuite();
  // Next.js declares process.env.NODE_ENV read-only; the harness uses the same
  // cast when it pins NODE_ENV for the suite.
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  process.env.ALLOW_MANUAL_BILLING = "false";
  process.env.PAYMENT_PROVIDER = "manual";

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
  resetMockCookieStore();
});

function subscriptionUrl(businessId: unknown): string {
  return `http://localhost/api/businesses/${businessId}/subscription`;
}

function ctx(businessId: unknown) {
  return { params: Promise.resolve({ id: String(businessId) }) };
}

test("the cached configuration has manual billing disabled in production", () => {
  assert.equal(env().NODE_ENV, "production");
  assert.equal(env().ALLOW_MANUAL_BILLING, false);
  assert.equal(isManualBillingAllowed(), false);
});

test("paid manual activation is rejected when ALLOW_MANUAL_BILLING is disabled in production", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 4900, interval: "month" });
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.code, "manual_billing_disabled");

  assert.equal(await Subscription.countDocuments({ business: business._id }), 0, "no subscription is created");
  assert.equal(await Payment.countDocuments({ business: business._id }), 0, "no payment is recorded");
});

test("free plans remain selectable when manual billing of paid plans is disabled", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, productLimit: 4 });
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.subscription.status, "active");
  assert.equal(body.entitlements.active, true);
  assert.equal(body.entitlements.productLimit, 4);
});

test("unknown plans still return 404 in production", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: `missing-${tenantSuffix()}` }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "not_found");
});
