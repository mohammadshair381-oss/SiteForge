import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, makeRequest } from "./helpers/auth";
import { POST as forgotRoute } from "@/app/api/auth/password/forgot/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { verifyPassword } from "@/lib/auth/password";
import { User } from "@/models/User";
import { AuthToken } from "@/models/AuthToken";

/** The reset email goes out after the response, so these tests wait for it. */
const forgotPOST: typeof forgotRoute = async (request) => {
  const response = await forgotRoute(request);
  await drainAfterResponseTasks();
  return response;
};

// Force the real Resend transport for this file so we can simulate an outage.
// These are set before startIntegrationSuite(), whose EMAIL_* assignments use
// `??=` and therefore do not override them. The values are obvious dummies.
process.env.EMAIL_PROVIDER = "resend";
process.env.EMAIL_API_KEY = "re_test_key_should_not_leak";
process.env.EMAIL_FROM = "SiteForge <no-reply@example.com>";
process.env.APP_URL = "https://app.example.com";

const originalFetch = globalThis.fetch;

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();

  // Every provider call fails, simulating an outage. No real network request is
  // ever made.
  globalThis.fetch = (async () => {
    throw new Error("simulated provider outage");
  }) as typeof fetch;
});

after(async () => {
  // Always restore the stub, even if a test failed.
  globalThis.fetch = originalFetch;
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
});

const FORGOT_URL = "http://localhost/api/auth/password/forgot";

test("a provider outage never reports delivery and leaks no internal details", async () => {
  const email = `reset-provider-fail-${Date.now()}@example.com`;
  const user = await createUser({ email, password: "old-password" });

  const res = await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email }));
  assert.equal(res.status, 200, "the public response stays generic and successful");
  const body = await res.json();
  assert.deepEqual(body, { success: true });

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("re_test_key_should_not_leak"));
  assert.ok(!serialized.includes("simulated provider outage"));
  assert.ok(!/resend/i.test(serialized));

  // The token that could not be emailed is retired, so no usable link is left
  // behind and the password is untouched.
  assert.equal(
    await AuthToken.countDocuments({ user: user._id, type: "password_reset", usedAt: null }),
    0,
    "an undeliverable reset token must not stay active",
  );

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.equal(await verifyPassword("old-password", reloaded!.passwordHash), true);
});
