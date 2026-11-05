import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler } from "./helpers/auth";
import { createBusinessWithSubscription, signBody, webhookRequest } from "./helpers/webhook";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/route";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

// lib/env.ts caches parsed configuration on its first call and exposes no reset.
// Each test FILE runs in its own Node process, and none of the imports above
// call env() at module-evaluation time, so pinning the secret on the module body
// (before the before() hook's first dbConnect -> env() call) is deterministic
// and does not leak into other test files. Throwaway value, never a real secret.
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

function succeededEvent(businessId: string, id: string): string {
  return JSON.stringify({
    id,
    type: "payment.succeeded",
    data: { businessId, amount: 2900, currency: "USD" },
  });
}

// ============================================================
// A. Signature verification
// ============================================================

test("a valid HMAC-SHA256 signature is accepted and applies the event", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_valid_signature");

  const res = await callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.received, true);
  assert.equal(json.duplicate, undefined);

  const payment = await Payment.findOne({ providerEventId: "evt_valid_signature" });
  assert.ok(payment, "an accepted event must create a Payment record");
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.business.toString(), business._id.toString());

  const updated = await Subscription.findById(subscription._id);
  assert.ok(updated, "subscription should still exist");
  assert.equal(updated.status, "active", "payment.succeeded should activate the subscription");
  assert.ok(updated.currentPeriodStart, "period start should be recorded");
  assert.ok(updated.currentPeriodEnd, "period end should be recorded");
});

test("a missing signature is rejected", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_missing_signature");

  const res = await callHandler(webhookPOST, webhookRequest(body, null));

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "invalid_signature");

  assert.equal(await Payment.countDocuments({}), 0, "no Payment should be recorded");
  const unchanged = await Subscription.findById(subscription._id);
  assert.equal(unchanged?.status, "incomplete", "rejected request must not mutate the subscription");
  assert.equal(unchanged?.currentPeriodStart, null);
  assert.equal(unchanged?.currentPeriodEnd, null);
});

test("an incorrect signature is rejected", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_incorrect_signature");

  // Correct length (64 hex chars) but derived from a different secret.
  const wrongSignature = signBody(body, "a-completely-different-secret-value");
  const res = await callHandler(webhookPOST, webhookRequest(body, wrongSignature));

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "invalid_signature");

  assert.equal(await Payment.countDocuments({}), 0);
  assert.equal((await Subscription.findById(subscription._id))?.status, "incomplete");
});

test("a signature with the wrong length is rejected", async () => {
  const { business } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_wrong_length");

  const shortSignature = signBody(body, WEBHOOK_SECRET).slice(0, 32);
  const res = await callHandler(webhookPOST, webhookRequest(body, shortSignature));

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "invalid_signature");
  assert.equal(await Payment.countDocuments({}), 0);
});

test("a signature that does not match a tampered request body is rejected", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const signedBody = succeededEvent(business._id.toString(), "evt_tampered_body");
  const signature = signBody(signedBody, WEBHOOK_SECRET);

  const tamperedBody = JSON.stringify({
    id: "evt_tampered_body",
    type: "payment.succeeded",
    data: { businessId: business._id.toString(), amount: 1, currency: "USD" },
  });
  assert.notEqual(tamperedBody, signedBody, "tampered body must differ from the signed body");

  const res = await callHandler(webhookPOST, webhookRequest(tamperedBody, signature));

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "invalid_signature");

  assert.equal(await Payment.countDocuments({}), 0);
  assert.equal((await Subscription.findById(subscription._id))?.status, "incomplete");
});

// ============================================================
// B. Webhook configuration (rejected requests have no side effects)
// ============================================================

test("rejected signature requests create no Payment records and mutate no subscriptions", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = succeededEvent(business._id.toString(), "evt_all_rejected");

  const responses = await Promise.all([
    callHandler(webhookPOST, webhookRequest(body, null)),
    callHandler(webhookPOST, webhookRequest(body, signBody(body, "wrong-secret"))),
    callHandler(webhookPOST, webhookRequest(body, "abc123")),
    callHandler(webhookPOST, webhookRequest(body, signBody("a different body", WEBHOOK_SECRET))),
  ]);

  for (const res of responses) {
    assert.equal(res.status, 401);
  }

  assert.equal(await Payment.countDocuments({}), 0);
  const unchanged = await Subscription.findById(subscription._id);
  assert.equal(unchanged?.status, "incomplete");
  assert.equal(unchanged?.currentPeriodStart, null);
  assert.equal(unchanged?.currentPeriodEnd, null);
});

// ============================================================
// C. Request validation (all reached only with a valid signature)
// ============================================================

test("malformed JSON is rejected with the documented 400 response", async () => {
  const malformed = '{ "id": "evt_bad_json", ';
  const res = await callHandler(webhookPOST, webhookRequest(malformed, signBody(malformed, WEBHOOK_SECRET)));

  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, "bad_request");

  assert.equal(await Payment.countDocuments({}), 0);
});

test("an invalid webhook payload is rejected with the documented validation error", async () => {
  // Missing both `id` and `data`, but correctly signed so validation is reached.
  const body = JSON.stringify({ type: "payment.succeeded" });
  const res = await callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));

  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.code, "validation_error");
  assert.match(json.error, /id/i);

  assert.equal(await Payment.countDocuments({}), 0);
});

test("a malformed businessId is rejected with the documented invalid-ID response", async () => {
  const body = JSON.stringify({
    id: "evt_bad_business_id",
    type: "payment.succeeded",
    data: { businessId: "not-an-object-id" },
  });
  const res = await callHandler(webhookPOST, webhookRequest(body, signBody(body, WEBHOOK_SECRET)));

  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, "invalid_id");

  assert.equal(await Payment.countDocuments({}), 0);
});
