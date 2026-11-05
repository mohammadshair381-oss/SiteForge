import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
  makeRequest,
} from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { POST as resendPOST } from "@/app/api/auth/email/resend/route";
import { User } from "@/models/User";

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
  resetMockCookieStore();
});

const REGISTER_URL = "http://localhost/api/auth/register";
const RESEND_URL = "http://localhost/api/auth/email/resend";

test("registration still succeeds and stays unverified when the provider fails", async () => {
  const email = `provider-fail-${Date.now()}@example.com`;

  const res = await callHandler(
    registerPOST,
    makeRequest(REGISTER_URL, { name: "Provider Fail", email, password: "password123" }),
  );

  assert.equal(res.status, 202);
  const body = await res.json();
  await drainAfterResponseTasks();

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("re_test_key_should_not_leak"));
  assert.ok(!serialized.includes("simulated provider outage"));
  assert.ok(!/resend/i.test(serialized));

  const user = await User.findOne({ email });
  assert.ok(user);
  assert.equal(user.emailVerifiedAt, null, "a failed send must not mark the account verified");
});

test("resend reports a safe failure without leaking provider details", async () => {
  const user = await createUser();
  await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
  const auth = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const res = await callHandler(
    resendPOST,
    makeAuthenticatedRequest(RESEND_URL, {}, auth),
  );

  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, "email_send_failed");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("re_test_key_should_not_leak"));
  assert.ok(!serialized.includes("simulated provider outage"));

  const fresh = await User.findById(user._id);
  assert.equal(fresh?.emailVerifiedAt, null, "a failed resend must not verify the account");
});
