import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler } from "./helpers/auth";
import { signBody, webhookRequest } from "./helpers/webhook";
import {
  createBusinessWithOwner,
  createPlan,
  createSubscription,
  tenantSuffix,
} from "./helpers/tenant";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/route";
import { getEntitlements } from "@/lib/billing";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";
import type { SubscriptionStatus } from "@/lib/constants";

/**
 * Phase 4.7 — payment webhook billing integrity (H2 + H3).
 *
 * H2: a `payment.succeeded` event with no subscription must not be recorded as
 *     successfully applied and must not fabricate a subscription.
 * H3: a `payment.succeeded` event must not activate a plan unless the payment's
 *     amount and currency match the intended plan.
 */

// lib/env.ts caches configuration on its first call with no reset; each test
// FILE runs in its own Node process, so pinning the secret on the module body
// (before the before() hook's first env() call) is deterministic. Throwaway
// value, never a real secret.
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
// Event builders. `JSON.stringify` drops `undefined` properties, so omitting a
// field here models a payload that genuinely lacks it.
// ---------------------------------------------------------------------------

interface SucceededData {
  businessId: string;
  planKey?: string;
  amount?: number;
  currency?: string;
}

function succeededBody(id: string, data: SucceededData): string {
  return JSON.stringify({ id, type: "payment.succeeded", data });
}

function failedBody(id: string, data: { businessId: string; amount?: number; currency?: string }): string {
  return JSON.stringify({ id, type: "payment.failed", data });
}

async function deliver(body: string): Promise<Response> {
  return callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SetupOptions {
  planPrice?: number;
  planActive?: boolean;
  withSubscription?: boolean;
  subscriptionStatus?: SubscriptionStatus;
}

async function setup(options: SetupOptions = {}) {
  const { business, owner } = await createBusinessWithOwner();
  const plan = await createPlan({
    price: options.planPrice ?? 2900,
    interval: "month",
    active: options.planActive ?? true,
  });
  const subscription =
    options.withSubscription === false
      ? null
      : await createSubscription(business._id, plan._id, {
          status: options.subscriptionStatus ?? "incomplete",
        });
  return { business, owner, plan, subscription };
}

async function paymentsFor(businessId: unknown): Promise<number> {
  return Payment.countDocuments({ business: businessId });
}

// ============================================================
// 1. A valid payment with the expected amount and currency
// ============================================================

test("a valid payment matching the subscription plan's amount and currency is applied", async () => {
  const { business, plan, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_valid", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, true);
  assert.equal(json.duplicate, undefined);

  const payment = await Payment.findOne({ providerEventId: "evt_integrity_valid" });
  assert.ok(payment, "a verified payment must be recorded");
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.amount, 2900);
  assert.equal(payment.currency, "USD");
  assert.equal(payment.business.toString(), business._id.toString());
  assert.equal(String(payment.subscription), subscription!._id.toString());
  assert.ok(payment.paidAt instanceof Date);

  const sub = await Subscription.findById(subscription!._id);
  assert.ok(sub);
  assert.equal(sub.status, "active");
  assert.equal(sub.plan.toString(), plan._id.toString());
  assert.ok(sub.currentPeriodStart instanceof Date);
  assert.ok(sub.currentPeriodEnd instanceof Date);

  const entitlements = await getEntitlements(business._id.toString());
  assert.equal(entitlements.active, true);
  assert.equal(entitlements.planKey, plan.key);
});

test("a valid payment with an explicit planKey applies that plan when the amount matches", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const otherPlan = await createPlan({ price: 4900, interval: "month" });
  const body = succeededBody("evt_integrity_plan_key", {
    businessId: business._id.toString(),
    planKey: otherPlan.key,
    amount: 4900,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 200);

  const sub = await Subscription.findById(subscription!._id);
  assert.ok(sub);
  assert.equal(sub.status, "active");
  assert.equal(sub.plan.toString(), otherPlan._id.toString(), "the explicit plan is applied");
});

// ============================================================
// 2. Amount mismatch
// ============================================================

test("an amount mismatch is rejected and grants no entitlement (H3)", async () => {
  const { business, plan, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_amount_mismatch", {
    businessId: business._id.toString(),
    amount: 1,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "amount_mismatch");

  assert.equal(await paymentsFor(business._id), 0, "no Payment may be recorded");
  const sub = await Subscription.findById(subscription!._id);
  assert.ok(sub);
  assert.equal(sub.status, "incomplete", "the subscription must not be activated");
  assert.equal(sub.plan.toString(), plan._id.toString());
  assert.equal(
    sub.currentPeriodStart?.getTime(),
    subscription!.currentPeriodStart?.getTime(),
    "the period start must not move",
  );
  assert.equal(sub.currentPeriodEnd, null);

  const entitlements = await getEntitlements(business._id.toString());
  assert.equal(entitlements.active, false, "no paid entitlement may be granted");
});

// ============================================================
// 3. Currency mismatch
// ============================================================

test("a currency mismatch is rejected and grants no entitlement (H3)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_currency_mismatch", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "EUR",
  });

  const res = await deliver(body);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "currency_mismatch");

  assert.equal(await paymentsFor(business._id), 0);
  const sub = await Subscription.findById(subscription!._id);
  assert.ok(sub);
  assert.equal(sub.status, "incomplete");
  assert.equal(
    sub.currentPeriodStart?.getTime(),
    subscription!.currentPeriodStart?.getTime(),
    "the period start must not move",
  );

  const entitlements = await getEntitlements(business._id.toString());
  assert.equal(entitlements.active, false);
});

// ============================================================
// 4. Missing amount / currency
// ============================================================

test("a succeeded event missing its amount is rejected (H3)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_no_amount", {
    businessId: business._id.toString(),
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "amount_required");

  assert.equal(await paymentsFor(business._id), 0);
  assert.equal((await Subscription.findById(subscription!._id))?.status, "incomplete");
});

test("a succeeded event missing its currency is rejected (H3)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_no_currency", {
    businessId: business._id.toString(),
    amount: 2900,
  });

  const res = await deliver(body);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "currency_required");

  assert.equal(await paymentsFor(business._id), 0);
  assert.equal((await Subscription.findById(subscription!._id))?.status, "incomplete");
});

// ============================================================
// 5. Unknown or inactive plan
// ============================================================

test("an unknown planKey is rejected and grants no entitlement (H3)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_plan_unknown", {
    businessId: business._id.toString(),
    planKey: `missing-${tenantSuffix()}`,
    amount: 2900,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "invalid_plan");

  assert.equal(await paymentsFor(business._id), 0);
  const sub = await Subscription.findById(subscription!._id);
  assert.ok(sub);
  assert.equal(sub.status, "incomplete");
  const entitlements = await getEntitlements(business._id.toString());
  assert.equal(entitlements.active, false);
});

test("an inactive plan with a matching key is rejected and grants no entitlement (H3)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const inactive = await createPlan({ price: 2900, active: false });
  const body = succeededBody("evt_integrity_plan_inactive", {
    businessId: business._id.toString(),
    planKey: inactive.key,
    amount: 2900,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "invalid_plan");

  assert.equal(await paymentsFor(business._id), 0);
  assert.equal((await Subscription.findById(subscription!._id))?.status, "incomplete");
});

// ============================================================
// 6. Successful payment with no subscription (H2)
// ============================================================

test("a payment.succeeded with no subscription is rejected without fabricating one (H2)", async () => {
  const { business } = await setup({ withSubscription: false });
  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);

  const body = succeededBody("evt_integrity_no_subscription", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "USD",
  });

  const res = await deliver(body);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "subscription_missing");

  // Nothing recorded, nothing granted, and no subscription invented.
  assert.equal(await paymentsFor(business._id), 0);
  assert.equal(await Subscription.countDocuments({ business: business._id }), 0);
  const entitlements = await getEntitlements(business._id.toString());
  assert.equal(entitlements.active, false);
});

// ============================================================
// 7. Duplicate delivery of a valid event
// ============================================================

test("duplicate delivery of the same valid event is acknowledged once (H2/H3 regression)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_duplicate", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "USD",
  });

  const first = await deliver(body);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).duplicate, undefined);

  const subAfterFirst = await Subscription.findById(subscription!._id);
  assert.ok(subAfterFirst);
  const endAfterFirst = subAfterFirst.currentPeriodEnd;

  const second = await deliver(body);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).duplicate, true);

  assert.equal(await Payment.countDocuments({ providerEventId: "evt_integrity_duplicate" }), 1);
  const subAfterSecond = await Subscription.findById(subscription!._id);
  assert.ok(subAfterSecond);
  assert.equal(subAfterSecond.currentPeriodEnd?.getTime(), endAfterFirst?.getTime());
});

// ============================================================
// 8. Concurrent duplicate deliveries
// ============================================================

test("concurrent duplicate deliveries of a valid event yield one Payment and one winner", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = succeededBody("evt_integrity_concurrent", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "USD",
  });

  const responses = await Promise.all([deliver(body), deliver(body), deliver(body), deliver(body)]);
  for (const res of responses) {
    assert.equal(res.status, 200);
  }
  const bodies = await Promise.all(responses.map((res) => res.json()));
  const winners = bodies.filter((entry) => entry.duplicate === undefined);
  const duplicates = bodies.filter((entry) => entry.duplicate === true);

  assert.equal(winners.length, 1, "exactly one delivery wins");
  assert.equal(duplicates.length, responses.length - 1, "the rest are duplicates");
  assert.equal(await Payment.countDocuments({ providerEventId: "evt_integrity_concurrent" }), 1);
  assert.equal((await Subscription.findById(subscription!._id))?.status, "active");
});

// ============================================================
// 9 + 10. Subscription update failure, rollback, and redelivery
// ============================================================

test("a subscription update failure rolls back the Payment and a redelivery succeeds (transactional integrity)", async () => {
  const { business, subscription } = await setup({ planPrice: 2900 });
  const body = failedBody("evt_integrity_rollback", {
    businessId: business._id.toString(),
    amount: 2900,
    currency: "USD",
  });

  // Force a genuine, deterministic subscription write failure inside the
  // transaction by unsetting the required `plan` ref directly in the database.
  // (The succeeded path now verifies the plan before writing, so this exact
  // trigger is only reachable on the payment.failed branch; the transaction
  // ordering — insert the Payment, then save the subscription — is identical.)
  await Subscription.collection.updateOne({ _id: subscription!._id }, { $unset: { plan: "" } });

  const res = await deliver(body);
  assert.equal(res.status, 500, "a non-duplicate write failure surfaces as a server error");
  assert.equal((await res.json()).code, "internal_error");

  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_integrity_rollback" }),
    0,
    "the aborted transaction must not leave a Payment behind",
  );
  const after = await Subscription.findById(subscription!._id);
  assert.ok(after);
  assert.equal(after.status, "incomplete", "the aborted transaction must not mutate the subscription");

  // Redelivery after repairing the data is processed normally (the event was
  // never recorded, so it is not a duplicate).
  await Subscription.collection.updateOne(
    { _id: subscription!._id },
    { $set: { plan: subscription!.plan } },
  );
  const retry = await deliver(body);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, undefined);

  const payment = await Payment.findOne({ providerEventId: "evt_integrity_rollback" });
  assert.ok(payment);
  assert.equal(payment.status, "failed");
  assert.equal(String(payment.subscription), subscription!._id.toString());
  assert.equal((await Subscription.findById(subscription!._id))?.status, "past_due");
});

// ============================================================
// Regression: valid existing subscription associations are preserved
// ============================================================

test("a valid event keeps the payment linked to the correct tenant's subscription", async () => {
  const first = await setup({ planPrice: 2900 });
  const second = await setup({ planPrice: 2900 });

  const body = succeededBody("evt_integrity_isolation", {
    businessId: first.business._id.toString(),
    amount: 2900,
    currency: "USD",
  });
  const res = await deliver(body);
  assert.equal(res.status, 200);

  const payment = await Payment.findOne({ providerEventId: "evt_integrity_isolation" });
  assert.ok(payment);
  assert.equal(payment.business.toString(), first.business._id.toString());
  assert.equal(String(payment.subscription), first.subscription!._id.toString());

  // The other tenant is completely untouched.
  assert.equal(await paymentsFor(second.business._id), 0);
  assert.equal((await Subscription.findById(second.subscription!._id))?.status, "incomplete");
});
