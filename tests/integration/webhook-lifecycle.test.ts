import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler } from "./helpers/auth";
import { createBusinessWithSubscription, signBody, webhookRequest } from "./helpers/webhook";
import { createUser } from "./helpers/fixtures";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/route";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";
import { Business } from "@/models/Business";
import { Plan } from "@/models/Plan";
import { getEntitlements } from "@/lib/billing";

// lib/env.ts caches configuration on its first call with no reset; each test
// FILE runs in its own Node process, so pinning the secret on the module body
// (before the before() hook's first env() call) is deterministic and cannot
// leak into other files. Throwaway value, never a real secret.
const WEBHOOK_SECRET = "integration-test-webhook-secret-0123456789abcdef";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;

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
});

// ---------------------------------------------------------------------------
// Event builders (signed with the real HMAC helper below)
// ---------------------------------------------------------------------------

interface SucceededEventExtra {
  planKey?: string;
  amount?: number;
  currency?: string;
  providerPaymentId?: string;
}

function succeededEvent(
  businessId: string,
  id: string,
  extra: SucceededEventExtra = {},
): string {
  return JSON.stringify({
    id,
    type: "payment.succeeded",
    data: { businessId, amount: 2900, currency: "USD", ...extra },
  });
}

function failedEvent(businessId: string, id: string): string {
  return JSON.stringify({
    id,
    type: "payment.failed",
    data: { businessId, amount: 2900, currency: "USD" },
  });
}

function unknownEvent(businessId: string, id: string, type: string): string {
  return JSON.stringify({
    id,
    type,
    data: { businessId, amount: 4900, currency: "USD" },
  });
}

async function deliver(body: string): Promise<Response> {
  return callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createPlan(options: {
  key: string;
  active?: boolean;
  interval?: "month" | "year";
  removeBranding?: boolean;
}) {
  return Plan.create({
    key: options.key,
    name: "Lifecycle Test Plan",
    description: "Plan created by the Phase 4.3 webhook lifecycle tests",
    price: 2900,
    currency: "USD",
    interval: options.interval ?? "month",
    features: {
      productLimit: 10,
      staffLimit: 2,
      customDomain: false,
      removeBranding: options.removeBranding ?? false,
    },
    active: options.active ?? true,
  });
}

/** Creates a valid business that deliberately has NO Subscription document. */
async function createBusinessWithoutSubscription() {
  const suffix = uniqueKey("lifecycle");
  const user = await createUser({ email: `${suffix}@example.com` });
  const business = await Business.create({
    name: "Lifecycle Test Business",
    slug: suffix,
    subdomain: suffix,
    category: "services",
    owner: user._id,
  });
  return { user, business };
}

// ---------------------------------------------------------------------------
// 1. payment.succeeded
// ---------------------------------------------------------------------------

test("payment.succeeded activates the subscription and persists a linked, succeeded Payment", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_succeeded");

  const res = await deliver(body);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, true);
  assert.equal(json.duplicate, undefined);

  // Payment persisted with the expected shape.
  const payment = await Payment.findOne({ providerEventId: "evt_lifecycle_succeeded" });
  assert.ok(payment, "an accepted payment.succeeded event must persist a Payment");
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.business.toString(), business._id.toString());
  assert.equal(payment.amount, 2900);
  assert.equal(payment.currency, "USD");
  assert.equal(payment.provider, "manual");
  assert.equal(payment.description, "payment.succeeded");
  assert.equal(payment.providerPaymentId, "");
  assert.ok(payment.paidAt instanceof Date, "a succeeded payment records paidAt");

  // Payment -> Subscription linkage points at the business's subscription.
  assert.ok(payment.subscription, "Payment.subscription must be set");
  assert.equal(payment.subscription.toString(), subscription._id.toString());

  // Subscription activated.
  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated, "subscription should still exist");
  assert.equal(updated.status, "active");
  assert.equal(updated.provider, "manual");
  assert.ok(updated.currentPeriodStart instanceof Date);
  assert.ok(updated.currentPeriodEnd instanceof Date);
});

test("payment.succeeded sets the period end exactly one month after the period start for a monthly plan", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_period");

  const res = await deliver(body);
  assert.equal(res.status, 200);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.ok(updated.currentPeriodEnd);
  // The webhook sets periodEnd = now + 1 month for monthly plans.
  // Verify the period end is exactly one calendar month after period start.
  const expectedEnd = new Date(updated.currentPeriodStart!);
  expectedEnd.setMonth(expectedEnd.getMonth() + 1);
  assert.equal(
    updated.currentPeriodEnd!.getTime(),
    expectedEnd.getTime(),
    "monthly plan period end must be one calendar month after start",
  );
});

test("payment.succeeded sets the period end exactly one year after the period start for a yearly plan", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const yearly = await createPlan({ key: uniqueKey("lifecycle-yearly"), interval: "year" });
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_yearly", {
    planKey: yearly.key,
  });

  const res = await deliver(body);
  assert.equal(res.status, 200);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.ok(updated.currentPeriodEnd);
  // A yearly plan must receive approximately one calendar year of entitlement,
  // not one month. Use setFullYear to match the webhook logic.
  const expectedEnd = new Date(updated.currentPeriodStart!);
  expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
  assert.equal(
    updated.currentPeriodEnd!.getTime(),
    expectedEnd.getTime(),
    "yearly plan period end must be one calendar year after start",
  );
});

// ---------------------------------------------------------------------------
// 2. payment.failed
// ---------------------------------------------------------------------------

test("payment.failed records a failed Payment and marks the subscription past_due", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = failedEvent(business._id.toString(), "evt_lifecycle_failed");

  const res = await deliver(body);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, true);
  assert.equal(json.duplicate, undefined);

  const payment = await Payment.findOne({ providerEventId: "evt_lifecycle_failed" });
  assert.ok(payment, "a payment.failed event must persist a Payment");
  assert.equal(payment.status, "failed");
  assert.equal(payment.description, "payment.failed");
  assert.equal(payment.paidAt, null);

  // Payment -> Subscription linkage.
  assert.ok(payment.subscription, "Payment.subscription must be set");
  assert.equal(payment.subscription.toString(), subscription._id.toString());

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.equal(updated.status, "past_due");
});

// ---------------------------------------------------------------------------
// 3. Plan handling
// ---------------------------------------------------------------------------

test("a valid planKey applies that plan to the subscription", async () => {
  const { business, subscription, plan } = await createBusinessWithSubscription();
  const otherPlan = await createPlan({ key: uniqueKey("lifecycle-valid") });
  assert.notEqual(otherPlan._id.toString(), plan._id.toString());

  const body = succeededEvent(business._id.toString(), "evt_lifecycle_plan_valid", {
    planKey: otherPlan.key,
  });
  const res = await deliver(body);
  assert.equal(res.status, 200);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.equal(updated.status, "active");
  assert.equal(updated.plan.toString(), otherPlan._id.toString(), "the valid planKey is applied");
});

test("an unknown planKey is rejected and grants no entitlement (H3)", async () => {
  const { business, subscription, plan } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_plan_unknown", {
    planKey: "no-such-plan-key-exists",
  });

  const res = await deliver(body);
  assert.equal(res.status, 422, "an unknown planKey must be rejected");
  assert.equal((await res.json()).code, "invalid_plan");

  // Nothing is recorded and the subscription is left untouched.
  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_lifecycle_plan_unknown" }),
    0,
    "a rejected event must not record a Payment",
  );
  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.equal(
    updated.status,
    "incomplete",
    "an unknown planKey must not activate the subscription",
  );
  assert.equal(updated.plan.toString(), plan._id.toString(), "the plan is unchanged");
  assert.equal(updated.currentPeriodStart, null);
  assert.equal(updated.currentPeriodEnd, null);
});

test("an inactive plan with a matching key is rejected and not applied (H3)", async () => {
  const { business, subscription, plan } = await createBusinessWithSubscription();
  const inactive = await createPlan({ key: uniqueKey("lifecycle-inactive"), active: false });
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_plan_inactive", {
    planKey: inactive.key,
  });

  const res = await deliver(body);
  assert.equal(res.status, 422, "an inactive plan must not be applied");
  assert.equal((await res.json()).code, "invalid_plan");

  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_lifecycle_plan_inactive" }),
    0,
  );
  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.equal(updated.status, "incomplete");
  assert.equal(
    updated.plan.toString(),
    plan._id.toString(),
    "an inactive plan must not be applied (only active plans are selected)",
  );
});

// ---------------------------------------------------------------------------
// 4. Unknown event types
// ---------------------------------------------------------------------------

test("an unknown event type is acknowledged without recording a Payment or changing the subscription", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = unknownEvent(business._id.toString(), "evt_lifecycle_unknown", "invoice.paid");

  const res = await deliver(body);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, true);
  assert.equal(json.ignored, true);

  // Unknown types have no billing meaning: recording them as "failed" payments
  // showed false failures in the owner's payment history.
  assert.equal(await Payment.countDocuments({ providerEventId: "evt_lifecycle_unknown" }), 0);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.equal(updated.status, "incomplete");
  assert.equal(updated.currentPeriodStart, null);
  assert.equal(updated.currentPeriodEnd, null);
});

test("an unknown event type still requires a valid signature", async () => {
  const { business } = await createBusinessWithSubscription();
  const body = unknownEvent(business._id.toString(), "evt_lifecycle_unknown_unsigned", "invoice.paid");
  const res = (await callHandler(webhookPOST, webhookRequest(body, "0".repeat(64)))) as Response;
  assert.equal(res.status, 401);
});

test("payment.failed is recorded but does not suspend a free-plan subscription", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  await Plan.updateOne({ _id: subscription.plan }, { $set: { price: 0 } });
  await Subscription.updateOne({ _id: subscription._id }, { $set: { status: "active" } });

  const res = await deliver(failedEvent(business._id.toString(), "evt_lifecycle_failed_free"));
  assert.equal(res.status, 200);
  assert.ok(await Payment.findOne({ providerEventId: "evt_lifecycle_failed_free", status: "failed" }));
  assert.equal((await Subscription.findById(subscription._id))?.status, "active");
});

// ---------------------------------------------------------------------------
// 5. No existing subscription
// ---------------------------------------------------------------------------

test("a payment.succeeded for a business with no subscription is rejected (H2)", async () => {
  const { business } = await createBusinessWithoutSubscription();
  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);

  const body = succeededEvent(business._id.toString(), "evt_lifecycle_no_subscription");
  const res = await deliver(body);
  assert.equal(res.status, 409, "a successful payment with no subscription must be rejected");
  assert.equal((await res.json()).code, "subscription_missing");

  // The webhook must neither record the event nor implicitly create a
  // subscription with arbitrary defaults.
  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_lifecycle_no_subscription" }),
    0,
    "a rejected event must not record a Payment",
  );
  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);
});

// ---------------------------------------------------------------------------
// 6. Payment / subscription consistency
// ---------------------------------------------------------------------------

test("a failed subscription write during payment.failed rolls back the Payment", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = failedEvent(business._id.toString(), "evt_lifecycle_failed_rollback");

  // Force the subscription save() inside the transaction to fail real schema
  // validation by unsetting a required field directly in the database. No mocks.
  await Subscription.collection.updateOne({ _id: subscription._id }, { $unset: { plan: "" } });

  const res = await deliver(body);
  assert.equal(res.status, 500, "a non-duplicate write failure must surface as a server error");
  const json = await res.json();
  assert.equal(json.code, "internal_error");

  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_lifecycle_failed_rollback" }),
    0,
    "the aborted transaction must not leave a Payment behind",
  );
  const after = await Subscription.findById(subscription._id);
  assert.ok(after);
  assert.equal(after.status, "incomplete", "the aborted transaction must not mutate the subscription");
  assert.equal(after.currentPeriodEnd, null);

  // Restore the required field. The event was never recorded, so the provider's
  // redelivery is processed normally and the linkage is established.
  await Subscription.collection.updateOne(
    { _id: subscription._id },
    { $set: { plan: subscription.plan } },
  );
  const retry = await deliver(body);
  assert.equal(retry.status, 200);
  const retryJson = await retry.json();
  assert.equal(retryJson.received, true);
  assert.equal(retryJson.duplicate, undefined);

  const payment = await Payment.findOne({ providerEventId: "evt_lifecycle_failed_rollback" });
  assert.ok(payment);
  assert.equal(payment.status, "failed");
  assert.ok(payment.subscription);
  assert.equal(payment.subscription.toString(), subscription._id.toString());
  const finalSub = await Subscription.findById(subscription._id);
  assert.ok(finalSub);
  assert.equal(finalSub.status, "past_due");
});

// ---------------------------------------------------------------------------
// 7. Duplicate delivery / idempotency
// ---------------------------------------------------------------------------

test("duplicate delivery of the same valid event is acknowledged once (H2/H3 regression)", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_duplicate");

  const first = await deliver(body);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, undefined);

  const subAfterFirst = await Subscription.findById(subscription._id);
  assert.ok(subAfterFirst, "subscription should exist");
  const firstPeriodStart = subAfterFirst.currentPeriodStart;
  const firstPeriodEnd = subAfterFirst.currentPeriodEnd;

  const second = await deliver(body);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);

  // Exactly one Payment; the subscription is byte-for-byte unchanged.
  assert.equal(await Payment.countDocuments({ providerEventId: "evt_lifecycle_duplicate" }), 1);
  const subAfterSecond = await Subscription.findById(subscription._id);
  assert.ok(subAfterSecond, "subscription should still exist");
  assert.equal(subAfterSecond.status, "active");
  assert.equal(subAfterSecond.currentPeriodStart?.getTime(), firstPeriodStart?.getTime(), "duplicate delivery must not move the period start");
  assert.equal(subAfterSecond.currentPeriodEnd?.getTime(), firstPeriodEnd?.getTime(), "duplicate delivery must not move the period end");
});

test("concurrent duplicate deliveries of a valid event yield one Payment and one winner", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_concurrent");

  const responses = await Promise.all([deliver(body), deliver(body), deliver(body), deliver(body)]);
  for (const res of responses) {
    assert.equal(res.status, 200);
  }
  const bodies = await Promise.all(responses.map((res) => res.json()));
  const winners = bodies.filter((entry) => entry.duplicate === undefined);
  const duplicates = bodies.filter((entry) => entry.duplicate === true);

  assert.equal(winners.length, 1, "exactly one delivery should win");
  assert.equal(duplicates.length, responses.length - 1, "every other delivery should report duplicate");

  assert.equal(await Payment.countDocuments({ providerEventId: "evt_lifecycle_concurrent" }), 1);
  assert.equal((await Subscription.findById(subscription._id))?.status, "active");
});

test("a duplicate delivery that bypasses the fast path is rejected by the unique index without re-applying changes", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_dup_e11000");

  // Deterministically model the concurrency window: bypass the initial
  // `Payment.exists` pre-check so the handler always reaches the transactional
  // insert, where the unique index on providerEventId decides. The stub
  // delegates to the real query with a filter that never matches, so it
  // resolves to null (a `Query`, matching the model method type) with no
  // sleeps or casts.
  const originalExists = Payment.exists;
  Payment.exists = () => originalExists.call(Payment, { providerEventId: "___idempotency_bypass___" });
  try {
    const first = await deliver(body);
    const firstJson = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstJson.received, true);
    assert.equal(firstJson.duplicate, undefined);
    assert.equal(await Payment.countDocuments({ providerEventId: "evt_dup_e11000" }), 1);

    // Put the subscription into a distinctive state so a repeated mutation is
    // observable through the public API without any timing comparison.
    await Subscription.updateOne(
      { _id: subscription._id },
      { $set: { status: "past_due", currentPeriodStart: null, currentPeriodEnd: null } },
    );

    // Second delivery: the pre-check is still bypassed, so it opens a
    // transaction and must be caught by the unique index.
    const second = await deliver(body);
    const secondJson = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondJson.received, true);
    assert.equal(secondJson.duplicate, true, "the losing insert must surface as a duplicate");

    // Exactly one Payment: the unique index rejected the second insert.
    assert.equal(await Payment.countDocuments({ providerEventId: "evt_dup_e11000" }), 1);

    // The losing delivery must abort its transaction without persisting any
    // subscription change, so the distinctive state set above survives. This is
    // deterministic (no time comparison) because the test set a known value.
    const sub = await Subscription.findById(subscription._id);
    assert.ok(sub);
    assert.equal(sub.status, "past_due", "a duplicate delivery must not re-apply the mutation");
    assert.equal(sub.currentPeriodStart, null, "a duplicate delivery must not set the period start");
    assert.equal(sub.currentPeriodEnd, null, "a duplicate delivery must not set the period end");
  } finally {
    Payment.exists = originalExists;
  }
});

test("concurrent payment.failed events yield exactly one Payment and a single winner", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = failedEvent(business._id.toString(), "evt_failed_concurrent");

  const responses = await Promise.all([deliver(body), deliver(body), deliver(body), deliver(body)]);
  for (const res of responses) {
    assert.equal(res.status, 200);
  }
  const bodies = await Promise.all(responses.map((res) => res.json()));
  const winners = bodies.filter((entry) => entry.duplicate === undefined);
  const duplicates = bodies.filter((entry) => entry.duplicate === true);
  assert.equal(winners.length, 1, "exactly one failed delivery should win");
  assert.equal(duplicates.length, responses.length - 1, "every other delivery should report duplicate");

  // Exactly one Payment is recorded, and it links back to the subscription.
  const payments = await Payment.find({ providerEventId: "evt_failed_concurrent" });
  assert.equal(payments.length, 1);
  assert.equal(payments[0].status, "failed");
  assert.equal(String(payments[0].subscription), subscription._id.toString());

  // The winning transaction's mutation is the only one that can have committed.
  const sub = await Subscription.findById(subscription._id);
  assert.ok(sub);
  assert.equal(sub.status, "past_due");
});

// ---------------------------------------------------------------------------
// 8. Month-end / leap-year boundary
// ---------------------------------------------------------------------------
// The webhook always sets currentPeriodStart = now (the delivery date) and
// periodEnd = now + 1 month/year. It does not preserve the original period
// start across deliveries. These tests verify the new period end is correctly
// computed from the (overwritten) period start.

test("monthly plan: period end is one calendar month after period start", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_monthly_check");

  const res = await deliver(body);
  assert.equal(res.status, 200);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.ok(updated.currentPeriodEnd);
  // Verify period end is exactly one calendar month after the (new) period start.
  const expectedEnd = new Date(updated.currentPeriodStart!);
  expectedEnd.setMonth(expectedEnd.getMonth() + 1);
  assert.equal(
    updated.currentPeriodEnd!.getTime(),
    expectedEnd.getTime(),
    "monthly plan: period end must be one calendar month after period start",
  );
});

test("yearly plan: period end is one calendar year after period start", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const yearly = await createPlan({ key: uniqueKey("lifecycle-yearly2"), interval: "year" });
  const body = succeededEvent(business._id.toString(), "evt_lifecycle_yearly_check", {
    planKey: yearly.key,
  });

  const res = await deliver(body);
  assert.equal(res.status, 200);

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated);
  assert.ok(updated.currentPeriodEnd);
  // Verify period end is exactly one calendar year after the (new) period start.
  const expectedEnd = new Date(updated.currentPeriodStart!);
  expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
  assert.equal(
    updated.currentPeriodEnd!.getTime(),
    expectedEnd.getTime(),
    "yearly plan: period end must be one calendar year after period start",
  );
});

// ---------------------------------------------------------------------------
// 9. Branding / removeBranding entitlement
// ---------------------------------------------------------------------------

test("removeBranding appears in entitlements from the Plan features", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const plan = await createPlan({ key: uniqueKey("lifecycle-branding"), removeBranding: true });
  // Set the subscription's plan to the new plan with removeBranding: true
  await Subscription.findOneAndUpdate({ business: business._id }, { plan: plan._id });
  const entitlements = await getEntitlements(business._id.toString());
  assert.ok(entitlements.removeBranding, "removeBranding from plan features should appear in entitlements");
});