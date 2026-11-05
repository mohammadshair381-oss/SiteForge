import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler } from "./helpers/auth";
import { createBusinessWithSubscription, signBody, webhookRequest } from "./helpers/webhook";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/route";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

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

function succeededEvent(businessId: string, id: string, amount = 2900): string {
  return JSON.stringify({
    id,
    type: "payment.succeeded",
    data: { businessId, amount, currency: "USD" },
  });
}

function failedEvent(businessId: string, id: string): string {
  return JSON.stringify({
    id,
    type: "payment.failed",
    data: { businessId, amount: 2900, currency: "USD" },
  });
}

async function deliver(body: string) {
  return callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));
}

// ============================================================
// A. Sequential duplicate delivery
// ============================================================

test("sequential duplicate delivery is acknowledged and does not repeat subscription mutations", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_dup_sequential");

  // First delivery: processed normally.
  const first = await deliver(body);
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.received, true);
  assert.equal(firstJson.duplicate, undefined);

  const afterFirst = await Subscription.findById(subscription._id);
  assert.ok(afterFirst, "subscription should exist");
  assert.equal(afterFirst.status, "active");
  const firstPeriodStart = afterFirst.currentPeriodStart;
  const firstPeriodEnd = afterFirst.currentPeriodEnd;
  assert.ok(firstPeriodStart, "first delivery should set the period start");
  assert.ok(firstPeriodEnd, "first delivery should set the period end");

  // The Payment must link back to the subscription it was applied to.
  const payment = await Payment.findOne({ providerEventId: "evt_dup_sequential" });
  assert.ok(payment, "first delivery should create a Payment");
  assert.equal(
    String(payment.subscription),
    subscription._id.toString(),
    "Payment.subscription should reference the business subscription",
  );

  // Second, identical delivery: acknowledged as a duplicate.
  const second = await deliver(body);
  assert.equal(second.status, 200);
  const secondJson = await second.json();
  assert.equal(secondJson.received, true);
  assert.equal(secondJson.duplicate, true);

  // Exactly one Payment; the subscription is byte-for-byte unchanged.
  assert.equal(await Payment.countDocuments({ providerEventId: "evt_dup_sequential" }), 1);
  const afterSecond = await Subscription.findById(subscription._id);
  assert.ok(afterSecond, "subscription should still exist");
  assert.equal(afterSecond.status, "active");
  assert.equal(
    afterSecond.currentPeriodStart?.getTime(),
    firstPeriodStart.getTime(),
    "duplicate delivery must not move the period start",
  );
  assert.equal(
    afterSecond.currentPeriodEnd?.getTime(),
    firstPeriodEnd.getTime(),
    "duplicate delivery must not move the period end",
  );
});

// ============================================================
// B. Duplicate event id with a conflicting payload
// ============================================================

test("a duplicate event id with an altered payload is treated as a duplicate, preserving the original records", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const businessId = business._id.toString();

  const first = await deliver(succeededEvent(businessId, "evt_dup_conflict", 2900));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).received, true);

  const paymentAfterFirst = await Payment.findOne({ providerEventId: "evt_dup_conflict" });
  assert.ok(paymentAfterFirst);
  assert.equal(paymentAfterFirst.amount, 2900);

  const subAfterFirst = await Subscription.findById(subscription._id);
  assert.ok(subAfterFirst);
  const periodEndAfterFirst = subAfterFirst.currentPeriodEnd;
  assert.ok(periodEndAfterFirst);

  // Same provider event id, deliberately different amount.
  const second = await deliver(succeededEvent(businessId, "evt_dup_conflict", 1));
  assert.equal(second.status, 200);
  const secondJson = await second.json();
  assert.equal(secondJson.received, true);
  assert.equal(secondJson.duplicate, true);

  // The route dedupes purely by event id and does NOT reject the altered body:
  // the stored Payment keeps the first payload and no second row appears.
  assert.equal(await Payment.countDocuments({ providerEventId: "evt_dup_conflict" }), 1);
  const paymentAfterSecond = await Payment.findOne({ providerEventId: "evt_dup_conflict" });
  assert.ok(paymentAfterSecond);
  assert.equal(paymentAfterSecond.amount, 2900, "stored Payment keeps the first payload's amount");

  const subAfterSecond = await Subscription.findById(subscription._id);
  assert.ok(subAfterSecond);
  assert.equal(subAfterSecond.status, "active");
  assert.equal(
    subAfterSecond.currentPeriodEnd?.getTime(),
    periodEndAfterFirst.getTime(),
    "a duplicate delivery must not re-apply the subscription mutation",
  );
});

// ============================================================
// C. Concurrent duplicate delivery
// ============================================================

test("concurrent duplicate deliveries yield exactly one Payment and a single winner", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_dup_concurrent");

  const responses = await Promise.all([
    deliver(body),
    deliver(body),
    deliver(body),
    deliver(body),
    deliver(body),
  ]);

  for (const res of responses) {
    assert.equal(res.status, 200);
  }
  const bodies = await Promise.all(responses.map((res) => res.json()));
  const winners = bodies.filter((body) => body.duplicate === undefined);
  const duplicates = bodies.filter((body) => body.duplicate === true);

  // Whether the loser is caught by the pre-check or by the unique index, the
  // observable outcome is identical: one winner and the rest duplicates.
  assert.equal(winners.length, 1, "exactly one delivery should win");
  assert.equal(duplicates.length, responses.length - 1, "every other delivery should report duplicate");

  assert.equal(await Payment.countDocuments({ providerEventId: "evt_dup_concurrent" }), 1);
  const sub = await Subscription.findById(subscription._id);
  assert.ok(sub);
  assert.equal(sub.status, "active");
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

// ============================================================
// E. Concurrent payment.failed delivery
// ============================================================

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

// ============================================================
// F. A mid-transaction subscription write failure rolls back the Payment
// ============================================================

test("a subscription write failure aborts the transaction and rolls back the Payment insert", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  // Use payment.failed: the succeeded path resolves and verifies the plan before
  // any write (Phase 4.7), so the old "unset the plan" trigger would now be
  // rejected as invalid_plan. payment.failed still inserts a Payment and then
  // saves the subscription, exercising the same insert-then-mutate rollback.
  const body = failedEvent(business._id.toString(), "evt_rollback");

  const before = await Subscription.findById(subscription._id);
  assert.ok(before);
  assert.equal(before.status, "incomplete", "precondition: the subscription starts incomplete");

  // Force the subscription write inside the transaction to fail with a real
  // schema-validation error: unset the required `plan` ref directly in the
  // database (bypassing Mongoose validation on the way in). This exercises a
  // genuine database-level failure without mocking the code under test.
  await Subscription.collection.updateOne({ _id: subscription._id }, { $unset: { plan: "" } });

  const res = await deliver(body);
  assert.equal(res.status, 500, "a non-duplicate write failure must surface as a server error");
  const failureJson = await res.json();
  assert.equal(failureJson.code, "internal_error");

  assert.equal(
    await Payment.countDocuments({ providerEventId: "evt_rollback" }),
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

  const payment = await Payment.findOne({ providerEventId: "evt_rollback" });
  assert.ok(payment);
  assert.equal(payment.status, "failed");
  assert.equal(String(payment.subscription), subscription._id.toString());
  const finalSub = await Subscription.findById(subscription._id);
  assert.ok(finalSub);
  assert.equal(finalSub.status, "past_due");
});
