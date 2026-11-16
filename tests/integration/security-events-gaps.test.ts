import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { call, freshIp, lastToken, register, store } from "./helpers/customer-accounts";
import { GET as meGET } from "@/app/api/auth/me/route";
import { POST as passwordPOST } from "@/app/api/auth/password/route";
import { POST as customerVerifyPOST } from "@/app/api/storefront/account/email/verify/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { getSecuritySummary } from "@/lib/admin/security";
import { clearEmailOutbox } from "@/lib/email";
import { resetRevokedSessionThrottle } from "@/lib/security-events";
import { SecurityEvent } from "@/models/SecurityEvent";
import { User } from "@/models/User";

/**
 * Remaining authentication-event gaps: revoked PLATFORM sessions, email
 * verification refusals (platform and storefront), and wrong current passwords
 * on password change. Responses must not change; nothing sensitive is stored.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  clearRequestCookies();
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  clearRequestCookies();
  await drainAfterResponseTasks();
  clearEmailOutbox();
  resetRevokedSessionThrottle();
  await clearAllCollections();
});

async function me(headers: { cookie: string }) {
  const res = (await callHandler(meGET as never, new Request("http://localhost/api/auth/me", { headers: { ...headers, "x-forwarded-for": freshIp() } }))) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function post(handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) {
  const res = (await callHandler(handler, new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
    body: JSON.stringify(body),
  }))) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("a revoked platform session is recorded once per window with the unchanged 401", async () => {
  const user = await createUser();
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  assert.equal((await me(headers)).status, 200);
  await SecurityEvent.deleteMany({});

  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
  const first = await me(headers);
  assert.equal(first.status, 401);
  assert.equal(first.body.code, "session_revoked", "response unchanged");
  assert.equal((await me(headers)).status, 401);
  await drainAfterResponseTasks();
  const events = await SecurityEvent.find().lean();
  assert.equal(events.length, 1, "throttled per account");
  assert.equal(events[0].type, "platform_session_revoked");
  assert.equal(events[0].reason, "token_version_mismatch");
  assert.equal(String(events[0].user), String(user._id));
  assert.equal(events[0].scope, "platform");

  resetRevokedSessionThrottle();
  await User.updateOne({ _id: user._id }, { $set: { active: false } });
  const fresh = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion + 1);
  assert.equal((await me(fresh)).body.code, "unauthenticated");
  await drainAfterResponseTasks();
  assert.equal(await SecurityEvent.countDocuments({ reason: "inactive_account" }), 1);

  resetRevokedSessionThrottle();
  await User.deleteOne({ _id: user._id });
  assert.equal((await me(fresh)).status, 401);
  await drainAfterResponseTasks();
  assert.equal(await SecurityEvent.countDocuments({ reason: "account_missing" }), 1);

  // A valid session records nothing.
  const other = await createUser();
  assert.equal((await me(await createAuthHeadersForUser(String(other._id), "user", other.tokenVersion))).status, 200);
  await drainAfterResponseTasks();
  assert.equal(await SecurityEvent.countDocuments(), 3);
});

test("customer email-verification refusals are recorded per store without the token or password", async () => {
  const shop = await store();
  await register(shop.host, "ada@example.com", "correct horse battery");
  const token = lastToken("/account/verify-email", "ada@example.com");
  await SecurityEvent.deleteMany({});

  const badToken = await call(customerVerifyPOST, shop.host, { token: "z".repeat(43), password: "correct horse battery" }, { ip: freshIp() });
  assert.equal(badToken.status, 400);
  const wrongPassword = await call(customerVerifyPOST, shop.host, { token, password: "not the password" }, { ip: freshIp() });
  assert.equal(wrongPassword.status, 400);
  assert.equal((await call(customerVerifyPOST, shop.host, { token, password: "correct horse battery" }, { ip: freshIp() })).status, 200, "success records nothing");

  const events = await SecurityEvent.collection.find().sort({ _id: 1 }).toArray();
  assert.deepEqual(events.map((e) => [e.type, e.reason, e.scope, String(e.business)]), [
    ["email_verification_failed", "invalid_token", "storefront", String(shop.business._id)],
    ["email_verification_failed", "wrong_password", "storefront", String(shop.business._id)],
  ]);
  const raw = JSON.stringify(events);
  for (const secret of [token, "z".repeat(43), "not the password", "ada@example.com"]) assert.ok(!raw.includes(secret));
});

test("wrong current passwords are recorded", async () => {
  const user = await createUser({ password: "current-password-1" });
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);

  const wrong = await post(passwordPOST, { currentPassword: "nope", newPassword: "brand-new-password-2" }, { ...headers });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "invalid_password", "response unchanged");
  assert.equal((await post(passwordPOST, { currentPassword: "current-password-1", newPassword: "brand-new-password-2" }, { ...headers })).status, 200);

  const events = await SecurityEvent.collection.find().sort({ _id: 1 }).toArray();
  assert.deepEqual(events.map((e) => [e.type, e.reason, e.user ? String(e.user) : null]), [
    ["password_change_failed", "wrong_password", String(user._id)],
  ]);
  const raw = JSON.stringify(events);
  for (const secret of ["nope", "brand-new-password-2", "current-password-1"]) assert.ok(!raw.includes(secret));

  const summary = await getSecuritySummary();
  assert.equal(summary.passwordChangeFailures24h, 1);
});
