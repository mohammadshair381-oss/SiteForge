import assert from "node:assert/strict";
import test from "node:test";

import { isManualBillingAllowed, NO_PLAN_ENTITLEMENTS } from "../../backend/lib/billing";

// Outside production manual billing is always permitted, regardless of the
// ALLOW_MANUAL_BILLING flag. Self-contained config (safe dummies only).

process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "a".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "test";
process.env.ALLOW_MANUAL_BILLING = "false";

test("manual billing is allowed outside production even when the flag is false", () => {
  assert.equal(isManualBillingAllowed(), true);
});

test("NO_PLAN_ENTITLEMENTS exposes the baseline limits and flags", () => {
  assert.deepEqual(NO_PLAN_ENTITLEMENTS, {
    planKey: null,
    planName: "No plan",
    status: "incomplete",
    active: false,
    expired: false,
    productLimit: 0,
    staffLimit: 1,
    customDomain: false,
    removeBranding: false,
    // No plan, no AI suggestions.
    aiRequestsPerMonth: 0,
    // No plan: only the Free themes can be selected (the current one is kept).
    themes: ["bistro", "market", "studio"],
    // Optional plan limits: null means no limit (docs/platform-management.md, "Absent means").
    pageLimit: null,
    storageBytes: null,
    monthlyOrderLimit: null,
  });
});
