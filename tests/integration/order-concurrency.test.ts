/**
 * Phase B2.2.5 — order idempotency & transactional inventory audit.
 *
 * These tests drive the real POST /api/businesses/[id]/orders handler against
 * the replica-set test database. They assert database state (stock, order
 * count), not just HTTP shapes, so a unique index or an upsert alone cannot
 * make them pass:
 *
 *  - repeating a key must not decrement stock twice
 *  - concurrent same-key requests must yield ONE order and ONE decrement
 *  - two different keys competing for the last unit: exactly one wins
 *  - a multi-product failure rolls back every decrement, keeps the cart, and
 *    allows a safe retry with the same key
 *  - a key is scoped per business
 *  - a consumed cart cannot create a duplicate purchase, even without a key
 */
import "../helpers/env";

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { grantActiveFreePlan } from "./helpers/tenant";
import { POST as orderHandler } from "@/app/api/businesses/[id]/orders/route";
import { Product } from "@/models/Product";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { Business } from "@/models/Business";

const BIZ = "507f1f77bcf86cd799439011";
const BIZ2 = "507f1f77bcf86cd799439022";
const STORE_HOST = "test-store.localhost:3000";
const OTHER_HOST = "other-store.localhost:3000";

before(async () => {
  await startIntegrationSuite();
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
  await createStorefrontBusiness(BIZ, "test-store");
  await createStorefrontBusiness(BIZ2, "other-store");
});

async function createStorefrontBusiness(id: string, subdomain: string): Promise<void> {
  const business = new Business({
    name: `Store ${subdomain}`,
    subdomain,
    slug: subdomain,
    category: "retail",
    currency: "USD",
    status: "published",
    owner: new mongoose.Types.ObjectId(),
  });
  business._id = new mongoose.Types.ObjectId(id);
  await business.save();
  await grantActiveFreePlan(business._id);
}

/** Create an active product in a business. */
async function createProduct(
  businessId: string,
  overrides: { stock?: number; price?: number; status?: string; name?: string } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: businessId,
    name: overrides.name ?? `Widget ${suffix}`,
    slug: `widget-${suffix}`,
    description: "concurrency test product",
    price: overrides.price ?? 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `SKU-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 5,
    status: overrides.status ?? "active",
  });
}

/** Create a guest cart and return its owner token (the cart-token cookie). */
async function createCart(
  businessId: string,
  items: Array<{ product: mongoose.Types.ObjectId; quantity: number; price?: number }>,
): Promise<string> {
  const ownerToken = `tok-${crypto.randomUUID()}`;
  await Cart.create({
    business: businessId,
    ownerToken,
    items: items.map((item) => ({
      product: item.product,
      quantity: item.quantity,
      priceSnapshot: item.price ?? 10,
      currency: "USD",
    })),
    subtotal: 0,
    total: 0,
  });
  return ownerToken;
}

/** Build a form-urlencoded order request (the format the API documents). */
function makeRequest(
  businessId: string,
  opts: { ownerToken: string; idempotencyKey?: string },
): Request {
  const params = new URLSearchParams();
  params.set("customerName", "Concurrency Customer");
  params.set("customerEmail", "concurrency@example.com");
  if (opts.idempotencyKey) params.set("idempotencyKey", opts.idempotencyKey);

  return new Request(`http://localhost/api/businesses/${businessId}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
      "x-forwarded-for": "203.0.113.22",
      cookie: `cart-token=${opts.ownerToken}`,
    },
    body: params,
  });
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number }).stock;
}

async function orderCount(businessId = BIZ): Promise<number> {
  return Order.countDocuments({ business: businessId });
}

async function bodyOf(res: Response): Promise<any> {
  return res.json();
}

// ---------------------------------------------------------------------------
// Scenario 1 — sequential replay of the same key
// ---------------------------------------------------------------------------

test("same key replay returns the same order and decrements stock only once", async () => {
  const product = await createProduct(BIZ, { stock: 5, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 2, price: 10 }]);
  const key = `replay-${crypto.randomUUID()}`;

  const res1 = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));
  assert.strictEqual(res1.status, 200, "first request should succeed");
  const body1 = await bodyOf(res1);

  const res2 = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));
  assert.strictEqual(res2.status, 200, "replay should succeed");
  const body2 = await bodyOf(res2);

  assert.strictEqual(body1.orderNumber, body2.orderNumber, "replay must return the same order");
  assert.strictEqual(await stockOf(product._id), 3, "stock must be decremented exactly once (5 - 2)");
  assert.strictEqual(await orderCount(), 1, "replay must not create a second order");
});

test("same key replay never drives stock below zero", async () => {
  const product = await createProduct(BIZ, { stock: 1, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);
  const key = `replay-final-${crypto.randomUUID()}`;

  const res1 = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));
  assert.strictEqual(res1.status, 200);
  const body1 = await bodyOf(res1);

  const res2 = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));
  assert.strictEqual(res2.status, 200, "replay after sell-out must still return the order");
  const body2 = await bodyOf(res2);

  assert.strictEqual(body1.orderNumber, body2.orderNumber);
  assert.strictEqual(await stockOf(product._id), 0, "stock stays at 0, never negative");
  assert.strictEqual(await orderCount(), 1);
});

// ---------------------------------------------------------------------------
// Scenario 2 — concurrent requests with the same key
// ---------------------------------------------------------------------------

test("concurrent same-key requests create one order and one stock decrement", async () => {
  const product = await createProduct(BIZ, { stock: 5, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 2, price: 10 }]);
  const key = `concurrent-same-${crypto.randomUUID()}`;

  const [res1, res2] = await Promise.all([
    orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key })),
    orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key })),
  ]);

  assert.strictEqual(res1.status, 200, "first concurrent request should succeed");
  assert.strictEqual(res2.status, 200, "second concurrent request should replay the same order");

  const body1 = await bodyOf(res1);
  const body2 = await bodyOf(res2);
  assert.strictEqual(body1.orderNumber, body2.orderNumber, "both requests must see the same order");
  assert.strictEqual(await stockOf(product._id), 3, "stock must be decremented once (5 - 2)");
  assert.strictEqual(await orderCount(), 1, "exactly one order must exist");
});

test("concurrent same-key requests for the final unit do not oversell", async () => {
  const product = await createProduct(BIZ, { stock: 1, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);
  const key = `concurrent-final-${crypto.randomUUID()}`;

  const [res1, res2] = await Promise.all([
    orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key })),
    orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key })),
  ]);

  assert.strictEqual(res1.status, 200);
  assert.strictEqual(res2.status, 200);
  const body1 = await bodyOf(res1);
  const body2 = await bodyOf(res2);
  assert.strictEqual(body1.orderNumber, body2.orderNumber);
  assert.strictEqual(await stockOf(product._id), 0, "stock must not go negative");
  assert.strictEqual(await orderCount(), 1);
});

// ---------------------------------------------------------------------------
// Scenario 3 — different keys competing for the final unit
// ---------------------------------------------------------------------------

test("two different keys competing for the final unit: exactly one succeeds", async () => {
  const product = await createProduct(BIZ, { stock: 1, price: 10 });
  const tokenA = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);
  const tokenB = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);

  const [resA, resB] = await Promise.all([
    orderHandler(makeRequest(BIZ, { ownerToken: tokenA, idempotencyKey: `comp-a-${crypto.randomUUID()}` })),
    orderHandler(makeRequest(BIZ, { ownerToken: tokenB, idempotencyKey: `comp-b-${crypto.randomUUID()}` })),
  ]);

  const statuses = [resA.status, resB.status].sort();
  assert.deepStrictEqual(statuses, [200, 404], `exactly one must win, got ${statuses.join("/")}`);

  const loser = resA.status === 404 ? resA : resB;
  const loserBody = await bodyOf(loser);
  assert.strictEqual(loserBody.code, "out_of_stock", "the loser must be rejected as out_of_stock");

  assert.strictEqual(await stockOf(product._id), 0, "the last unit is sold once");
  assert.strictEqual(await orderCount(), 1, "only the winning order exists");
});

// ---------------------------------------------------------------------------
// Scenario 4 — multi-product failure rolls back every decrement
// ---------------------------------------------------------------------------

test("multi-product failure rolls back all decrements, keeps the cart, and allows a safe retry", async () => {
  const inStock = await createProduct(BIZ, { stock: 5, price: 10 });
  const soldOut = await createProduct(BIZ, { stock: 0, price: 10 });
  // In-stock product is first so a partial decrement happens before the failure.
  const ownerToken = await createCart(BIZ, [
    { product: inStock._id, quantity: 1, price: 10 },
    { product: soldOut._id, quantity: 1, price: 10 },
  ]);
  const cart = await Cart.findOne({ business: BIZ, ownerToken });
  assert.ok(cart, "cart should exist before the failed order");
  const key = `rollback-${crypto.randomUUID()}`;

  const res = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));

  assert.strictEqual(res.status, 404, "the order must be rejected");
  const body = await bodyOf(res);
  assert.strictEqual(body.code, "out_of_stock");

  assert.strictEqual(await stockOf(inStock._id), 5, "the first product's decrement must be rolled back");
  assert.strictEqual(await stockOf(soldOut._id), 0, "the sold-out product stays at 0");
  assert.strictEqual(await orderCount(), 0, "no partial order may be persisted");
  assert.ok(
    await Cart.findById(cart._id),
    "the cart must survive a failed transaction so the guest can retry",
  );

  // Restock and retry with the SAME key: the aborted claim must not block it.
  soldOut.stock = 1;
  await soldOut.save();

  const retry = await orderHandler(makeRequest(BIZ, { ownerToken, idempotencyKey: key }));
  assert.strictEqual(retry.status, 200, "retry after a rolled-back failure should succeed");
  const retryBody = await bodyOf(retry);
  assert.ok(retryBody.orderNumber, "retry should return an order");
  assert.ok(retryBody.orderProof, "a new keyed order should return its ownership proof");

  assert.strictEqual(await stockOf(inStock._id), 4, "retry decrements the first product once");
  assert.strictEqual(await stockOf(soldOut._id), 0, "retry decrements the restocked product once");
  assert.strictEqual(await orderCount(), 1, "exactly one order exists after the retry");
  assert.strictEqual(
    await Cart.countDocuments({ business: BIZ, ownerToken }),
    0,
    "the successful retry consumes the cart",
  );
});

// ---------------------------------------------------------------------------
// Scenario 5 — the same key is isolated per business
// ---------------------------------------------------------------------------

test("the same key used concurrently by two businesses creates two isolated orders", async () => {
  const productA = await createProduct(BIZ, { stock: 2, price: 10 });
  const productB = await createProduct(BIZ2, { stock: 2, price: 10 });
  const tokenA = await createCart(BIZ, [{ product: productA._id, quantity: 1, price: 10 }]);
  const tokenB = await createCart(BIZ2, [{ product: productB._id, quantity: 1, price: 10 }]);
  const sharedKey = `shared-${crypto.randomUUID()}`;

  const [resA, resB] = await Promise.all([
    orderHandler(makeRequest(BIZ, { ownerToken: tokenA, idempotencyKey: sharedKey })),
    orderHandler(makeRequest(BIZ2, { ownerToken: tokenB, idempotencyKey: sharedKey })),
  ]);

  assert.strictEqual(resA.status, 200);
  assert.strictEqual(resB.status, 200);
  const bodyA = await bodyOf(resA);
  const bodyB = await bodyOf(resB);

  assert.notStrictEqual(bodyA.orderNumber, bodyB.orderNumber, "the key must not leak across businesses");
  assert.strictEqual(await stockOf(productA._id), 1);
  assert.strictEqual(await stockOf(productB._id), 1);
  assert.strictEqual(await orderCount(BIZ), 1);
  assert.strictEqual(await orderCount(BIZ2), 1);
});

// ---------------------------------------------------------------------------
// Scenario 6 — a consumed cart cannot be used for a second purchase
// ---------------------------------------------------------------------------

test("a consumed cart cannot create a duplicate purchase without a key", async () => {
  const product = await createProduct(BIZ, { stock: 5, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);

  const res1 = await orderHandler(makeRequest(BIZ, { ownerToken }));
  assert.strictEqual(res1.status, 200, "first request should create an order");
  const body1 = await bodyOf(res1);
  assert.ok(body1.orderNumber);

  const res2 = await orderHandler(makeRequest(BIZ, { ownerToken }));
  assert.strictEqual(res2.status, 409, "a consumed cart must not create a second order");
  const body2 = await bodyOf(res2);
  assert.strictEqual(body2.code, "cart_conflict");
  assert.strictEqual(body2.orderNumber, undefined, "the rejection must not expose the first order");

  assert.strictEqual(await orderCount(), 1, "exactly one order exists");
  assert.strictEqual(await stockOf(product._id), 4, "stock is decremented exactly once");
  assert.strictEqual(
    await Cart.countDocuments({ business: BIZ, ownerToken }),
    0,
    "the cart is consumed by the successful order",
  );
});
