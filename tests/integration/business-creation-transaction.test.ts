import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
} from "./helpers/auth";
import { createBusinessWithOwner, createPlan } from "./helpers/tenant";
import { Business, Membership, Subscription } from "@/models";
import { POST as businessesPOST } from "@/app/api/businesses/route";

/**
 * Route-level regression coverage for Phase 4.12's atomic business onboarding.
 *
 * These tests call the real `POST /api/businesses` handler against the
 * MongoMemoryReplSet harness, so every write travels through the route's actual
 * `session.withTransaction()` path. Failures at the Membership and Subscription
 * steps are injected by temporarily replacing that model's `create` static with
 * a stub that performs the real in-transaction write and then throws, which
 * proves the rollback of a genuinely persisted row rather than a bypassed
 * transaction. Each stub is restored in a `finally` block.
 */

before(async () => {
  await startIntegrationSuite();
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

interface PatchableModel {
  create: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Replaces `model.create` with a stub that writes through to the real,
 * session-bound operation and then throws. Restoring the original is the
 * caller's responsibility (always in a `finally`).
 */
function failCreateAfterWrite(model: { create: unknown }) {
  const target = model as unknown as PatchableModel;
  const original = target.create;
  let invoked = false;

  target.create = async (...args: unknown[]) => {
    invoked = true;
    await original.apply(target, args);
    throw new Error("injected create failure");
  };

  return {
    wasInvoked: () => invoked,
    restore: () => {
      target.create = original;
    },
  };
}

async function freePlan() {
  return createPlan({ key: "free", price: 0 });
}

async function postBusiness(
  user: { _id: { toString(): string }; tokenVersion: number },
  body: Record<string, unknown>,
) {
  const auth = await createAuthHeadersForUser(
    user._id.toString(),
    "user",
    user.tokenVersion,
  );
  const request = makeAuthenticatedRequest(
    "http://localhost/api/businesses",
    body,
    auth,
  );
  return callHandler(businessesPOST, request);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// -------------------------------------------------------
// A. Successful creation
// -------------------------------------------------------

test("a successful creation persists the business, owner membership and subscription together", async () => {
  const plan = await freePlan();
  const user = await createUser();

  const response = await postBusiness(user, {
    name: "Atomic Cafe",
    category: "food",
    subdomain: "atomic-cafe",
  });
  assert.equal(response.status, 201);

  const payload = (await response.json()) as {
    business: { _id: string };
    entitlements: { planKey: string };
  };

  const businesses = await Business.find({ owner: user._id });
  assert.equal(businesses.length, 1, "exactly one business is created");
  const business = businesses[0];
  assert.equal(business.name, "Atomic Cafe");
  assert.equal(business.slug, "atomic-cafe");
  assert.equal(business.subdomain, "atomic-cafe");
  assert.equal(business.category, "food");
  assert.equal(business.status, "draft");
  // Free plan + food business: the best included theme for the type (lib/theme-tiers.ts).
  assert.equal(business.themeId, "bistro");
  assert.equal(business.owner.toString(), user._id.toString());

  const memberships = await Membership.find({ business: business._id });
  assert.equal(memberships.length, 1, "exactly one initial membership is created");
  const membership = memberships[0];
  assert.equal(membership.role, "owner");
  assert.equal(membership.status, "active");
  assert.equal(membership.user.toString(), user._id.toString());
  assert.equal(membership.business.toString(), business._id.toString());

  const subscriptions = await Subscription.find({ business: business._id });
  assert.equal(subscriptions.length, 1, "exactly one initial subscription is created");
  const subscription = subscriptions[0];
  assert.equal(subscription.status, "active");
  assert.equal(subscription.provider, "manual");
  assert.equal(subscription.plan.toString(), plan._id.toString());
  assert.ok(subscription.currentPeriodStart instanceof Date);
  assert.ok(subscription.currentPeriodEnd instanceof Date);
  const periodMs =
    subscription.currentPeriodEnd!.getTime() -
    subscription.currentPeriodStart!.getTime();
  assert.ok(
    periodMs >= 29 * MS_PER_DAY && periodMs <= 31 * MS_PER_DAY,
    "the initial free period is about 30 days",
  );

  // References stay consistent across the three records.
  assert.equal(business._id.toString(), payload.business._id);
  assert.equal(membership.business.toString(), business._id.toString());
  assert.equal(subscription.business.toString(), business._id.toString());
  assert.equal(payload.entitlements.planKey, "free");
});

// -------------------------------------------------------
// B. Membership creation failure
// -------------------------------------------------------

test("a Membership creation failure rolls back the business and leaves no partial records", async () => {
  await freePlan();
  const user = await createUser();

  const patch = failCreateAfterWrite(Membership);
  let status: number;
  let code: string | undefined;
  try {
    const response = await postBusiness(user, {
      name: "Rollback Cafe A",
      category: "food",
      subdomain: "rollback-membership",
    });
    status = response.status;
    code = ((await response.json()) as { code?: string }).code;
  } finally {
    patch.restore();
  }

  assert.equal(patch.wasInvoked(), true, "the injected failure ran inside the route");
  assert.equal(status, 500);
  assert.equal(code, "internal_error");

  assert.equal(await Business.countDocuments(), 0, "no business survives the abort");
  assert.equal(await Membership.countDocuments(), 0, "the membership write is rolled back");
  assert.equal(await Subscription.countDocuments(), 0, "no subscription is left behind");
});

// -------------------------------------------------------
// C. Subscription creation failure
// -------------------------------------------------------

test("a Subscription creation failure rolls back the business and membership", async () => {
  await freePlan();
  const user = await createUser();

  const patch = failCreateAfterWrite(Subscription);
  let status: number;
  let code: string | undefined;
  try {
    const response = await postBusiness(user, {
      name: "Rollback Cafe B",
      category: "food",
      subdomain: "rollback-subscription",
    });
    status = response.status;
    code = ((await response.json()) as { code?: string }).code;
  } finally {
    patch.restore();
  }

  assert.equal(patch.wasInvoked(), true, "the injected failure ran inside the route");
  assert.equal(status, 500);
  assert.equal(code, "internal_error");

  assert.equal(await Business.countDocuments(), 0, "no business survives the abort");
  assert.equal(await Subscription.countDocuments(), 0, "the subscription write is rolled back");
  assert.equal(await Membership.countDocuments(), 0, "no membership is left behind");
});

// -------------------------------------------------------
// D. Unrelated existing data is untouched
// -------------------------------------------------------

test("a failed creation leaves unrelated pre-existing records unchanged", async () => {
  const plan = await freePlan();
  const existing = await createBusinessWithOwner();
  const existingSubscription = await Subscription.create({
    business: existing.business._id,
    plan: plan._id,
    status: "active",
    provider: "manual",
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * MS_PER_DAY),
  });

  const businessBefore = (await Business.findById(existing.business._id))!.toObject();
  const membershipBefore = (await Membership.findById(existing.membership._id))!.toObject();
  const subscriptionBefore = existingSubscription.toObject();

  const newcomer = await createUser();
  const patch = failCreateAfterWrite(Membership);
  let status: number;
  try {
    const response = await postBusiness(newcomer, {
      name: "Interfering Cafe",
      category: "food",
      subdomain: "interfering-cafe",
    });
    status = response.status;
  } finally {
    patch.restore();
  }

  assert.equal(status, 500);

  assert.equal(await Business.countDocuments(), 1, "only the pre-existing business remains");
  assert.equal(await Membership.countDocuments(), 1, "only the pre-existing membership remains");
  assert.equal(await Subscription.countDocuments(), 1, "only the pre-existing subscription remains");

  const businessAfter = await Business.findById(existing.business._id);
  const membershipAfter = await Membership.findById(existing.membership._id);
  const subscriptionAfter = await Subscription.findById(existingSubscription._id);
  assert.deepStrictEqual(businessAfter!.toObject(), businessBefore);
  assert.deepStrictEqual(membershipAfter!.toObject(), membershipBefore);
  assert.deepStrictEqual(subscriptionAfter!.toObject(), subscriptionBefore);

  assert.equal(
    await Business.countDocuments({ subdomain: "interfering-cafe" }),
    0,
    "the aborted business is not persisted",
  );
});

// -------------------------------------------------------
// Authentication and validation guard the route before any transaction opens
// -------------------------------------------------------

test("authentication and request validation are enforced without creating records", async () => {
  await freePlan();
  const user = await createUser();

  const unauthenticated = new Request("http://localhost/api/businesses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "No Auth Cafe", category: "food" }),
  });
  const unauthenticatedResponse = await callHandler(businessesPOST, unauthenticated);
  assert.equal(unauthenticatedResponse.status, 401);

  const invalidResponse = await postBusiness(user, {
    name: "Bad Category Cafe",
    category: "not-a-category",
  });
  assert.equal(invalidResponse.status, 422);
  assert.equal(
    ((await invalidResponse.json()) as { code?: string }).code,
    "validation_error",
  );

  assert.equal(await Business.countDocuments(), 0, "rejected requests create nothing");
  assert.equal(await Membership.countDocuments(), 0);
  assert.equal(await Subscription.countDocuments(), 0);
});

// -------------------------------------------------------
// E. Error handling and session cleanup
// -------------------------------------------------------

test("a failed creation returns a JSON error and the connection stays usable", async () => {
  await freePlan();
  const user = await createUser();

  const patch = failCreateAfterWrite(Membership);
  let status: number;
  let body: { error?: string; code?: string };
  try {
    const response = await postBusiness(user, {
      name: "Cleanup Cafe",
      category: "food",
      subdomain: "cleanup-cafe",
    });
    status = response.status;
    body = (await response.json()) as { error?: string; code?: string };
  } finally {
    patch.restore();
  }

  assert.equal(status, 500);
  assert.equal(body.code, "internal_error");
  assert.equal(typeof body.error, "string");
  assert.equal(await Business.countDocuments(), 0);

  // A subsequent, uninjected creation must succeed, proving that the failed
  // request ended its session instead of leaking an open transaction.
  const retry = await postBusiness(user, {
    name: "Cleanup Cafe Retry",
    category: "food",
    subdomain: "cleanup-cafe-retry",
  });
  assert.equal(retry.status, 201);
  assert.equal(await Business.countDocuments(), 1);
  assert.equal(await Membership.countDocuments(), 1);
  assert.equal(await Subscription.countDocuments(), 1);
});

// -------------------------------------------------------
// Uniqueness handling (slug/subdomain disambiguation)
// -------------------------------------------------------

test("an existing subdomain is disambiguated instead of failing the transaction", async () => {
  await freePlan();
  const first = await createBusinessWithOwner();
  await Business.findByIdAndUpdate(first.business._id, {
    slug: "taken-cafe",
    subdomain: "taken-cafe",
  });

  const user = await createUser();
  const response = await postBusiness(user, {
    name: "Taken Cafe",
    category: "food",
    subdomain: "taken-cafe",
  });
  assert.equal(response.status, 201);

  const created = await Business.findOne({ owner: user._id });
  assert.ok(created);
  assert.equal(created!.slug, "taken-cafe-2");
  assert.equal(created!.subdomain, "taken-cafe-2");

  // The pre-existing business keeps its identifiers.
  const original = await Business.findById(first.business._id);
  assert.equal(original!.slug, "taken-cafe");
  assert.equal(original!.subdomain, "taken-cafe");
});
