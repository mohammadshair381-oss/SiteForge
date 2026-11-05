import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import type { Types } from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership } from "./helpers/tenant";
import { GET as listGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { PATCH as orderPATCH } from "@/app/api/businesses/[id]/manage/orders/[orderId]/route";
import { ORDER_RESERVATION_TTL_MS } from "@/lib/orders/lifecycle";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Owner/manager order management API: role and tenant isolation, allowlisted
 * output, and lifecycle transitions (mark paid, cancel with restock, refund).
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

type Headers = { cookie: string };

async function headersFor(user: { _id: Types.ObjectId; tokenVersion: number }): Promise<Headers> {
  return createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
}

async function setupStore() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  return { owner, business, id: String(business._id), headers: await headersFor(owner) };
}

/**
 * A reserved pending order. Defaults to an explicit cash-on-delivery order,
 * the only kind a business user may mark paid manually; pass
 * `paymentMethod: "online"` or `null` (legacy, no field) to test refusals.
 */
async function seedOrder(
  businessId: Types.ObjectId,
  options: {
    quantity?: number;
    expiresInMs?: number;
    status?: string;
    paymentMethod?: "online" | "cod" | null;
  } = {},
) {
  const quantity = options.quantity ?? 2;
  const product = await Product.create({
    business: businessId,
    name: "Mug",
    slug: `mug-${crypto.randomUUID().slice(0, 8)}`,
    price: 12,
    currency: "USD",
    stock: 10 - quantity,
    status: "active",
  });
  const order = await Order.create({
    business: businessId,
    ownerToken: `guest-${crypto.randomUUID()}`,
    idempotencyKey: `key-${crypto.randomUUID()}`,
    orderProofHash: "f".repeat(64),
    customerName: "Ada Shopper",
    customerEmail: "ada@example.com",
    items: [{ product: String(product._id), productName: "Mug", quantity, unitPrice: 12, currency: "USD" }],
    subtotal: 12 * quantity,
    total: 12 * quantity,
    currency: "USD",
    status: options.status ?? "pending",
    inventoryState: "reserved",
    reservationExpiresAt: new Date(Date.now() + (options.expiresInMs ?? ORDER_RESERVATION_TTL_MS)),
    ...(options.paymentMethod === null ? {} : { paymentMethod: options.paymentMethod ?? "cod" }),
  });
  return { product, order, orderId: String(order._id) };
}

async function list(id: string, headers: Headers, query = "") {
  const res = (await callHandler(
    listGET,
    new Request(`http://localhost/api/businesses/${id}/manage/orders${query}`, { headers }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { res, body: await res.json() };
}

async function act(id: string, orderId: string, action: string, headers: Headers) {
  const res = (await callHandler(
    orderPATCH,
    new Request(`http://localhost/api/businesses/${id}/manage/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id, orderId }) },
  )) as Response;
  return { res, body: await res.json() };
}

async function stockOf(productId: unknown): Promise<number> {
  return ((await Product.findById(productId).lean()) as { stock: number } | null)?.stock ?? -1;
}

test("owners list their orders without guest secrets", async () => {
  const { business, id, headers } = await setupStore();
  await seedOrder(business._id);

  const { res, body } = await list(id, headers);
  assert.equal(res.status, 200);
  assert.equal(body.orders.length, 1);
  const order = body.orders[0];
  assert.equal(order.customerEmail, "ada@example.com");
  assert.equal(order.total, 24);
  const serialized = JSON.stringify(body);
  for (const secret of ["ownerToken", "idempotencyKey", "orderProofHash", "guest-", "key-"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be exposed`);
  }
});

test("status filter works and rejects unknown values", async () => {
  const { business, id, headers } = await setupStore();
  await seedOrder(business._id);
  assert.equal((await list(id, headers, "?status=paid")).body.orders.length, 0);
  assert.equal((await list(id, headers, "?status=pending")).body.orders.length, 1);
  assert.equal((await list(id, headers, "?status=bogus")).res.status, 400);
});

test("managers can manage orders; staff and outsiders cannot", async () => {
  const { business, id } = await setupStore();
  const { orderId } = await seedOrder(business._id);

  const manager = await createUser({ email: "mgr-orders@example.com" });
  await createMembership(business._id, manager._id, "manager");
  const managerHeaders = await headersFor(manager);
  assert.equal((await list(id, managerHeaders)).res.status, 200);

  const staff = await createUser({ email: "staff-orders@example.com" });
  await createMembership(business._id, staff._id, "staff");
  const staffHeaders = await headersFor(staff);
  assert.equal((await list(id, staffHeaders)).res.status, 403);
  assert.equal((await act(id, orderId, "cancel", staffHeaders)).res.status, 403);

  const other = await setupStore();
  assert.equal((await list(id, other.headers)).res.status, 403);
  // Using their own business id with our order id: the order is invisible.
  assert.equal((await act(other.id, orderId, "cancel", other.headers)).res.status, 404);
  assert.equal((await list(other.id, other.headers)).body.orders.length, 0);

  assert.equal((await Order.findById(orderId).lean())?.status, "pending");

  assert.equal((await act(id, orderId, "mark_paid", managerHeaders)).res.status, 200);
});

test("mark paid, then refund; cancel restores stock exactly once", async () => {
  const { business, id, headers } = await setupStore();

  const paid = await seedOrder(business._id);
  const marked = await act(id, paid.orderId, "mark_paid", headers);
  assert.equal(marked.res.status, 200);
  assert.equal(marked.body.order.status, "paid");
  assert.ok(marked.body.order.paidAt);
  const again = await act(id, paid.orderId, "mark_paid", headers);
  assert.equal(again.res.status, 409);
  assert.equal(again.body.code, "already_paid");
  assert.equal((await act(id, paid.orderId, "cancel", headers)).res.status, 409, "paid orders are refunded, not cancelled");
  const refunded = await act(id, paid.orderId, "refund", headers);
  assert.equal(refunded.body.order.status, "refunded");
  assert.equal(await stockOf(paid.product._id), 8, "refund does not restock");

  const cancelled = await seedOrder(business._id, { quantity: 3 });
  const res = await act(id, cancelled.orderId, "cancel", headers);
  assert.equal(res.body.order.status, "cancelled");
  assert.equal(res.body.order.cancelReason, "admin");
  assert.equal(await stockOf(cancelled.product._id), 10);
  assert.equal((await act(id, cancelled.orderId, "cancel", headers)).res.status, 409);
  assert.equal(await stockOf(cancelled.product._id), 10, "no double restock");
});

test("an expired reservation cannot be marked paid and is released by the list", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId, product } = await seedOrder(business._id, { expiresInMs: -60_000 });

  const attempt = await act(id, orderId, "mark_paid", headers);
  assert.equal(attempt.res.status, 409);
  assert.equal(attempt.body.code, "expired");

  const { body } = await list(id, headers);
  assert.equal(body.orders[0].status, "cancelled");
  assert.equal(body.orders[0].cancelReason, "expired");
  assert.equal(await stockOf(product._id), 10);
});

test("invalid action and malformed ids are rejected", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId } = await seedOrder(business._id);
  assert.equal((await act(id, orderId, "ship", headers)).res.status, 422);
  assert.equal((await act(id, "not-an-id", "cancel", headers)).res.status, 404);
});

// ---------------------------------------------------------------------------
// Phase 1: manual payment confirmation is COD-only
// ---------------------------------------------------------------------------

test("an online order can never be marked paid manually and is left unchanged", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId, product } = await seedOrder(business._id, { paymentMethod: "online" });
  const before = await Order.findById(orderId).lean();

  const attempt = await act(id, orderId, "mark_paid", headers);
  assert.equal(attempt.res.status, 409);
  assert.equal(attempt.body.code, "manual_payment_not_allowed");

  const after = await Order.findById(orderId).lean();
  assert.equal(after?.status, "pending");
  assert.equal(after?.inventoryState, "reserved");
  assert.equal(after?.paidAt, null);
  assert.equal(String(after?.reservationExpiresAt), String(before?.reservationExpiresAt));
  assert.equal(await stockOf(product._id), 8, "the reservation still holds the stock");

  // The order can still be cancelled normally, restoring stock exactly once.
  const cancelled = await act(id, orderId, "cancel", headers);
  assert.equal(cancelled.body.order.status, "cancelled");
  assert.equal(await stockOf(product._id), 10);
});

test("a legacy order without a payment method is not assumed to be COD", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId } = await seedOrder(business._id, { paymentMethod: null });
  assert.equal((await Order.findById(orderId).lean())?.paymentMethod, undefined, "no default is written");

  const attempt = await act(id, orderId, "mark_paid", headers);
  assert.equal(attempt.res.status, 409);
  assert.equal(attempt.body.code, "manual_payment_not_allowed");
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");

  const { body } = await list(id, headers);
  assert.equal(body.orders[0].paymentMethod, null, "the dashboard shows no payment method");
});

test("a COD order is confirmed once; the view reports the payment method", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId, product } = await seedOrder(business._id, { paymentMethod: "cod", quantity: 3 });

  const marked = await act(id, orderId, "mark_paid", headers);
  assert.equal(marked.res.status, 200);
  assert.equal(marked.body.order.status, "paid");
  assert.equal(marked.body.order.paymentMethod, "cod");
  assert.equal(await stockOf(product._id), 7, "confirming consumes the reservation without restocking");

  const again = await act(id, orderId, "mark_paid", headers);
  assert.equal(again.res.status, 409);
  assert.equal(again.body.code, "already_paid");
});

test("a non-expiring COD reservation can be confirmed; staff and other tenants still cannot", async () => {
  const { business, id, headers } = await setupStore();
  const { orderId } = await seedOrder(business._id, { paymentMethod: "cod" });
  await Order.updateOne({ _id: orderId }, { $set: { reservationExpiresAt: null } });

  const staff = await createUser({ email: `cod-staff-${crypto.randomUUID()}@example.com` });
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await act(id, orderId, "mark_paid", await headersFor(staff))).res.status, 403);

  const other = await setupStore();
  assert.equal((await act(other.id, orderId, "mark_paid", other.headers)).res.status, 404);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");

  assert.equal((await act(id, orderId, "mark_paid", headers)).res.status, 200);
});
