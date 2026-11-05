import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler } from "./helpers/auth";
import { createBusinessWithSubscription, signBody, webhookRequest } from "./helpers/webhook";
import { POST as webhookPOST } from "@/app/api/webhooks/payments/route";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";

// This file deliberately exercises the "webhook secret is not configured" branch,
// so PAYMENT_WEBHOOK_SECRET must be unset. lib/env.ts caches configuration
// process-wide on its first call with no reset, but each test FILE runs in its
// own Node process, so this empty configuration cannot affect the signature
// tests in webhook-signature.test.ts (which run in a separate process).
// Clearing it here keeps the branch deterministic regardless of the developer's
// shell environment. This runs on the module body, before the before() hook
// triggers env()'s first (caching) call.
delete process.env.PAYMENT_WEBHOOK_SECRET;

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

test("missing or empty PAYMENT_WEBHOOK_SECRET returns the documented configuration error", async () => {
  const { business, subscription } = await createBusinessWithSubscription();
  const body = JSON.stringify({
    id: "evt_not_configured",
    type: "payment.succeeded",
    data: { businessId: business._id.toString() },
  });

  // Even a well-formed signature must be rejected: configuration is checked
  // before signature verification in the route handler.
  const res = await callHandler(webhookPOST, webhookRequest(body, signBody(body, "some-secret")));

  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, "not_configured");
  assert.match(json.error, /not configured/i);

  // A rejected configuration request must not create Payment records or mutate
  // the subscription.
  assert.equal(await Payment.countDocuments({}), 0);
  const unchanged = await Subscription.findById(subscription._id);
  assert.equal(unchanged?.status, "incomplete");
  assert.equal(unchanged?.currentPeriodStart, null);
  assert.equal(unchanged?.currentPeriodEnd, null);
});
