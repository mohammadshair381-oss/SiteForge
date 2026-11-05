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
import { GET as membersGET, POST as membersPOST } from "@/app/api/businesses/[id]/members/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";
import { getEntitlements } from "@/lib/billing";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";

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

function publishUrl(businessId: unknown): string {
  return `http://localhost/api/businesses/${businessId}/publish`;
}

function membersUrl(businessId: unknown): string {
  return `http://localhost/api/businesses/${businessId}/members`;
}

function ctx(businessId: unknown) {
  return { params: Promise.resolve({ id: String(businessId) }) };
}

function authedGet(url: string, auth: AuthHeaders): Request {
  return new Request(url, { method: "GET", headers: { cookie: auth.cookie } });
}

function authFor(user: { _id: { toString(): string }; tokenVersion: number }) {
  return createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);
}

// ============================================================
// C. Publishing entitlement
// ============================================================

test("an eligible business can publish its website", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await authFor(owner);

  const res = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: true }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "published");
  assert.ok(body.publishedAt, "publishedAt is reported after the write");

  const stored = await Business.findById(business._id);
  assert.ok(stored);
  assert.equal(stored.status, "published");
  assert.ok(stored.publishedAt instanceof Date);
});

test("publishing is rejected without a subscription and leaves the business unchanged", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const auth = await authFor(owner);

  const res = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: true }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 402);
  assert.equal((await res.json()).code, "payment_required");

  const stored = await Business.findById(business._id);
  assert.ok(stored);
  assert.equal(stored.status, "draft", "a rejected publish must not change the status");
  assert.equal(stored.publishedAt, null, "a rejected publish must not set publishedAt");
});

test("an incomplete subscription cannot publish", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "incomplete" });
  const auth = await authFor(owner);

  const res = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: true }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 402);
  assert.equal((await res.json()).code, "payment_required");
});

test("an expired paid subscription cannot publish while an active paid one can", async () => {
  const paidPlan = await createPlan({ price: 2900, interval: "month" });

  // Expired: the paid period ended yesterday.
  const expired = await createBusinessWithOwner();
  await createSubscription(expired.business._id, paidPlan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  const expiredRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(expired.business._id), { publish: true }, await authFor(expired.owner)),
    ctx(expired.business._id),
  );
  assert.equal(expiredRes.status, 402);
  const expiredEntitlements = await getEntitlements(expired.business._id.toString());
  assert.equal(expiredEntitlements.active, false);
  assert.equal(expiredEntitlements.expired, true);
  const expiredStored = await Business.findById(expired.business._id);
  assert.ok(expiredStored);
  assert.equal(expiredStored.status, "draft");

  // Active: the paid period ends tomorrow.
  const active = await createBusinessWithOwner();
  await createSubscription(active.business._id, paidPlan._id, {
    status: "active",
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const activeRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(active.business._id), { publish: true }, await authFor(active.owner)),
    ctx(active.business._id),
  );
  assert.equal(activeRes.status, 200);
  assert.equal((await activeRes.json()).status, "published");
});

test("a suspended business cannot publish or unpublish", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "suspended" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await authFor(owner);

  const publishRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: true }, auth),
    ctx(business._id),
  );
  assert.equal(publishRes.status, 403);
  assert.equal((await publishRes.json()).code, "suspended");

  const unpublishRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: false }, auth),
    ctx(business._id),
  );
  assert.equal(unpublishRes.status, 403, "owners must not be able to unpublish out of suspension");

  const stored = await Business.findById(business._id);
  assert.ok(stored);
  assert.equal(stored.status, "suspended");
});

test("unpublishing an eligible business returns it to draft", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const auth = await authFor(owner);

  const res = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: false }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 200, "unpublishing does not require publishing entitlement");
  const body = await res.json();
  assert.equal(body.status, "draft");
  assert.equal(body.publishedAt, null);
});

test("publishing rejects an invalid body and non-owner access", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active" });

  const invalidRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), {}, await authFor(owner)),
    ctx(business._id),
  );
  assert.equal(invalidRes.status, 422);
  assert.equal((await invalidRes.json()).code, "validation_error");

  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const staffRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(publishUrl(business._id), { publish: true }, await authFor(staff)),
    ctx(business._id),
  );
  assert.equal(staffRes.status, 403, "only owners may publish");
});

// ============================================================
// D. Staff entitlement
// ============================================================

test("the members route enforces the plan staff limit", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 1 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await authFor(owner);

  // The owner membership already occupies one seat; staffLimit 1 allows one more.
  const first = await createUser({ email: `staff-a-${tenantSuffix()}@example.com` });
  const firstRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: first.email, role: "staff" }, auth),
    ctx(business._id),
  );
  assert.equal(firstRes.status, 201);

  const second = await createUser({ email: `staff-b-${tenantSuffix()}@example.com` });
  const secondRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: second.email, role: "staff" }, auth),
    ctx(business._id),
  );
  assert.equal(secondRes.status, 402, "the seat after staffLimit is rejected, counting invitations waiting");
  assert.equal((await secondRes.json()).code, "limit_reached");

  assert.equal(await Membership.countDocuments({ business: business._id }), 1, "nobody joins until they accept");
});

test("a rejected staff invite does not mutate membership records", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 1 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await authFor(owner);

  const first = await createUser({ email: `staff-c-${tenantSuffix()}@example.com` });
  await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: first.email, role: "staff" }, auth),
    ctx(business._id),
  );

  const before = await Membership.countDocuments({ business: business._id });
  const rejected = await createUser({ email: `staff-d-${tenantSuffix()}@example.com` });
  const res = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: rejected.email, role: "staff" }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 402);

  const after = await Membership.countDocuments({ business: business._id });
  assert.equal(after, before, "the rejected invite leaves the membership count unchanged");
  assert.equal(await Membership.findOne({ business: business._id, user: rejected._id }), null);
});

test("adding staff requires an active subscription", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 5 });
  await createSubscription(business._id, plan._id, { status: "incomplete" });
  const auth = await authFor(owner);

  const invitee = await createUser({ email: `staff-e-${tenantSuffix()}@example.com` });
  const res = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: invitee.email, role: "staff" }, auth),
    ctx(business._id),
  );
  assert.equal(res.status, 402);
  assert.equal((await res.json()).code, "payment_required");
  assert.equal(await Membership.countDocuments({ business: business._id }), 1, "only the owner remains");
});

test("members POST requires the owner role and respects tenant isolation", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 5 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const invitee = await createUser({ email: `staff-f-${tenantSuffix()}@example.com` });

  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const staffRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: invitee.email, role: "staff" }, await authFor(staff)),
    ctx(business._id),
  );
  assert.equal(staffRes.status, 403, "staff may not invite members");
  assert.equal((await staffRes.json()).code, "forbidden");

  const outsider = await createUser();
  const outsiderRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: invitee.email, role: "staff" }, await authFor(outsider)),
    ctx(business._id),
  );
  assert.equal(outsiderRes.status, 403, "a user without access cannot invite members");

  const ownerRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(membersUrl(business._id), { email: invitee.email, role: "staff" }, await authFor(owner)),
    ctx(business._id),
  );
  assert.equal(ownerRes.status, 201);
  assert.equal(await Membership.findOne({ business: business._id, user: invitee._id }), null, "an invitation, not a membership");
  assert.equal((await ownerRes.json()).invitation.role, "staff");
});

test("members POST answers the same for an unknown address and an existing member", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, staffLimit: 5 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const auth = await authFor(owner);
  const post = (email: string) => callHandler(membersPOST, makeAuthenticatedRequest(membersUrl(business._id), { email, role: "staff" }, auth), ctx(business._id));
  const missing = await post(`nobody-${tenantSuffix()}@example.com`);
  const existing = await post(owner.email);
  assert.deepEqual([missing.status, existing.status], [201, 201]);
  assert.deepEqual(Object.keys((await missing.json()).invitation).sort(), Object.keys((await existing.json()).invitation).sort());
});

test("members GET is scoped to the business and rejects outsiders", async () => {
  const a = await createBusinessWithOwner();
  const b = await createBusinessWithOwner();
  const bStaff = await createUser();
  await createMembership(b.business._id, bStaff._id, "staff");

  const res = await callHandler(
    membersGET,
    authedGet(membersUrl(a.business._id), await authFor(a.owner)),
    ctx(a.business._id),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.members.length, 1, "only business A's owner is a member of A");
  const returnedUserIds: string[] = body.members.map((m: { user: { _id: string } }) => m.user._id);
  assert.ok(returnedUserIds.includes(a.owner._id.toString()));
  assert.ok(!returnedUserIds.includes(bStaff._id.toString()), "another tenant's member must not appear");

  const outsider = await createUser();
  const denied = await callHandler(
    membersGET,
    authedGet(membersUrl(a.business._id), await authFor(outsider)),
    ctx(a.business._id),
  );
  assert.equal(denied.status, 403);
});
