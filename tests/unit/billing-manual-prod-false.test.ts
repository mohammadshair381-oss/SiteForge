import assert from "node:assert/strict";
import test from "node:test";

import { isManualBillingAllowed } from "../../backend/lib/billing";

// In production with ALLOW_MANUAL_BILLING explicitly "false", manual billing
// stays disabled. Self-contained config (safe dummies only).

process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV =
  "production";
process.env.ALLOW_MANUAL_BILLING = "false";

test("manual billing stays disabled in production when ALLOW_MANUAL_BILLING is false", () => {
  assert.equal(isManualBillingAllowed(), false);
});
