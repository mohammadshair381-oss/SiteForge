import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createBusinessWithOwner, createPlan, createSubscription, tenantSuffix } from "./helpers/tenant";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
  type AuthHeaders,
} from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { GET as subscriptionGET, POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { env } from "@/lib/env";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

// Isolated process (see subscription-manual-billing.test.ts): configure a
// non-manual provider before the first env() call, then assert the checkout
// gate. Live checkout is intentionally not implemented.
before(async () => {
  await startIntegrationSuite();
  process.env.PAYMENT_PROVIDER = "openpay";

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

function authedGet(url: string, auth: AuthHeaders): Request {
  return new Request(url, { method: "GET", headers: { cookie: auth.cookie } });
}

test("the cached provider is not manual", () => {
  assert.equal(env().PAYMENT_PROVIDER, "openpay");
});

test("subscription POST returns 501 when PAYMENT_PROVIDER is not manual", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.equal(body.code, "not_implemented");

  assert.equal(await Subscription.countDocuments({ business: business._id }), 0, "no subscription is created");
  assert.equal(await Payment.countDocuments({ business: business._id }), 0, "no payment is recorded");
});

test("a valid plan is required before the provider gate (unknown plans return 404)", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: `missing-${tenantSuffix()}` }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 404, "the plan lookup runs before the provider check");
  assert.equal((await res.json()).code, "not_found");
});

test("subscription GET is unaffected by the provider setting", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await createAuthHeadersForUser(owner._id.toString(), "user", owner.tokenVersion);

  const res = await callHandler(subscriptionGET, authedGet(subscriptionUrl(business._id), auth), ctx(business._id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.entitlements.planKey, plan.key);
});
