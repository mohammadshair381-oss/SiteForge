import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import {
  createBusinessWithOwner,
  createMembership,
  createPlan,
  createSubscription,
  tenantSuffix,
} from "./helpers/tenant";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
  type AuthHeaders,
} from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { GET as subscriptionGET, POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

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

function ownerAuth(user: { _id: { toString(): string }; tokenVersion: number }) {
  return createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);
}

// ============================================================
// A. Subscription GET
// ============================================================

test("subscription GET rejects unauthenticated requests", async () => {
  const { business } = await createBusinessWithOwner();
  const req = new Request(subscriptionUrl(business._id), { method: "GET" });
  const res = await callHandler(subscriptionGET, req, ctx(business._id));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "unauthenticated");
});

test("subscription GET returns subscription, entitlements, and payment history to the owner", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, productLimit: 7, staffLimit: 3 });
  const subscription = await createSubscription(business._id, plan._id, { status: "active" });
  const payment = await Payment.create({
    business: business._id,
    subscription: subscription._id,
    amount: 2900,
    currency: "USD",
    status: "succeeded",
    provider: "manual",
    description: "subscription history payment",
    paidAt: new Date(),
  });

  const auth = await ownerAuth(owner);
  const res = await callHandler(subscriptionGET, authedGet(subscriptionUrl(business._id), auth), ctx(business._id));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(body.entitlements, "entitlements should be returned");
  assert.equal(body.entitlements.planKey, plan.key);
  assert.equal(body.entitlements.active, true);
  assert.equal(body.entitlements.productLimit, 7);
  assert.equal(body.entitlements.staffLimit, 3);

  assert.ok(body.subscription, "subscription should be returned");
  assert.equal(body.subscription._id, subscription._id.toString());
  assert.equal(body.subscription.status, "active");
  assert.ok(body.subscription.plan, "the subscription's plan should be populated");
  assert.equal(body.subscription.plan.key, plan.key);
  assert.equal(body.subscription.plan.name, plan.name);

  assert.equal(body.payments.length, 1);
  assert.equal(body.payments[0]._id, payment._id.toString());
  assert.equal(body.payments[0].amount, 2900);
  assert.equal(body.payments[0].status, "succeeded");
});

test("subscription GET limits payment history to 50 and orders it newest first", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });

  const base = Date.now() - 600_000;
  const docs = [];
  for (let i = 0; i < 55; i++) {
    const at = new Date(base + i * 1000);
    docs.push({
      business: business._id,
      subscription: null,
      amount: i,
      currency: "USD",
      status: "succeeded" as const,
      provider: "manual",
      providerEventId: null,
      providerPaymentId: "",
      description: `payment-${i}`,
      paidAt: at,
      createdAt: at,
      updatedAt: at,
    });
  }
  await Payment.collection.insertMany(docs);

  const auth = await ownerAuth(owner);
  const res = await callHandler(subscriptionGET, authedGet(subscriptionUrl(business._id), auth), ctx(business._id));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.payments.length, 50, "history is capped at the route's maximum of 50");

  const descriptions: string[] = body.payments.map((p: { description: string }) => p.description);
  assert.equal(descriptions[0], "payment-54", "newest payment is returned first");
  assert.equal(descriptions[49], "payment-5", "the 50th entry is the 50th-newest payment");
  assert.ok(!descriptions.includes("payment-4"), "the 5 oldest payments are excluded by the limit");

  for (let i = 1; i < body.payments.length; i++) {
    const prev = new Date(body.payments[i - 1].createdAt).getTime();
    const cur = new Date(body.payments[i].createdAt).getTime();
    assert.ok(prev >= cur, "payments are ordered newest first");
  }
});

test("subscription GET rejects a user with no access to the business", async () => {
  const { business } = await createBusinessWithOwner();
  const outsider = await createUser();
  const auth = await ownerAuth(outsider);
  const res = await callHandler(subscriptionGET, authedGet(subscriptionUrl(business._id), auth), ctx(business._id));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "forbidden");
});

test("subscription GET (payment history) is owner-only: staff and managers are refused", async () => {
  const { business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });
  for (const role of ["staff", "manager"] as const) {
    const member = await createUser();
    await createMembership(business._id, member._id, role);
    const auth = await ownerAuth(member);
    const res = await callHandler(subscriptionGET, authedGet(subscriptionUrl(business._id), auth), ctx(business._id));
    assert.equal(res.status, 403, `${role} must not read billing (AGENTS.md role matrix)`);
    assert.equal((await res.json()).code, "forbidden");
  }
});

// ============================================================
// B. Subscription POST
// ============================================================

test("subscription POST activates a free plan without creating a payment", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, productLimit: 11, staffLimit: 2 });
  const auth = await ownerAuth(owner);

  const req = makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth);
  const res = await callHandler(subscriptionPOST, req, ctx(business._id));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.subscription.status, "active");
  assert.equal(body.subscription.provider, "manual");
  assert.equal(body.entitlements.active, true);
  assert.equal(body.entitlements.planKey, plan.key);
  assert.equal(body.entitlements.productLimit, 11);

  const stored = await Subscription.findOne({ business: business._id });
  assert.ok(stored, "a subscription should be persisted");
  assert.equal(stored.plan.toString(), plan._id.toString());
  assert.equal(stored.status, "active");
  assert.equal(await Payment.countDocuments({ business: business._id }), 0, "free plans record no payment");

  assert.ok(stored.currentPeriodStart instanceof Date);
  assert.ok(stored.currentPeriodEnd instanceof Date);
  const expectedEnd = new Date(stored.currentPeriodStart);
  expectedEnd.setMonth(expectedEnd.getMonth() + 1);
  assert.equal(stored.currentPeriodEnd.getTime(), expectedEnd.getTime(), "monthly period is one calendar month");
});

test("subscription POST activates a paid plan through manual billing and records a payment", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 2900, interval: "month" });
  const auth = await ownerAuth(owner);

  const req = makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth);
  const res = await callHandler(subscriptionPOST, req, ctx(business._id));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.subscription.status, "active");
  assert.equal(body.entitlements.active, true);
  assert.equal(body.entitlements.planKey, plan.key);

  const payments = await Payment.find({ business: business._id });
  assert.equal(payments.length, 1, "a paid manual activation records exactly one payment");
  assert.equal(payments[0].amount, 2900);
  assert.equal(payments[0].status, "succeeded");
  assert.equal(payments[0].provider, "manual");
  assert.equal(payments[0].currency, "USD");
  assert.ok(payments[0].subscription, "the payment links to the subscription");
  assert.equal(payments[0].subscription!.toString(), body.subscription._id);
});

test("subscription POST applies a one-year period for a yearly plan", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 9900, interval: "year" });
  const auth = await ownerAuth(owner);

  const req = makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, auth);
  const res = await callHandler(subscriptionPOST, req, ctx(business._id));
  assert.equal(res.status, 200);

  const stored = await Subscription.findOne({ business: business._id });
  assert.ok(stored);
  assert.ok(stored.currentPeriodStart instanceof Date);
  assert.ok(stored.currentPeriodEnd instanceof Date);
  const expectedEnd = new Date(stored.currentPeriodStart);
  expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
  assert.equal(stored.currentPeriodEnd.getTime(), expectedEnd.getTime(), "yearly period is one calendar year");
});

test("subscription POST normalizes planKey casing and whitespace", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ key: `norm-${tenantSuffix()}`, price: 0 });
  const auth = await ownerAuth(owner);

  const req = makeAuthenticatedRequest(
    subscriptionUrl(business._id),
    { planKey: `  ${plan.key.toUpperCase()}  ` },
    auth,
  );
  const res = await callHandler(subscriptionPOST, req, ctx(business._id));
  assert.equal(res.status, 200);

  const stored = await Subscription.findOne({ business: business._id });
  assert.ok(stored);
  assert.equal(stored.plan.toString(), plan._id.toString(), "checkoutSchema trims and lowercases the key");
});

test("subscription POST returns 404 for unknown or inactive plans", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const inactive = await createPlan({ key: `inactive-${tenantSuffix()}`, price: 0, active: false });
  const auth = await ownerAuth(owner);

  const unknownRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: `missing-${tenantSuffix()}` }, auth),
    ctx(business._id),
  );
  assert.equal(unknownRes.status, 404);
  assert.equal((await unknownRes.json()).code, "not_found");

  const inactiveRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: inactive.key }, auth),
    ctx(business._id),
  );
  assert.equal(inactiveRes.status, 404, "inactive plans are not selectable");
  assert.equal((await inactiveRes.json()).code, "not_found");

  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);
});

test("subscription POST rejects malformed and invalid bodies with the documented responses", async () => {
  const { owner, business } = await createBusinessWithOwner();
  await createPlan({ price: 0 });
  const auth = await ownerAuth(owner);

  const malformed = new Request(subscriptionUrl(business._id), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: auth.cookie },
    body: "{ this is not json",
  });
  const malformedRes = await callHandler(subscriptionPOST, malformed, ctx(business._id));
  assert.equal(malformedRes.status, 400);
  assert.equal((await malformedRes.json()).code, "invalid_json");

  const missingRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), {}, auth),
    ctx(business._id),
  );
  assert.equal(missingRes.status, 422);
  assert.equal((await missingRes.json()).code, "validation_error");

  const emptyRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: "" }, auth),
    ctx(business._id),
  );
  assert.equal(emptyRes.status, 422);
  assert.equal((await emptyRes.json()).code, "validation_error");

  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);
});

test("subscription POST rejects unauthenticated, staff, and outsider requests", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 5 });

  const unauthenticated = new Request(subscriptionUrl(business._id), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ planKey: plan.key }),
  });
  const unauthRes = await callHandler(subscriptionPOST, unauthenticated, ctx(business._id));
  assert.equal(unauthRes.status, 401);

  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const staffRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, await ownerAuth(staff)),
    ctx(business._id),
  );
  assert.equal(staffRes.status, 403, "only owners may change the subscription");
  assert.equal((await staffRes.json()).code, "forbidden");

  const outsider = await createUser();
  const outsiderRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, await ownerAuth(outsider)),
    ctx(business._id),
  );
  assert.equal(outsiderRes.status, 403, "a user without access cannot change the subscription");

  // Sanity: the owner can, so the denials above are about role/access, not the request.
  const ownerRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(subscriptionUrl(business._id), { planKey: plan.key }, await ownerAuth(owner)),
    ctx(business._id),
  );
  assert.equal(ownerRes.status, 200);
});
