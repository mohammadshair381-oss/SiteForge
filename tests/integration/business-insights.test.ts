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
import { GET as insightsGET } from "@/app/api/businesses/[id]/insights/route";
import { GET as customersGET } from "@/app/api/businesses/[id]/manage/customers/route";
import { getBusinessInsights, parseDateRange } from "@/lib/business-insights";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/** Business insights: authorization, tenant isolation and consistency with order records. */

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

const DAY = 86_400_000;
// A fixed range so dates are deterministic: 2026-10-01 .. 2026-10-10 (UTC).
const RANGE = parseDateRange("2026-10-01", "2026-10-10");
const inRange = (day: number) => new Date(Date.UTC(2026, 9, day, 12));

async function order(business: unknown, o: {
  email: string; total: number; status: string; method?: "online" | "cod"; createdAt: Date; paidAt?: Date; refundedAt?: Date;
  currency?: string; items?: Array<{ product: unknown; name: string; qty: number; price: number }>;
}) {
  const items = (o.items ?? [{ product: new mongoose.Types.ObjectId(), name: "Thing", qty: 1, price: o.total }]).map((i) => ({
    product: String(i.product), productName: i.name, quantity: i.qty, unitPrice: i.price, currency: o.currency ?? "INR",
  }));
  const doc = await Order.create({
    business, ownerToken: crypto.randomUUID(), customerName: "Shopper", customerEmail: o.email, items,
    subtotal: o.total, total: o.total, currency: o.currency ?? "INR", status: o.status,
    ...(o.method ? { paymentMethod: o.method } : {}), paidAt: o.paidAt ?? null, refundedAt: o.refundedAt ?? null,
  });
  await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(doc._id)) }, { $set: { createdAt: o.createdAt } });
}

async function seeded() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await (await import("@/models/Business")).Business.updateOne({ _id: business._id }, { $set: { currency: "INR" } });
  const plan = await createPlan({ price: 0, productLimit: 4, staffLimit: 2 });
  await createSubscription(business._id, plan._id, { status: "active" });
  const tea = await Product.create({ business: business._id, name: "Tea", slug: "tea", price: 100, currency: "INR", stock: 2, status: "active" });
  const mug = await Product.create({ business: business._id, name: "Mug", slug: "mug", price: 50, currency: "INR", stock: 0, status: "active" });
  await Product.create({ business: business._id, name: "Pot", slug: "pot", price: 300, currency: "INR", stock: 40, status: "active" });
  await Product.create({ business: business._id, name: "Old", slug: "old", price: 1, currency: "INR", stock: 0, status: "archived" });

  // Returning customer: first order before the range.
  await order(business._id, { email: "ret@example.com", total: 100, status: "paid", method: "cod", createdAt: new Date(inRange(1).getTime() - 20 * DAY), paidAt: new Date(inRange(1).getTime() - 20 * DAY) });
  await order(business._id, { email: " RET@example.com ", total: 300, status: "paid", method: "online", createdAt: inRange(2), paidAt: inRange(2),
    items: [{ product: tea._id, name: "Tea", qty: 3, price: 100 }] });
  await order(business._id, { email: "new@example.com", total: 150, status: "paid", method: "cod", createdAt: inRange(3), paidAt: inRange(4),
    items: [{ product: tea._id, name: "Tea", qty: 1, price: 100 }, { product: mug._id, name: "Mug", qty: 1, price: 50 }] });
  await order(business._id, { email: "new@example.com", total: 999, status: "cancelled", createdAt: inRange(5) });
  await order(business._id, { email: "pending@example.com", total: 70, status: "pending", createdAt: inRange(6) });
  await order(business._id, { email: "refund@example.com", total: 80, status: "refunded", method: "online", createdAt: inRange(6), paidAt: inRange(6), refundedAt: inRange(7) });
  await order(business._id, { email: "usd@example.com", total: 10, status: "paid", method: "online", currency: "USD", createdAt: inRange(8), paidAt: inRange(8) });
  // Previous period (2026-09-21..30): one paid order of 200.
  await order(business._id, { email: "prev@example.com", total: 200, status: "paid", method: "cod", createdAt: new Date(Date.UTC(2026, 8, 25)), paidAt: new Date(Date.UTC(2026, 8, 25)) });
  return { owner, business, tea, mug };
}

test("insights are owner/manager only", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const other = await createBusinessWithOwner();
  const id = String(business._id);
  const get = async (user?: { _id: unknown; tokenVersion: number }) => {
    const headers = user ? await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion) : {};
    return ((await callHandler(insightsGET, new Request(`http://localhost/api/businesses/${id}/insights`, { headers: { ...headers } }), { params: Promise.resolve({ id }) })) as Response).status;
  };
  assert.equal(await get(), 401);
  assert.equal(await get(owner), 200);
  assert.equal(await get(manager), 200);
  assert.equal(await get(staff), 403);
  assert.equal(await get(other.owner), 403);
});

test("figures match the order records exactly and never include another business", async () => {
  const { business, owner } = await seeded();
  const other = await createBusinessWithOwner();
  await order(other.business._id, { email: "x@example.com", total: 5000, status: "paid", method: "online", createdAt: inRange(2), paidAt: inRange(2) });

  const data = await getBusinessInsights(String(business._id), RANGE);
  assert.equal(data.primaryCurrency, "INR");
  assert.equal(data.orders.placed, 6, "orders created in the range");
  assert.deepEqual(data.orders.byStatus, { pending: 1, paid: 3, cancelled: 1, refunded: 1 });
  assert.equal(data.orders.previousPeriod, 1);

  const inr = data.sales.find((s) => s.currency === "INR")!;
  assert.equal(inr.amount, 450, "paid orders by paidAt; refunded and cancelled excluded");
  assert.equal(inr.orders, 2);
  assert.equal(inr.online, 300);
  assert.equal(inr.cod, 150);
  assert.equal(inr.averageOrder, 225);
  assert.equal(inr.previousPeriod, 200);
  assert.deepEqual(data.sales.find((s) => s.currency === "USD"), { currency: "USD", amount: 10, orders: 1, online: 10, cod: 0, other: 0, averageOrder: 10, previousPeriod: 0 });
  assert.deepEqual(data.refunds, [{ currency: "INR", amount: 80, orders: 1 }]);

  assert.equal(data.series.sales.length, 10);
  assert.equal(data.series.sales.reduce((n, p) => n + p.count, 0), 450, "chart totals equal the INR sales figure");
  assert.equal(data.series.orders.reduce((n, p) => n + p.count, 0), 6);
  assert.equal(data.series.sales.find((p) => p.day === "2026-10-04")?.count, 150, "sales dated by payment, not order creation");

  const tea = data.topProducts.find((p) => p.name === "Tea")!;
  assert.deepEqual([tea.units, tea.revenue], [4, 400]);
  assert.equal(data.activeProducts, 3);
  assert.equal(data.unsoldActiveProducts, 1, "only Pot is unsold");
  assert.deepEqual(data.lowStock.map((p) => [p.name, p.stock]), [["Tea", 2]]);
  assert.deepEqual(data.outOfStock.map((p) => p.name), ["Mug"], "archived products are ignored");

  // Customers: same identity rules as the Customers page.
  assert.deepEqual(data.customers, { inRange: 5, new: 4, returning: 1 });
  const id = String(business._id);
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const res = (await callHandler(customersGET, new Request(`http://localhost/api/businesses/${id}/manage/customers`, { headers: { ...headers } }), { params: Promise.resolve({ id }) })) as Response;
  const body = (await res.json()) as { total?: number; customers?: unknown[] };
  const allTimeCustomers = body.total ?? body.customers?.length;
  // All time: the 5 in-range identities (ret's earlier order merges into "ret") + "prev".
  assert.equal(allTimeCustomers, 6, "the Customers page groups the same identities");

  assert.deepEqual(data.plan.products, { used: 3, limit: 4 }, "same counting as the product limit");
  assert.deepEqual(data.plan.staff, { used: 0, limit: 2 });
  assert.ok(!JSON.stringify(data).includes("@example.com"), "no customer emails in insights");
});

test("an empty business gets zeros, not errors", async () => {
  const { business } = await createBusinessWithOwner();
  const data = await getBusinessInsights(String(business._id), RANGE);
  assert.equal(data.orders.placed, 0);
  assert.deepEqual(data.sales, []);
  assert.deepEqual(data.topProducts, []);
  assert.deepEqual(data.customers, { inRange: 0, new: 0, returning: 0 });
  assert.equal(data.plan.active, false);
  assert.equal(data.series.orders.every((p) => p.count === 0), true);
});
