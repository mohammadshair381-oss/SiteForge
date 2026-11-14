import assert from "node:assert/strict";
import test from "node:test";

import { isManualBillingAllowed } from "../../backend/lib/billing";

// In production, manual billing is only enabled when ALLOW_MANUAL_BILLING is
// explicitly truthy. Self-contained config (safe dummies only).

process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV =
  "production";
process.env.ALLOW_MANUAL_BILLING = "true";

test("manual billing is enabled in production when ALLOW_MANUAL_BILLING is true", () => {
  assert.equal(isManualBillingAllowed(), true);
});
