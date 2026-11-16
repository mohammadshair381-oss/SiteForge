import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { callHandler } from "./helpers/auth";
import { call, freshIp, lastToken, login, me, registerVerified, sessionCookie, store } from "./helpers/customer-accounts";
import { POST as logoutPOST } from "@/app/api/storefront/account/logout/route";
import { POST as customerForgotPOST } from "@/app/api/storefront/account/password/forgot/route";
import { POST as customerResetPOST } from "@/app/api/storefront/account/password/reset/route";
import { POST as platformForgotPOST } from "@/app/api/auth/password/forgot/route";
import { POST as platformResetPOST } from "@/app/api/auth/password/reset/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email";
import { getSecuritySummary, listSecurityEvents, securityQuerySchema } from "@/lib/admin/security";
import { resetRevokedSessionThrottle, securityDigest } from "@/lib/security-events";
import { Customer } from "@/models/Customer";
import { SecurityEvent } from "@/models/SecurityEvent";

/**
 * Storefront and password-reset security events: what is recorded, for which
 * store, and that nothing sensitive (passwords, tokens, raw emails) is stored
 * or any response changes.
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

const PASSWORD = "correct horse battery";

async function rawEvents() {
  return SecurityEvent.collection.find().sort({ _id: 1 }).toArray();
}

function assertNothingSensitive(raw: unknown, secrets: string[]) {
  const text = JSON.stringify(raw).toLowerCase();
  for (const secret of secrets) assert.ok(!text.includes(secret.toLowerCase()), `stored data must not contain ${secret}`);
}

test("failed customer sign-ins are recorded per store, identically for unknown and wrong-password attempts", async () => {
  const shop = await store();
  const other = await store();
  await registerVerified(shop.host, "ada@example.com", PASSWORD);
  await SecurityEvent.deleteMany({});

  const unknown = await login(shop.host, "nobody@example.com", "guess-number-1");
  const wrong = await login(shop.host, "ada@example.com", "guess-number-2");
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json(), "responses unchanged and indistinguishable");
  assert.equal((await login(shop.host, "ada@example.com", PASSWORD)).status, 200, "success is not recorded");

  const events = await rawEvents();
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.type, "customer_login_failed");
    assert.equal(e.scope, "storefront");
    assert.equal(String(e.business), String(shop.business._id));
    assert.equal(e.reason, null, "unknown vs wrong password is not distinguished");
    assert.equal(e.customer, null, "no account lookup is added");
    assert.equal(e.user, null);
  }
  assert.equal(events[1].emailDigest, securityDigest("email", "ada@example.com"));
  assertNothingSensitive(events, ["ada@example.com", "nobody@example.com", "guess-number", PASSWORD]);
  assert.equal(await SecurityEvent.countDocuments({ business: other.business._id }), 0);
});

test("customer password resets: requests, refusals and completions are recorded without tokens or emails", async () => {
  const shop = await store();
  await registerVerified(shop.host, "ada@example.com", PASSWORD);
  const customer = await Customer.findOne({ email: "ada@example.com" }).lean();
  await SecurityEvent.deleteMany({});

  for (const email of ["ada@example.com", "nobody@example.com"]) {
    const res = await call(customerForgotPOST, shop.host, { email }, { ip: freshIp() });
    assert.equal(res.status, 202);
  }
  const bad = await call(customerResetPOST, shop.host, { token: "x".repeat(43), password: "new password 123" }, { ip: freshIp() });
  assert.equal(bad.status, 400);
  const token = lastToken("/account/reset-password", "ada@example.com");
  const good = await call(customerResetPOST, shop.host, { token, password: "new password 123" }, { ip: freshIp() });
  assert.equal(good.status, 200);

  const events = await rawEvents();
  assert.deepEqual(events.map((e) => [e.type, e.reason]), [
    ["password_reset_requested", null],
    ["password_reset_requested", null],
    ["password_reset_failed", "invalid_token"],
    ["password_reset_completed", null],
  ]);
  assert.ok(events.every((e) => e.scope === "storefront" && String(e.business) === String(shop.business._id)));
  assert.equal(events[0].customer, null, "requests carry no account id (no lookup before the response)");
  assert.equal(String(events[3].customer), String(customer!._id));
  assertNothingSensitive(events, [token, "x".repeat(43), "ada@example.com", "nobody@example.com", "new password 123"]);
});

test("platform password resets are recorded too", async () => {
  const user = await createUser({ email: "owner@example.com" });
  const post = async (handler: (r: Request) => Promise<Response>, body: unknown, cookie?: string) => {
    const res = (await callHandler(handler, new Request("http://localhost/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": freshIp(), ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }))) as Response;
    await drainAfterResponseTasks();
    return res;
  };
  const pendingCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("swb_reset_challenge="))!.split(";")[0];
  const owner = await post(platformForgotPOST, { email: "owner@example.com" });
  assert.equal(owner.status, 200);
  assert.equal((await post(platformForgotPOST, { email: "nobody@example.com" })).status, 200);
  const message = getEmailOutbox().find((m) => m.to === "owner@example.com");
  const code = message!.text.match(/^ {4}(\d{6})$/m)![1];
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await post(platformResetPOST, { code: wrong, password: "new password 123" }, pendingCookie(owner))).status, 400);
  assert.equal((await post(platformResetPOST, { code, password: "new password 123" }, pendingCookie(owner))).status, 200);

  const events = await rawEvents();
  assert.deepEqual(events.map((e) => [e.type, e.reason, e.user ? String(e.user) : null]), [
    ["password_reset_requested", null, String(user._id)],
    ["password_reset_requested", null, null],
    ["password_reset_failed", "wrong_code", String(user._id)],
    ["password_reset_completed", null, String(user._id)],
  ]);
  assert.ok(events.every((e) => e.scope === "platform"));
  assertNothingSensitive(events, [code, "owner@example.com", "nobody@example.com", "new password 123"]);
});

test("a revoked customer session is recorded once per window, after the response, with the same 401", async () => {
  const shop = await store();
  await registerVerified(shop.host, "ada@example.com", PASSWORD);
  const cookie = sessionCookie(await login(shop.host, "ada@example.com", PASSWORD));
  assert.ok(await me(shop.host, cookie));
  const logout = await call(logoutPOST, shop.host, {}, { cookie, ip: freshIp() });
  assert.ok([200, 204].includes(logout.status));
  await SecurityEvent.deleteMany({});

  assert.equal(await me(shop.host, cookie), null, "the old cookie is refused");
  assert.equal(await me(shop.host, cookie), null);
  await drainAfterResponseTasks();
  const events = await rawEvents();
  assert.equal(events.length, 1, "throttled per customer");
  assert.equal(events[0].type, "customer_session_revoked");
  assert.equal(events[0].reason, "token_version_mismatch");
  assert.equal(events[0].scope, "storefront");
  assert.equal(String(events[0].business), String(shop.business._id));
  const customer = await Customer.findOne({ email: "ada@example.com" }).lean();
  assert.equal(String(events[0].customer), String(customer!._id));

  // Deactivated account, via the checkout resolver (also used by every storefront page).
  resetRevokedSessionThrottle();
  const fresh = sessionCookie(await login(shop.host, "ada@example.com", PASSWORD));
  await Customer.updateOne({ _id: customer!._id }, { $set: { active: false } });
  const resolution = await resolveCheckoutCustomer(
    new Request(`http://${shop.host}/`, { headers: { cookie: fresh, host: shop.host } }),
    shop.business,
  );
  assert.equal(resolution.status, "inactive");
  await drainAfterResponseTasks();
  assert.equal(await SecurityEvent.countDocuments({ reason: "inactive_account" }), 1);

  // No session at all, or a session of another store, is never recorded as "revoked".
  const other = await store();
  await me(other.host, fresh);
  await me(shop.host);
  await drainAfterResponseTasks();
  assert.equal(await SecurityEvent.countDocuments(), 2);
});

test("the admin security view separates storefront events and never shows customer emails", async () => {
  const shop = await store();
  await registerVerified(shop.host, "ada@example.com", PASSWORD);
  await SecurityEvent.deleteMany({});
  for (let i = 0; i < 5; i++) await login(shop.host, "ada@example.com", `wrong-${i}`);
  await createUser({ email: "admin@example.com", platformRole: "super_admin" });

  const summary = await getSecuritySummary();
  assert.equal(summary.customerFailedLogins.lastHour, 5);
  assert.equal(summary.failedLogins.lastHour, 0, "platform counts stay platform-only");
  assert.equal(summary.targetedAccounts.length, 1);
  assert.equal(summary.targetedAccounts[0].scope, "storefront");
  assert.equal(summary.targetedAccounts[0].business?.id, String(shop.business._id));
  assert.equal(summary.targetedAccounts[0].user, null);

  const storefront = await listSecurityEvents(securityQuerySchema.parse({ scope: "storefront" }));
  assert.equal(storefront.total, 5);
  assert.equal(storefront.events[0].business?.name, shop.business.name);
  assert.equal((await listSecurityEvents(securityQuerySchema.parse({ scope: "platform" }))).total, 0);
  assert.equal((await listSecurityEvents(securityQuerySchema.parse({ business: String(shop.business._id) }))).total, 5);
  assert.ok(!JSON.stringify({ summary, storefront }).includes("ada@example.com"));
});
