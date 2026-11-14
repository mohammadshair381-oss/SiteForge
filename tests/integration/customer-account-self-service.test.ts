import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { PASSWORD, call, freshIp, login, me, registerVerified, sessionCookie, store, waitForSafeRateLimitWindow } from "./helpers/customer-accounts";
import { POST as changePasswordPOST } from "@/app/api/storefront/account/password/change/route";
import { GET as profileGET, PATCH as profilePATCH } from "@/app/api/storefront/account/profile/route";
import { GET as orderGET } from "@/app/api/storefront/account/orders/[orderId]/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { clearEmailOutbox } from "@/lib/email";
import { Customer } from "@/models/Customer";
import { Order } from "@/models/Order";

/**
 * The signed-in customer's own account: profile, password change and one order
 * in full. Route handlers run against the in-memory replica set.
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
  await clearAllCollections();
});

const EMAIL = "ada@example.com";

async function signedIn(host: string, email = EMAIL, password = PASSWORD) {
  await registerVerified(host, email, password);
  const response = await login(host, email, password);
  assert.equal(response.status, 200);
  return sessionCookie(response);
}

function patchProfile(host: string, cookie: string | undefined, body: unknown, origin?: string) {
  const headers: Record<string, string> = { host, "content-type": "application/json", "x-forwarded-for": freshIp() };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  return profilePATCH(new Request(`http://${host}/api/storefront/account/profile`, { method: "PATCH", headers, body: JSON.stringify(body) }));
}

function getOrder(host: string, cookie: string | undefined, orderId: string) {
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  return orderGET(new Request(`http://${host}/api/storefront/account/orders/${orderId}`, { headers }), { params: Promise.resolve({ orderId }) });
}

async function orderFor(businessId: unknown, customerId: unknown) {
  return Order.create({
    business: businessId,
    ownerToken: "t".repeat(32),
    customerName: "Ada",
    customerEmail: EMAIL,
    customer: customerId,
    items: [{ product: "a".repeat(24), productName: "Mug", quantity: 2, unitPrice: 10, currency: "USD" }],
    subtotal: 20,
    total: 25,
    shippingTotal: 5,
    currency: "USD",
    status: "paid",
    paymentMethod: "cod",
    fulfillmentStatus: "shipped",
    trackingNumber: "TRK1",
    trackingUrl: "javascript:alert(1)",
    shippingAddress: { name: "Ada", line1: "1 Way", line2: "", city: "London", region: "", postalCode: "N1", country: "GB", phone: "" },
  });
}

test("profile: reads and updates only the name and phone, and never the email or verification", async () => {
  const { host } = await store();
  const cookie = await signedIn(host);

  const updated = await patchProfile(host, cookie, { name: "Ada King", phone: "+44 20 7946 0000", email: "evil@example.com", emailVerifiedAt: null, tokenVersion: 9 });
  assert.equal(updated.status, 200);
  const account = await Customer.findOne({ email: EMAIL }).lean();
  assert.equal(account?.name, "Ada King");
  assert.equal(account?.phone, "+44 20 7946 0000");
  assert.ok(account?.emailVerifiedAt instanceof Date, "verification untouched");
  assert.equal(await Customer.countDocuments({ email: "evil@example.com" }), 0);

  const read = await call(profileGET, host, undefined, { cookie });
  const { profile } = (await read.json()) as { profile: Record<string, unknown> };
  assert.deepEqual(Object.keys(profile).sort(), ["createdAt", "email", "emailVerified", "name", "phone"]);
});

test("profile: invalid values, signed-out and cross-site requests are refused", async () => {
  const { host } = await store();
  const cookie = await signedIn(host);
  assert.equal((await patchProfile(host, cookie, { name: "Ada", phone: "call me" })).status, 422);
  assert.equal((await patchProfile(host, undefined, { name: "Ada", phone: "" })).status, 401);
  assert.equal((await patchProfile(host, cookie, { name: "Ada", phone: "" }, "https://evil.example")).status, 403);
});

test("password change: needs the current password, signs out other sessions and keeps this browser signed in", async () => {
  const { host } = await store();
  const cookie = await signedIn(host);
  const other = sessionCookie(await login(host, EMAIL));
  const tokenBefore = await Customer.findOne({ email: EMAIL }).select("tokenVersion").lean();

  const wrong = await call(changePasswordPOST, host, { currentPassword: "not-the-password", newPassword: "another good password" }, { cookie, ip: freshIp() });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { code: string }).code, "invalid_password");

  const same = await call(changePasswordPOST, host, { currentPassword: PASSWORD, newPassword: PASSWORD }, { cookie, ip: freshIp() });
  assert.equal(((await same.json()) as { code: string }).code, "same_password");

  const changed = await call(changePasswordPOST, host, { currentPassword: PASSWORD, newPassword: "another good password" }, { cookie, ip: freshIp() });
  assert.equal(changed.status, 200);
  const tokenAfter = await Customer.findOne({ email: EMAIL }).select("tokenVersion").lean();
  assert.ok((tokenAfter?.tokenVersion ?? 0) > (tokenBefore?.tokenVersion ?? 0), "sessions revoked");

  assert.equal(await me(host, other), null, "another session is signed out");
  assert.equal(await me(host, cookie), null, "the old cookie of this browser too");
  assert.ok(await me(host, sessionCookie(changed)), "the new cookie works");
  assert.equal((await login(host, EMAIL, PASSWORD)).status, 401, "the old password no longer works");
  assert.equal((await login(host, EMAIL, "another good password")).status, 200);
});

test("password change: guesses are limited per account, even from different addresses", async () => {
  const { host } = await store();
  const cookie = await signedIn(host);
  const statuses: number[] = [];
  // 5 wrong guesses per account per fixed 60-minute window (CUSTOMER_RATE_LIMITS.passwordChange):
  // keep the burst inside one window so the sixth is the one refused.
  await waitForSafeRateLimitWindow();
  for (let i = 0; i < 6; i += 1) {
    const response = await call(changePasswordPOST, host, { currentPassword: "not-the-password", newPassword: "another good password" }, { cookie, ip: freshIp() });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429]);
});

test("order details: only the customer's own order at this store; the rest are the same 404", async () => {
  const first = await store();
  const second = await store();
  const cookie = await signedIn(first.host);
  const intruder = await signedIn(first.host, "grace@example.com");
  const elsewhere = await signedIn(second.host, EMAIL);
  const ada = await Customer.findOne({ email: EMAIL, business: first.business._id }).lean();
  const order = await orderFor(first.business._id, ada?._id);
  const orderId = String(order._id);

  const own = await getOrder(first.host, cookie, orderId);
  assert.equal(own.status, 200);
  const { order: view } = (await own.json()) as { order: Record<string, unknown> };
  assert.equal(view.total, 25);
  assert.equal(view.shippingTotal, 5);
  assert.equal(view.fulfillmentStatus, "shipped");
  assert.equal(view.trackingUrl, "", "only http(s) tracking links are passed on");
  for (const secret of ["ownerToken", "customerEmail", "orderProofHash", "idempotencyKey", "customer", "business"]) {
    assert.ok(!(secret in view), `${secret} never leaves`);
  }

  assert.equal((await getOrder(first.host, intruder, orderId)).status, 404, "another customer");
  assert.equal((await getOrder(second.host, elsewhere, orderId)).status, 404, "another store");
  assert.equal((await getOrder(first.host, cookie, "a".repeat(24))).status, 404, "missing");
  assert.equal((await getOrder(first.host, cookie, "not-an-id")).status, 404, "malformed");
  assert.equal((await getOrder(first.host, undefined, orderId)).status, 401, "signed out");
});

test("with the feature off every new route is the same 404", async () => {
  const { host } = await store();
  const cookie = await signedIn(host);
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "false";
  assert.equal((await patchProfile(host, cookie, { name: "Ada", phone: "" })).status, 404);
  assert.equal((await call(profileGET, host, undefined, { cookie })).status, 404);
  assert.equal((await call(changePasswordPOST, host, { currentPassword: PASSWORD, newPassword: "another good password" }, { cookie })).status, 404);
  assert.equal((await getOrder(host, cookie, "a".repeat(24))).status, 404);
});
