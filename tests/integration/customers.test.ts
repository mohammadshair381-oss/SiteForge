import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose, { type Types } from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership } from "./helpers/tenant";
import { GET as customersGET } from "@/app/api/businesses/[id]/manage/customers/route";
import { GET as customerGET } from "@/app/api/businesses/[id]/manage/customers/[customerId]/route";
import { GET as ordersGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Business customer management (derived from orders): identity grouping,
 * totals, search, pagination, authorization and tenant isolation.
 *
 * Orders are inserted through the raw collection so legacy / malformed data
 * (mixed-case emails, missing currency, bad emails) can be represented
 * exactly as it might exist in a real database.
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
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await clearAllCollections();
});

type Headers = { cookie: string } | undefined;
let clock = Date.UTC(2026, 0, 1);

async function headersFor(user: { _id: Types.ObjectId; tokenVersion: number }, role: "user" | "super_admin" = "user") {
  return createAuthHeadersForUser(String(user._id), role, user.tokenVersion);
}

async function store() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  return { owner, business, id: String(business._id), headers: await headersFor(owner) };
}

interface SeedOptions {
  email?: unknown;
  name?: string;
  status?: "pending" | "paid" | "cancelled" | "refunded";
  total?: number;
  currency?: string | null;
  items?: Array<{ productName: string; quantity: number; unitPrice: number; currency: string }>;
}

async function seedOrder(businessId: Types.ObjectId, options: SeedOptions = {}) {
  clock += 60_000;
  const total = options.total ?? 10;
  const currency = options.currency === undefined ? "USD" : options.currency;
  const doc: Record<string, unknown> = {
    _id: new mongoose.Types.ObjectId(),
    business: businessId,
    orderNumber: crypto.randomBytes(6).toString("hex"),
    ownerToken: `guest-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    orderProofHash: "f".repeat(64),
    customerName: options.name ?? "Ada",
    items: options.items ?? [
      { product: "p1", productName: "Mug", quantity: 1, unitPrice: total, currency: currency ?? "USD" },
    ],
    subtotal: total,
    total,
    status: options.status ?? "paid",
    createdAt: new Date(clock),
    updatedAt: new Date(clock),
  };
  if (options.email !== undefined) doc.customerEmail = options.email;
  else doc.customerEmail = "ada@example.com";
  if (currency !== null) doc.currency = currency;
  await Order.collection.insertOne(doc);
  return doc as { _id: Types.ObjectId; orderNumber: string };
}

function request(path: string, headers: Headers) {
  return new Request(`http://localhost${path}`, { headers: headers ?? {} });
}

async function list(id: string, headers: Headers, query = "") {
  const res = (await callHandler(
    customersGET,
    request(`/api/businesses/${id}/manage/customers${query}`, headers),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: await res.json().catch(() => ({})), res };
}

async function detail(id: string, customerId: string, headers: Headers) {
  const res = (await callHandler(
    customerGET,
    request(`/api/businesses/${id}/manage/customers/${customerId}`, headers),
    { params: Promise.resolve({ id, customerId }) },
  )) as Response;
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------------
// Grouping and totals
// ---------------------------------------------------------------------------

test("orders are grouped by normalised email; totals count paid only, per currency", async () => {
  const { business, id, headers } = await store();
  await seedOrder(business._id, { email: " Ada@Example.COM ", name: "Ada L", status: "paid", total: 20 });
  await seedOrder(business._id, { email: "ada@example.com", status: "pending", total: 5 });
  await seedOrder(business._id, { email: "ADA@example.com", status: "cancelled", total: 100 });
  await seedOrder(business._id, { email: "ada@example.com", status: "refunded", total: 50 });
  await seedOrder(business._id, { email: "ada@example.com", name: "Ada Lovelace", status: "paid", total: 7.5, currency: "EUR" });

  const { status, body } = await list(id, headers);
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  const [ada] = body.customers;
  assert.equal(ada.email, "ada@example.com");
  assert.equal(ada.name, "Ada Lovelace", "the most recent order's name is shown");
  assert.equal(ada.orderCount, 5, "cancelled and refunded orders are still counted as orders");
  assert.equal(ada.paidOrderCount, 2);
  assert.deepEqual(ada.totals, [
    { currency: "EUR", paid: 7.5, pending: 0 },
    { currency: "USD", paid: 20, pending: 5 },
  ]);
});

test("missing or malformed emails are never merged; provider aliases stay separate", async () => {
  const { business, id, headers } = await store();
  await seedOrder(business._id, { email: "ada@example.com" });
  await seedOrder(business._id, { email: "ada+shop@example.com" });
  await seedOrder(business._id, { email: "" });
  await seedOrder(business._id, { email: "not-an-email" });
  await seedOrder(business._id, { email: null });
  // A legacy order without a currency field falls back to the item currency.
  await seedOrder(business._id, { email: "legacy@example.com", currency: null, items: [{ productName: "Old", quantity: 2, unitPrice: 3, currency: "GBP" }], total: 6 });

  const { body } = await list(id, headers);
  assert.equal(body.total, 3);
  assert.deepEqual(body.customers.map((c: { email: string }) => c.email).sort(), [
    "ada+shop@example.com",
    "ada@example.com",
    "legacy@example.com",
  ]);
  assert.equal(body.unidentifiedOrderCount, 3);
  const legacy = body.customers.find((c: { email: string }) => c.email === "legacy@example.com");
  assert.deepEqual(legacy.totals, [{ currency: "GBP", paid: 6, pending: 0 }]);
});

// ---------------------------------------------------------------------------
// Search and pagination
// ---------------------------------------------------------------------------

test("search matches name or email case-insensitively and treats input literally", async () => {
  const { business, id, headers } = await store();
  await seedOrder(business._id, { email: "grace@navy.example", name: "Grace Hopper" });
  await seedOrder(business._id, { email: "alan@example.com", name: "Alan Turing" });
  await seedOrder(business._id, { email: "axb@example.com", name: "Someone" });

  const byName = await list(id, headers, "?q=HOPPER");
  assert.deepEqual(byName.body.customers.map((c: { email: string }) => c.email), ["grace@navy.example"]);
  const byEmail = await list(id, headers, "?q=alan%40");
  assert.deepEqual(byEmail.body.customers.map((c: { email: string }) => c.email), ["alan@example.com"]);
  const literal = await list(id, headers, "?q=a.b");
  assert.equal(literal.body.total, 0, "a dot is not a wildcard");
  const special = await list(id, headers, "?q=%5B(");
  assert.equal(special.status, 200);
  assert.equal(special.body.total, 0);
});

test("pagination is newest-activity first with correct totals", async () => {
  const { business, id, headers } = await store();
  for (let i = 0; i < 25; i += 1) {
    await seedOrder(business._id, { email: `c${String(i).padStart(2, "0")}@example.com` });
  }
  const page1 = await list(id, headers, "?page=1&limit=10");
  assert.equal(page1.body.total, 25);
  assert.equal(page1.body.customers.length, 10);
  assert.equal(page1.body.customers[0].email, "c24@example.com", "most recent order first");
  const page3 = await list(id, headers, "?page=3&limit=10");
  assert.equal(page3.body.customers.length, 5);
  assert.equal(page3.body.customers[4].email, "c00@example.com");
  const beyond = await list(id, headers, "?page=9&limit=10");
  assert.equal(beyond.body.customers.length, 0);
  assert.equal(beyond.body.total, 25);
});

test("malformed query parameters are rejected", async () => {
  const { id, headers } = await store();
  for (const query of ["?limit=0", "?limit=51", "?page=0", "?page=abc", "?limit=2.5", `?q=${"x".repeat(101)}`]) {
    assert.equal((await list(id, headers, query)).status, 422, query);
  }
});

test("an empty business returns an empty list", async () => {
  const { id, headers } = await store();
  const { status, body } = await list(id, headers);
  assert.equal(status, 200);
  assert.deepEqual(body, { customers: [], total: 0, page: 1, limit: 20, unidentifiedOrderCount: 0 });
});

// ---------------------------------------------------------------------------
// Authorization and tenant isolation
// ---------------------------------------------------------------------------

test("owners and managers can read customers; staff, outsiders, anonymous and super admins cannot", async () => {
  const { business, id, headers } = await store();
  const order = await seedOrder(business._id, { email: "ada@example.com" });

  assert.equal((await list(id, headers)).status, 200);

  const manager = await createUser({ email: "cust-manager@test.com" });
  await createMembership(business._id, manager._id, "manager");
  assert.equal((await list(id, await headersFor(manager))).status, 200);
  assert.equal((await detail(id, String(order._id), await headersFor(manager))).status, 200);

  const staff = await createUser({ email: "cust-staff@test.com" });
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await list(id, await headersFor(staff))).status, 403);
  assert.equal((await detail(id, String(order._id), await headersFor(staff))).status, 403);

  const other = await store();
  assert.equal((await list(id, other.headers)).status, 403);
  assert.equal((await detail(id, String(order._id), other.headers)).status, 403);

  assert.equal((await list(id, undefined)).status, 401);

  // Platform admins are not implicit business members.
  const admin = await createUser({ email: "cust-admin@test.com", platformRole: "super_admin" });
  assert.equal((await list(id, await headersFor(admin, "super_admin"))).status, 403);
});

test("business A never sees business B's customers, orders or totals", async () => {
  const a = await store();
  const b = await store();
  await seedOrder(a.business._id, { email: "shared@example.com", total: 10 });
  const bOrder = await seedOrder(b.business._id, { email: "shared@example.com", total: 999 });
  await seedOrder(b.business._id, { email: "b-only@example.com" });

  const aList = await list(a.id, a.headers);
  assert.deepEqual(aList.body.customers.map((c: { email: string }) => c.email), ["shared@example.com"]);
  assert.deepEqual(aList.body.customers[0].totals, [{ currency: "USD", paid: 10, pending: 0 }]);
  assert.equal(aList.body.customers[0].orderCount, 1);

  // B's customer id through A's route: indistinguishable from "does not exist".
  const crossDetail = await detail(a.id, String(bOrder._id), a.headers);
  assert.equal(crossDetail.status, 404);
  assert.equal(crossDetail.body.code, "not_found");
  const missing = await detail(a.id, String(new mongoose.Types.ObjectId()), a.headers);
  assert.equal(missing.status, 404);
  assert.deepEqual(crossDetail.body, missing.body);

  // And through B's own route it works.
  assert.equal((await detail(b.id, String(bOrder._id), b.headers)).status, 200);
});

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

test("customer detail lists only that customer's orders in this business, without secrets", async () => {
  const { business, id, headers } = await store();
  const first = await seedOrder(business._id, { email: "ada@example.com", status: "paid", total: 12, items: [{ productName: "Mug", quantity: 2, unitPrice: 6, currency: "USD" }] });
  const second = await seedOrder(business._id, { email: " ADA@example.com", status: "cancelled", total: 4 });
  await seedOrder(business._id, { email: "someone-else@example.com" });

  const res = await detail(id, String(second._id), headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.customer.id, String(first._id), "any order id resolves to the canonical customer id");
  assert.equal(res.body.customer.email, "ada@example.com");
  assert.equal(res.body.orders.length, 2);
  assert.deepEqual(res.body.orders.map((o: { orderNumber: string }) => o.orderNumber), [second.orderNumber, first.orderNumber]);
  const oldest = res.body.orders[1];
  assert.deepEqual(oldest.items, [{ productName: "Mug", quantity: 2 }]);
  assert.equal(oldest.total, 12);
  assert.equal(oldest.status, "paid");

  const serialized = JSON.stringify(res.body);
  for (const secret of ["ownerToken", "orderProofHash", "idempotencyKey", "guest-", "key-", "someone-else"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be exposed`);
  }
});

test("invalid ids and orders without a usable email return 404", async () => {
  const { business, id, headers } = await store();
  const bad = await seedOrder(business._id, { email: "not-an-email" });
  for (const customerId of ["abc", "zzzzzzzzzzzzzzzzzzzzzzzz", "%24where", String(bad._id)]) {
    assert.equal((await detail(id, customerId, headers)).status, 404, customerId);
  }
});

// ---------------------------------------------------------------------------
// Order-management deep link
// ---------------------------------------------------------------------------

test("order management can be filtered to one order of this business only", async () => {
  const a = await store();
  const b = await store();
  const target = await seedOrder(a.business._id, { email: "ada@example.com", status: "pending" });
  await seedOrder(a.business._id, { email: "other@example.com", status: "pending" });
  const bOrder = await seedOrder(b.business._id, { email: "x@example.com" });

  const call = async (query: string) => {
    const res = (await callHandler(
      ordersGET,
      request(`/api/businesses/${a.id}/manage/orders${query}`, a.headers),
      { params: Promise.resolve({ id: a.id }) },
    )) as Response;
    return { status: res.status, body: await res.json() };
  };

  const one = await call(`?order=${target.orderNumber}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.orders.map((o: { orderNumber: string }) => o.orderNumber), [target.orderNumber]);
  assert.equal((await call(`?order=${bOrder.orderNumber}`)).body.orders.length, 0, "another business's order is invisible");
  assert.equal((await call("?order=%24ne")).status, 400);
  assert.equal((await call("")).body.orders.length, 2, "unfiltered list unchanged");
});

// ---------------------------------------------------------------------------
// Review hardening
// ---------------------------------------------------------------------------

test("emails starting with $ are compared as literal values, never as field paths", async () => {
  const { business, id, headers } = await store();
  const first = await seedOrder(business._id, { email: "$x@y.z", total: 3 });
  await seedOrder(business._id, { email: "$X@y.z", total: 4 });
  await seedOrder(business._id, { email: "$$x@y.z", total: 5 });

  const res = await detail(id, String(first._id), headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.customer.email, "$x@y.z");
  assert.equal(res.body.orders.length, 2, "history is found (not an empty field-path match)");

  const other = await list(id, headers);
  assert.equal(other.status, 200);
  assert.deepEqual(other.body.customers.map((c: { email: string }) => c.email).sort(), ["$$x@y.z", "$x@y.z"]);
});

test("non-string, control-character and over-long emails are never merged and never crash", async () => {
  const { business, id, headers } = await store();
  await seedOrder(business._id, { email: "victim@example.com", total: 10 });
  const nul = await seedOrder(business._id, { email: "victim@example.com\u0000", total: 999 });
  await seedOrder(business._id, { email: "victim@example.com\u001f", total: 999 });
  await seedOrder(business._id, { email: 12345 });
  await seedOrder(business._id, { email: { $gt: "" } });
  await seedOrder(business._id, { email: `${"a".repeat(250)}@x.co` });

  const { status, body } = await list(id, headers);
  assert.equal(status, 200);
  assert.equal(body.total, 1);
  assert.deepEqual(body.customers[0].totals, [{ currency: "USD", paid: 10, pending: 0 }], "nothing merged into the victim");
  assert.equal(body.unidentifiedOrderCount, 5);
  assert.equal((await detail(id, String(nul._id), headers)).status, 404);
});

test("an empty currency falls back to the item currency, then the business currency", async () => {
  const { business, id, headers } = await store();
  await seedOrder(business._id, { email: "c@example.com", currency: "", items: [{ productName: "A", quantity: 1, unitPrice: 2, currency: "EUR" }], total: 2 });
  await seedOrder(business._id, { email: "c@example.com", currency: "", items: [], total: 3 });
  const { body } = await list(id, headers);
  assert.deepEqual(body.customers[0].totals, [
    { currency: "EUR", paid: 2, pending: 0 },
    { currency: "USD", paid: 3, pending: 0 },
  ]);
});

test("cross-tenant detail returns only the requesting business's orders and totals", async () => {
  const a = await store();
  const b = await store();
  const aOrder = await seedOrder(a.business._id, { email: "shared@example.com", total: 10 });
  await seedOrder(b.business._id, { email: "shared@example.com", total: 999 });
  await seedOrder(b.business._id, { email: "shared@example.com", total: 1 });

  const res = await detail(a.id, String(aOrder._id), a.headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.customer.orderCount, 1);
  assert.deepEqual(res.body.customer.totals, [{ currency: "USD", paid: 10, pending: 0 }]);
  assert.deepEqual(res.body.orders.map((o: { id: string }) => o.id), [String(aOrder._id)]);
});

test("super admins without membership are refused on detail and the order filter too", async () => {
  const { business, id } = await store();
  const order = await seedOrder(business._id, { email: "ada@example.com" });
  const admin = await createUser({ email: "cust-admin2@test.com", platformRole: "super_admin" });
  const adminHeaders = await headersFor(admin, "super_admin");
  assert.equal((await detail(id, String(order._id), adminHeaders)).status, 403);
  const res = (await callHandler(
    ordersGET,
    request(`/api/businesses/${id}/manage/orders?order=${order.orderNumber}`, adminHeaders),
    { params: Promise.resolve({ id }) },
  )) as Response;
  assert.equal(res.status, 403);
});

test("search text with control characters is rejected as invalid input", async () => {
  const { id, headers } = await store();
  assert.equal((await list(id, headers, "?q=%00")).status, 422);
  assert.equal((await list(id, headers, "?q=ab%1Fc")).status, 422);
});

test("expired unpaid reservations are released before totals are computed", async () => {
  const { business, id, headers } = await store();
  const product = await Product.create({
    business: business._id,
    name: "Mug",
    slug: `mug-${crypto.randomUUID().slice(0, 8)}`,
    price: 8,
    currency: "USD",
    stock: 0,
    status: "active",
  });
  const order = await seedOrder(business._id, {
    email: "late@example.com",
    status: "pending",
    total: 8,
    items: [{ productName: "Mug", quantity: 1, unitPrice: 8, currency: "USD" }],
  });
  await Order.collection.updateOne(
    { _id: order._id },
    {
      $set: {
        "items.0.product": String(product._id),
        inventoryState: "reserved",
        reservationExpiresAt: new Date(Date.now() - 60_000),
      },
    },
  );

  const { body } = await list(id, headers);
  assert.deepEqual(body.customers[0].totals, [{ currency: "USD", paid: 0, pending: 0 }]);
  assert.equal((await Order.findById(order._id).lean())?.status, "cancelled");
  assert.equal((await Product.findById(product._id).lean())?.stock, 1, "stock released");
});
