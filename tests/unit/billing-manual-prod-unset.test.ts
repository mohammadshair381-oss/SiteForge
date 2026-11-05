import assert from "node:assert/strict";
import test from "node:test";

import { isManualBillingAllowed } from "../../lib/billing";

// In production with ALLOW_MANUAL_BILLING unset, manual billing must fail
// closed. Self-contained config (safe dummies only).

process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV =
  "production";
delete process.env.ALLOW_MANUAL_BILLING;

test("manual billing fails closed in production when ALLOW_MANUAL_BILLING is unset", () => {
  assert.equal(isManualBillingAllowed(), false);
});
