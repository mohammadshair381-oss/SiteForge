import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as overviewRoute from "@/app/api/admin/overview/route";
import * as usersRoute from "@/app/api/admin/users/route";
import * as paymentsRoute from "@/app/api/admin/payments/route";
import * as businessDetailRoute from "@/app/api/admin/businesses/[id]/route";
import * as businessesRoute from "@/app/api/admin/businesses/route";
import * as auditRoute from "@/app/api/admin/audit-logs/route";
import { escapeRegex, listAdminBusinesses, businessQuerySchema, parseDateRange } from "@/lib/admin/control-center";
import { Business } from "@/models/Business";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Customer } from "@/models/Customer";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { Payment } from "@/models/Payment";
import { Product } from "@/models/Product";
import { User } from "@/models/User";

/**
 * Super Admin control center (read-only APIs): authorization, tenant-correct
 * aggregation, data minimisation, filters, and honest money reporting.
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
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

type Headers = { cookie: string } | undefined;

async function adminHeaders() {
  const user = await createUser({ email: `admin-${crypto.randomUUID()}@test.com`, platformRole: "super_admin" });
  return { user, headers: await createAuthHeadersForUser(String(user._id), "super_admin", user.tokenVersion) };
}

async function get(handler: unknown, path: string, headers: Headers, params?: Record<string, string>) {
  const request = new Request(`http://localhost${path}`, { headers: { ...(headers ?? {}) } });
  const res = (params
    ? await callHandler(handler as never, request, { params: Promise.resolve(params) } as never)
    : await callHandler(handler as never, request)) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

let orderSeq = 0;
async function order(
  business: unknown,
  options: { status?: string; paymentMethod?: "online" | "cod"; total?: number; currency?: string; createdAt?: Date; paidAt?: Date | null } = {},
) {
  orderSeq += 1;
  const doc = await Order.create({
    business,
    ownerToken: crypto.randomUUID(),
    customerName: "Secret Shopper",
    customerEmail: `shopper${orderSeq}@private.example`,
    items: [{ product: String(new mongoose.Types.ObjectId()), productName: "Mug", quantity: 1, unitPrice: options.total ?? 10, currency: options.currency ?? "INR" }],
    subtotal: options.total ?? 10,
    total: options.total ?? 10,
    status: options.status ?? "pending",
    currency: options.currency ?? "INR",
    ...(options.paymentMethod ? { paymentMethod: options.paymentMethod } : {}),
    paidAt: options.paidAt ?? null,
  });
  if (options.createdAt) {
    await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(doc._id)) }, { $set: { createdAt: options.createdAt } });
  }
  return doc;
}

// ---------------------------------------------------------------------------

test("every control-center API requires a super admin; business owners are not platform admins", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const ownerHeaders = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const managerHeaders = await createAuthHeadersForUser(String(manager._id), "user", manager.tokenVersion);
  const inactive = await createUser({ platformRole: "super_admin", active: false });
  const inactiveHeaders = await createAuthHeadersForUser(String(inactive._id), "super_admin", inactive.tokenVersion);
  const id = String(business._id);

  const calls = (h: Headers) => [
    get(overviewRoute.GET, "/api/admin/overview", h),
    get(usersRoute.GET, "/api/admin/users", h),
    get(paymentsRoute.GET, "/api/admin/payments", h),
    get(businessDetailRoute.GET, `/api/admin/businesses/${id}`, h, { id }),
    get(auditRoute.GET, "/api/admin/audit-logs?action=business.suspend", h),
  ];
  for (const res of await Promise.all(calls(undefined))) assert.equal(res.status, 401);
  for (const res of await Promise.all(calls(inactiveHeaders))) assert.equal(res.status, 401);
  for (const h of [ownerHeaders, managerHeaders]) {
    for (const res of await Promise.all(calls(h))) {
      assert.equal(res.status, 403);
      assert.equal(res.body.code, "forbidden");
    }
  }
  // A forged platform role in the session does not help: the role is re-read from the database.
  const forged = await createAuthHeadersForUser(String(owner._id), "super_admin", owner.tokenVersion);
  assert.equal((await get(overviewRoute.GET, "/api/admin/overview", forged)).status, 403);
});

test("payments and overview expose no write methods", () => {
  for (const mod of [overviewRoute, usersRoute, paymentsRoute, businessDetailRoute] as Array<Record<string, unknown>>) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(mod[method], undefined, method);
  }
});

test("overview counts per status and keeps manual, provider, online and COD money apart", async () => {
  const { headers } = await adminHeaders();
  const a = await createBusinessWithOwner({ status: "published" });
  const b = await createBusinessWithOwner({ status: "suspended" });
  const c = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 10 });
  await createSubscription(a.business._id, plan._id, { status: "active" });
  await createSubscription(b.business._id, plan._id, { status: "past_due" });
  // c: published with no subscription -> storefront offline alert.

  const now = new Date();
  await Payment.create({ business: a.business._id, amount: 10, currency: "USD", status: "succeeded", provider: "manual", paidAt: now });
  await Payment.create({ business: a.business._id, amount: 25, currency: "USD", status: "succeeded", provider: "stripe", providerEventId: "evt_1", paidAt: now });
  await Payment.create({ business: a.business._id, amount: 99, currency: "USD", status: "failed", provider: "stripe", providerEventId: "evt_2" });

  await order(a.business._id, { status: "paid", paymentMethod: "online", total: 100, paidAt: now });
  await order(a.business._id, { status: "paid", paymentMethod: "cod", total: 40, paidAt: now });
  await order(b.business._id, { status: "paid", paymentMethod: "cod", total: 5, currency: "USD", paidAt: now });
  await order(a.business._id, { status: "pending" });
  // Outside the range: counted in all-time totals only.
  await order(a.business._id, { status: "cancelled", createdAt: new Date(now.getTime() - 400 * 86_400_000) });

  await Product.create({ business: a.business._id, name: "P1", slug: "p1", price: 1, status: "active" });
  await Product.create({ business: a.business._id, name: "P2", slug: "p2", price: 1, status: "archived" });
  await Customer.create({ business: a.business._id, name: "C", email: "c@example.com" });

  const op = await OrderPayment.create({
    business: a.business._id, order: new mongoose.Types.ObjectId(), provider: "razorpay", mode: "test",
    providerLinkId: "plink_X1", shortUrl: "https://rzp.io/i/x", amountMinor: 1000, currency: "INR",
    status: "paid", orderOutcome: "needs_review", outcomeReason: "not_pending",
  });
  assert.ok(op);

  const res = await get(overviewRoute.GET, "/api/admin/overview", headers);
  assert.equal(res.status, 200);
  const o = res.body;
  assert.deepEqual(o.totals.businesses, { draft: 0, published: 2, suspended: 1, deleted: 0 });
  assert.equal(o.totals.orders.paid, 3);
  assert.equal(o.totals.orders.pending, 1);
  assert.equal(o.totals.orders.cancelled, 1);
  assert.equal(o.inRange.orders, 4, "the 400-day-old order is outside the default range");
  assert.equal(o.totals.products.archived, 1);
  assert.equal(o.totals.customerAccounts, 1);
  assert.equal(o.totals.subscriptions.active, 1);
  assert.equal(o.totals.subscriptions.past_due, 1);

  assert.deepEqual(o.inRange.payments.manualSubscriptions, [{ currency: "USD", amount: 10, count: 1 }]);
  assert.deepEqual(o.inRange.payments.providerSubscriptions, [{ currency: "USD", amount: 25, count: 1 }], "failed payments are excluded");
  assert.deepEqual(o.inRange.payments.onlineOrders, [{ currency: "INR", amount: 100, count: 1 }]);
  assert.deepEqual(o.inRange.payments.codOrders, [{ currency: "INR", amount: 40, count: 1 }, { currency: "USD", amount: 5, count: 1 }], "currencies never merged");

  const kinds = (o.alerts as Array<{ kind: string; count: number }>).map((x) => `${x.kind}:${x.count}`).sort();
  assert.deepEqual(kinds, ["payment_needs_review:1", "published_without_plan:1", "subscription_past_due:1", "suspended:1"]);
  assert.equal(o.series.orders.length, 30);
  assert.equal(o.series.orders.reduce((n: number, p: { count: number }) => n + p.count, 0), 4);
  assert.ok(!JSON.stringify(o).includes("private.example"), "no shopper emails");
});

test("date ranges are validated, defaulted and capped", () => {
  const now = new Date("2026-10-29T15:00:00Z");
  const def = parseDateRange(undefined, undefined, now);
  assert.equal(def.days, 30);
  assert.equal(def.to.toISOString(), "2026-10-30T00:00:00.000Z");
  const custom = parseDateRange("2026-10-01", "2026-10-10", now);
  assert.equal(custom.days, 10);
  assert.equal(parseDateRange("2026-10-10", "2026-10-01", now).days, 30, "reversed range falls back");
  assert.equal(parseDateRange("not-a-date", "2026-10-01'; drop", now).days, 30);
  assert.equal(parseDateRange("2000-01-01", "2026-10-01", now).days, 366, "capped");
});

test("business search is regex-safe, finds owners, filters by subscription, and counts per tenant", async () => {
  const { headers } = await adminHeaders();
  const plan = await createPlan({ price: 0 });
  const a = await createBusinessWithOwner({ status: "published", name: "Alpha (Tea) Co." });
  const b = await createBusinessWithOwner({ status: "draft", name: "Beta Bakery" });
  await createSubscription(a.business._id, plan._id, { status: "active" });
  await createSubscription(b.business._id, plan._id, { status: "canceled" });
  await Product.create({ business: a.business._id, name: "P", slug: "p", price: 1, status: "active" });
  await Product.create({ business: a.business._id, name: "Q", slug: "q", price: 1, status: "draft" });
  await order(a.business._id);
  await order(b.business._id);
  await order(b.business._id);

  const list = (q: Record<string, string>) => listAdminBusinesses(businessQuerySchema.parse(q));
  assert.deepEqual((await list({ q: "(Tea)" })).businesses.map((x) => x.name), ["Alpha (Tea) Co."]);
  assert.equal((await list({ q: ".*" })).total, 0, "regex metacharacters are literal");
  assert.equal(escapeRegex("a.b*(c)"), "a\\.b\\*\\(c\\)");
  const ownerEmail = (await User.findById(b.owner._id).lean())!.email;
  assert.deepEqual((await list({ q: ownerEmail })).businesses.map((x) => x.name), ["Beta Bakery"]);
  assert.deepEqual((await list({ status: "draft" })).businesses.map((x) => x.name), ["Beta Bakery"]);
  assert.deepEqual((await list({ subscription: "canceled" })).businesses.map((x) => x.name), ["Beta Bakery"]);
  assert.deepEqual((await list({ entitled: "1" })).businesses.map((x) => x.name), ["Alpha (Tea) Co."]);
  assert.deepEqual((await list({ entitled: "0", subscription: "active" })).businesses, [], "filters combine");
  assert.deepEqual((await list({ sort: "name" })).businesses.map((x) => x.name), ["Alpha (Tea) Co.", "Beta Bakery"]);
  assert.equal((await list({ status: "bogus", sort: "bogus", page: "-3" })).total, 2, "bad filters fall back to defaults");

  const rows = (await list({})).businesses;
  const alpha = rows.find((x) => x.name.startsWith("Alpha"))!;
  const beta = rows.find((x) => x.name.startsWith("Beta"))!;
  assert.equal(alpha.productCount, 2);
  assert.equal(alpha.orderCount, 1);
  assert.equal(beta.productCount, 0);
  assert.equal(beta.orderCount, 2);
  assert.equal(alpha.entitled, true);
  assert.equal(beta.entitled, false);

  // The pre-existing list API still works unchanged.
  assert.equal((await get(businessesRoute.GET, "/api/admin/businesses", headers)).status, 200);
});

test("business detail: usage, no shopper PII, no payment secrets, 404 for unknown ids", async () => {
  const { headers } = await adminHeaders();
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0, productLimit: 1, staffLimit: 2 });
  await createSubscription(business._id, plan._id, { status: "active" });
  await Product.create({ business: business._id, name: "P", slug: "p", price: 1, status: "active" });
  await Product.create({ business: business._id, name: "Q", slug: "q", price: 1, status: "active" });
  await order(business._id, { status: "paid", paymentMethod: "online", total: 12, paidAt: new Date() });
  await BusinessPaymentAccount.create({
    business: business._id, provider: "razorpay", mode: "test", keyId: "rzp_test_abcdef1",
    keySecretEnc: { v: 1, iv: "SECRETIV", tag: "SECRETTAG", ct: "SECRETCIPHERTEXT" },
    webhookSecretEnc: { v: 1, iv: "SECRETIV", tag: "SECRETTAG", ct: "SECRETCIPHERTEXT" },
    connectedAt: new Date(),
  });
  const other = await createBusinessWithOwner();
  await order(other.business._id, { status: "paid", paymentMethod: "cod", total: 999, paidAt: new Date() });

  const id = String(business._id);
  const res = await get(businessDetailRoute.GET, `/api/admin/businesses/${id}`, headers, { id });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("SECRET"), "no encrypted secrets");
  assert.ok(!text.includes("private.example") && !text.includes("Secret Shopper"), "no shopper PII");
  assert.ok(!text.includes("ownerToken") && !text.includes("passwordHash"));
  assert.deepEqual(res.body.usage.products, { used: 2, limit: 1 });
  assert.equal(res.body.paymentAccount.keyId, "rzp_test_abcdef1");
  assert.deepEqual(res.body.paidOrders, [{ method: "online", currency: "INR", amount: 12, count: 1 }], "other tenants' orders are not counted");
  assert.equal(res.body.recentOrders.length, 1);

  for (const bad of ["not-an-id", String(new mongoose.Types.ObjectId())]) {
    assert.equal((await get(businessDetailRoute.GET, `/api/admin/businesses/${bad}`, headers, { id: bad })).status, 404);
  }
});

test("user list is allowlisted and filterable", async () => {
  const { headers } = await adminHeaders();
  const { owner, business } = await createBusinessWithOwner({ name: "Gamma" });
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  await createUser({ email: "sleepy@example.com", active: false });

  const all = await get(usersRoute.GET, "/api/admin/users", headers);
  assert.equal(all.status, 200);
  const text = JSON.stringify(all.body);
  assert.ok(!text.includes("passwordHash") && !text.includes("tokenVersion") && !text.includes("$2"), "no hashes or token versions");
  const ownerRow = all.body.users.find((u: { id: string }) => u.id === String(owner._id));
  assert.deepEqual(ownerRow.memberships, [{ businessId: String(business._id), businessName: "Gamma", role: "owner", status: "active" }]);
  assert.equal(ownerRow.emailVerification, "unverified");

  assert.equal((await get(usersRoute.GET, "/api/admin/users?role=super_admin", headers)).body.total, 1);
  assert.deepEqual((await get(usersRoute.GET, "/api/admin/users?state=inactive", headers)).body.users.map((u: { email: string }) => u.email), ["sleepy@example.com"]);
  assert.equal((await get(usersRoute.GET, "/api/admin/users?state=unverified", headers)).body.total, 1);
  assert.equal((await get(usersRoute.GET, `/api/admin/users?q=${encodeURIComponent("sleepy@")}`, headers)).body.total, 1);
  assert.equal((await get(usersRoute.GET, `/api/admin/users?q=${encodeURIComponent("[")}`, headers)).status, 200, "regex-safe");
});

test("payment records: manual flagged as unverified, order payments filter by review and business", async () => {
  const { headers } = await adminHeaders();
  const a = await createBusinessWithOwner();
  const b = await createBusinessWithOwner();
  await Payment.create({ business: a.business._id, amount: 10, currency: "USD", status: "succeeded", provider: "manual", paidAt: new Date() });
  for (const [business, outcome, link] of [[a, "applied", "plink_A"], [a, "needs_review", "plink_B"], [b, "applied", "plink_C"]] as const) {
    await OrderPayment.create({
      business: business.business._id, order: new mongoose.Types.ObjectId(), provider: "razorpay", mode: "test",
      providerLinkId: link, shortUrl: "https://rzp.io/i/x", amountMinor: 1500, currency: "INR", status: "paid", orderOutcome: outcome,
    });
  }

  const subs = await get(paymentsRoute.GET, "/api/admin/payments", headers);
  assert.equal(subs.body.domain, "subscription");
  assert.equal(subs.body.records[0].verified, false);
  assert.equal(subs.body.total, 1);

  const orders = await get(paymentsRoute.GET, "/api/admin/payments?domain=order", headers);
  assert.equal(orders.body.total, 3);
  assert.equal(orders.body.records[0].amount, 15);
  const review = await get(paymentsRoute.GET, "/api/admin/payments?domain=order&review=1", headers);
  assert.deepEqual(review.body.records.map((r: { reference: string }) => r.reference), ["plink_B"]);
  const onlyB = await get(paymentsRoute.GET, `/api/admin/payments?domain=order&business=${b.business._id}`, headers);
  assert.deepEqual(onlyB.body.records.map((r: { reference: string }) => r.reference), ["plink_C"]);
  assert.ok(!JSON.stringify(orders.body).includes("shortUrl"));
});

test("audit log filters by action, target and date; invalid filters are rejected", async () => {
  const { headers, user } = await adminHeaders();
  const { business } = await createBusinessWithOwner({ status: "published" });
  const patch = (action: string) =>
    callHandler(businessesRoute.PATCH, new Request(`http://localhost/api/admin/businesses?id=${business._id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ action, reason: "Testing the audit filters" }),
    })) as Promise<Response>;
  assert.equal((await patch("suspend")).status, 200);
  assert.equal((await patch("reactivate")).status, 200);

  const byAction = await get(auditRoute.GET, "/api/admin/audit-logs?action=business.suspend", headers);
  assert.equal(byAction.body.total, 1);
  assert.equal(byAction.body.entries[0].action, "business.suspend");
  const byTarget = await get(auditRoute.GET, `/api/admin/audit-logs?targetType=business&targetId=${business._id}`, headers);
  assert.equal(byTarget.body.total, 2);
  assert.equal((await get(auditRoute.GET, `/api/admin/audit-logs?actor=${user._id}`, headers)).body.total, 2);
  assert.equal((await get(auditRoute.GET, "/api/admin/audit-logs?from=2000-01-01&to=2000-01-02", headers)).body.total, 0);
  for (const bad of ["action=business.delete", "targetType=customer", "actor=xyz", "from=yesterday"]) {
    assert.equal((await get(auditRoute.GET, `/api/admin/audit-logs?${bad}`, headers)).status, 422, bad);
  }
  assert.equal((await get(auditRoute.GET, "/api/admin/audit-logs", headers)).body.total, 2, "unfiltered list unchanged");
  assert.equal((await Business.findById(business._id).lean())?.status, "draft");
});
