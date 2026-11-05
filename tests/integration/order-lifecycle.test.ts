/**
 * Phase B2.3.2 — order inventory lifecycle.
 *
 * These tests exercise the real transactional services and the real order
 * creation route. They assert database state, not just return values, so a
 * duplicate transition or a double stock restoration fails the suite.
 */
import "../helpers/env";

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite } from "./helpers/env";
import {
  clearAllCollections,
  connectTestDB,
  disconnectTestDB,
} from "./helpers/db";
import { grantActiveFreePlan } from "./helpers/tenant";
import { POST as orderHandler } from "@/app/api/businesses/[id]/orders/route";
import { Product } from "@/models/Product";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { Business } from "@/models/Business";
import {
  ORDER_RESERVATION_TTL_MS,
  cancelOrder,
  markOrderPaid,
  refundOrder,
  releaseExpiredOrders,
  releaseExpiredOrdersInternalGlobal,
} from "@/lib/orders/lifecycle";

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

async function createProduct(
  businessId = BIZ,
  overrides: { stock?: number; price?: number; currency?: string } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: businessId,
    name: `Lifecycle Widget ${suffix}`,
    slug: `lifecycle-widget-${suffix}`,
    description: "lifecycle test product",
    price: overrides.price ?? 10,
    currency: overrides.currency ?? "USD",
    imageUrl: "",
    images: [],
    sku: `LC-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 5,
    status: "active",
  });
}

async function createCart(
  businessId: string,
  items: Array<{
    product: mongoose.Types.ObjectId;
    quantity: number;
    price?: number;
    currency?: string;
  }>,
): Promise<string> {
  const ownerToken = `tok-${crypto.randomUUID()}`;
  await Cart.create({
    business: businessId,
    ownerToken,
    items: items.map((item) => ({
      product: item.product,
      quantity: item.quantity,
      priceSnapshot: item.price ?? 10,
      currency: item.currency ?? "USD",
    })),
    subtotal: 0,
    total: 0,
  });
  return ownerToken;
}

function makeRequest(
  businessId: string,
  opts: { ownerToken: string; idempotencyKey?: string },
): Request {
  const params = new URLSearchParams();
  params.set("customerName", "Lifecycle Customer");
  params.set("customerEmail", "lifecycle@example.com");
  if (opts.idempotencyKey) params.set("idempotencyKey", opts.idempotencyKey);

  return new Request(`http://localhost/api/businesses/${businessId}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
      "x-forwarded-for": "203.0.113.23",
      cookie: `cart-token=${opts.ownerToken}`,
    },
    body: params,
  });
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number }).stock;
}

async function placeOrder(
  overrides: {
    businessId?: string;
    stock?: number;
    quantity?: number;
    currency?: string;
  } = {},
) {
  const businessId = overrides.businessId ?? BIZ;
  const product = await createProduct(businessId, {
    stock: overrides.stock ?? 5,
    currency: overrides.currency ?? "USD",
  });
  const ownerToken = await createCart(businessId, [
    {
      product: product._id,
      quantity: overrides.quantity ?? 1,
      currency: overrides.currency ?? "USD",
    },
  ]);
  const key = `lifecycle-${crypto.randomUUID()}`;

  const res = await orderHandler(
    makeRequest(businessId, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(res.status, 200, "order creation should succeed");
  const body = await res.json();

  const order = await Order.findOne({ business: businessId, idempotencyKey: key });
  assert.ok(order, "order should be persisted");

  return { businessId, product, ownerToken, key, body, order };
}

async function setReservationExpiry(
  orderId: mongoose.Types.ObjectId | string,
  expiresAt: Date,
): Promise<void> {
  await Order.updateOne(
    { _id: orderId },
    { $set: { reservationExpiresAt: expiresAt } },
  );
}

async function currentOrder(orderId: mongoose.Types.ObjectId | string) {
  const order = await Order.findById(orderId);
  assert.ok(order, "order should still exist");
  return order;
}

// ---------------------------------------------------------------------------
// 1. Creation reserves stock once and records the 30-minute lifecycle window
// ---------------------------------------------------------------------------

test("creation reserves stock once and records lifecycle fields", async () => {
  const { product, key, order } = await placeOrder({ stock: 5, quantity: 2 });

  assert.strictEqual(order.status, "pending");
  assert.strictEqual(order.inventoryState, "reserved");
  assert.strictEqual(order.currency, "USD");
  assert.ok(order.reservationExpiresAt, "reservation expiry must be recorded");
  assert.strictEqual(order.paidAt, null);
  assert.strictEqual(order.cancelledAt, null);
  assert.strictEqual(order.refundedAt, null);
  assert.strictEqual(order.inventoryReleasedAt, null);
  assert.strictEqual(order.cancelReason, null);

  const createdAt = new Date(order.createdAt).getTime();
  const expiresAt = new Date(order.reservationExpiresAt).getTime();
  assert.ok(
    Math.abs(expiresAt - createdAt - ORDER_RESERVATION_TTL_MS) < 5000,
    "reservation should be 30 minutes from creation",
  );

  assert.strictEqual(await stockOf(product._id), 3, "stock is reserved exactly once");

  const replay = await orderHandler(
    makeRequest(BIZ, { ownerToken: order.ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(await stockOf(product._id), 3, "replay must not reserve twice");

  const afterReplay = await currentOrder(order._id);
  assert.strictEqual(
    new Date(afterReplay.reservationExpiresAt!).getTime(),
    expiresAt,
    "replay must not extend or replace the reservation window",
  );
});

test("mixed-currency orders are rejected before reserving stock", async () => {
  const usd = await createProduct(BIZ, { currency: "USD" });
  const eur = await createProduct(BIZ, { currency: "EUR" });
  const ownerToken = await createCart(BIZ, [
    { product: usd._id, quantity: 1, currency: "USD" },
    { product: eur._id, quantity: 1, currency: "EUR" },
  ]);

  const res = await orderHandler(
    makeRequest(BIZ, {
      ownerToken,
      idempotencyKey: `mixed-${crypto.randomUUID()}`,
    }),
  );

  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.code, "currency_mismatch");
  assert.strictEqual(await stockOf(usd._id), 5);
  assert.strictEqual(await stockOf(eur._id), 5);
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
});

test("keyless creation also records the reservation lifecycle", async () => {
  const product = await createProduct(BIZ, { stock: 5 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1 }]);

  const res = await orderHandler(makeRequest(BIZ, { ownerToken }));
  assert.strictEqual(res.status, 200);

  const order = await Order.findOne({ business: BIZ, ownerToken });
  assert.ok(order);
  assert.strictEqual(order.status, "pending");
  assert.strictEqual(order.inventoryState, "reserved");
  assert.strictEqual(order.currency, "USD");
  assert.ok(order.reservationExpiresAt);
  assert.strictEqual(await stockOf(product._id), 4);
});

// ---------------------------------------------------------------------------
// 2. Payment success is idempotent and does not touch stock
// ---------------------------------------------------------------------------

test("markOrderPaid transitions once and duplicate payment does nothing", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  assert.strictEqual(await stockOf(product._id), 4);

  const paid = await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(paid.applied, true);

  const afterPaid = await currentOrder(order._id);
  assert.strictEqual(afterPaid.status, "paid");
  assert.strictEqual(afterPaid.inventoryState, "consumed");
  assert.ok(afterPaid.paidAt, "paidAt must be recorded");
  assert.strictEqual(await stockOf(product._id), 4, "payment consumes the reservation without touching stock");

  const duplicate = await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(duplicate.applied, false);
  assert.strictEqual(duplicate.reason, "already_paid");

  const afterDuplicate = await currentOrder(order._id);
  assert.strictEqual(
    new Date(afterDuplicate.paidAt!).getTime(),
    new Date(afterPaid.paidAt!).getTime(),
    "duplicate payment must not rewrite paidAt",
  );
  assert.strictEqual(await stockOf(product._id), 4);
});

// ---------------------------------------------------------------------------
// 3. Payment after expiry is rejected; the order can then be released
// ---------------------------------------------------------------------------

test("payment after the reservation expires is rejected, then expiry releases stock", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  await setReservationExpiry(order._id, new Date(Date.now() - 60_000));

  const payment = await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(payment.applied, false);
  assert.strictEqual(payment.reason, "expired");

  const stillPending = await currentOrder(order._id);
  assert.strictEqual(stillPending.status, "pending");
  assert.strictEqual(stillPending.inventoryState, "reserved");
  assert.strictEqual(await stockOf(product._id), 4, "rejected payment must not change stock");

  const release = await releaseExpiredOrders({ businessId: BIZ, now: new Date() });
  assert.strictEqual(release.processed, 1);
  assert.strictEqual(release.released, 1);

  const cancelled = await currentOrder(order._id);
  assert.strictEqual(cancelled.status, "cancelled");
  assert.strictEqual(cancelled.inventoryState, "released");
  assert.strictEqual(cancelled.cancelReason, "expired");
  assert.ok(cancelled.cancelledAt);
  assert.ok(cancelled.inventoryReleasedAt);
  assert.strictEqual(await stockOf(product._id), 5, "expiry restores the reserved stock");

  const secondSweep = await releaseExpiredOrders({ businessId: BIZ, now: new Date() });
  assert.strictEqual(secondSweep.processed, 0, "a released order is no longer due");
  assert.strictEqual(await stockOf(product._id), 5, "expiry cannot restore stock twice");
});

// ---------------------------------------------------------------------------
// 4. Cancellation restores stock once; duplicates are no-ops
// ---------------------------------------------------------------------------

test("cancellation restores stock exactly once and blocks later payment", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  assert.strictEqual(await stockOf(product._id), 4);

  const cancelled = await cancelOrder({
    orderId: String(order._id),
    businessId: BIZ,
    reason: "customer",
  });
  assert.strictEqual(cancelled.applied, true);

  const afterCancel = await currentOrder(order._id);
  assert.strictEqual(afterCancel.status, "cancelled");
  assert.strictEqual(afterCancel.inventoryState, "released");
  assert.strictEqual(afterCancel.cancelReason, "customer");
  assert.ok(afterCancel.cancelledAt);
  assert.ok(afterCancel.inventoryReleasedAt);
  assert.strictEqual(await stockOf(product._id), 5);

  const duplicate = await cancelOrder({
    orderId: String(order._id),
    businessId: BIZ,
    reason: "admin",
  });
  assert.strictEqual(duplicate.applied, false);
  assert.strictEqual(duplicate.reason, "already_cancelled");
  assert.strictEqual(await stockOf(product._id), 5, "duplicate cancellation must not restock again");

  const latePayment = await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(latePayment.applied, false);
  assert.strictEqual(latePayment.reason, "not_pending");
  assert.strictEqual(await stockOf(product._id), 5);
});

test("concurrent duplicate transitions have a single winner", async () => {
  const paymentCase = await placeOrder({ stock: 5, quantity: 1 });
  const paymentAttempts = await Promise.all([
    markOrderPaid({ orderId: String(paymentCase.order._id), businessId: BIZ }),
    markOrderPaid({ orderId: String(paymentCase.order._id), businessId: BIZ }),
  ]);
  assert.strictEqual(
    paymentAttempts.filter((attempt) => attempt.applied).length,
    1,
    "only one duplicate payment may transition the order",
  );
  assert.strictEqual((await currentOrder(paymentCase.order._id)).status, "paid");
  assert.strictEqual(await stockOf(paymentCase.product._id), 4);

  const cancellationCase = await placeOrder({ stock: 5, quantity: 1 });
  const cancellationAttempts = await Promise.all([
    cancelOrder({ orderId: String(cancellationCase.order._id), businessId: BIZ, reason: "customer" }),
    cancelOrder({ orderId: String(cancellationCase.order._id), businessId: BIZ, reason: "admin" }),
  ]);
  assert.strictEqual(
    cancellationAttempts.filter((attempt) => attempt.applied).length,
    1,
    "only one duplicate cancellation may restore stock",
  );
  assert.strictEqual(
    (await currentOrder(cancellationCase.order._id)).status,
    "cancelled",
  );
  assert.strictEqual(await stockOf(cancellationCase.product._id), 5);
});

// ---------------------------------------------------------------------------
// 5. Expiry is bounded and skips legacy pending orders
// ---------------------------------------------------------------------------

test("expiry sweep is bounded and never releases legacy orders", async () => {
  const orders = [];
  for (let i = 0; i < 3; i += 1) {
    const placed = await placeOrder({ stock: 5, quantity: 1 });
    orders.push(placed);
  }

  const base = Date.now();
  await setReservationExpiry(orders[0].order._id, new Date(base - 30 * 60_000));
  await setReservationExpiry(orders[1].order._id, new Date(base - 20 * 60_000));
  await setReservationExpiry(orders[2].order._id, new Date(base - 10 * 60_000));

  const legacyProduct = await createProduct(BIZ, { stock: 5 });
  const legacy = await Order.create({
    business: BIZ,
    ownerToken: `legacy-${crypto.randomUUID()}`,
    customerName: "Legacy Customer",
    customerEmail: "legacy@example.com",
    items: [
      {
        product: legacyProduct._id,
        productName: legacyProduct.name,
        quantity: 1,
        unitPrice: legacyProduct.price,
        currency: legacyProduct.currency,
      },
    ],
    subtotal: 10,
    total: 10,
    status: "pending",
  });

  const firstSweep = await releaseExpiredOrders({ businessId: BIZ, limit: 2, now: new Date() });
  assert.strictEqual(firstSweep.processed, 2);
  assert.strictEqual(firstSweep.released, 2);

  assert.strictEqual((await currentOrder(orders[0].order._id)).status, "cancelled");
  assert.strictEqual((await currentOrder(orders[1].order._id)).status, "cancelled");
  assert.strictEqual((await currentOrder(orders[2].order._id)).status, "pending");
  assert.strictEqual(await stockOf(orders[0].product._id), 5);
  assert.strictEqual(await stockOf(orders[1].product._id), 5);
  assert.strictEqual(await stockOf(orders[2].product._id), 4);

  // A later, larger sweep releases the remaining due order but not the legacy
  // one, which has no lifecycle fields.
  const secondSweep = await releaseExpiredOrders({ businessId: BIZ, limit: 10, now: new Date() });
  assert.strictEqual(secondSweep.processed, 1);
  assert.strictEqual(secondSweep.released, 1);
  assert.strictEqual((await currentOrder(orders[2].order._id)).status, "cancelled");
  assert.strictEqual(await stockOf(orders[2].product._id), 5);

  const legacyAfter = await currentOrder(legacy._id);
  assert.strictEqual(legacyAfter.status, "pending");
  assert.strictEqual(legacyAfter.inventoryState, null);
  assert.strictEqual(await stockOf(legacyProduct._id), 5, "legacy stock must never be auto-released");

  const legacyCancel = await cancelOrder({
    orderId: String(legacy._id),
    businessId: BIZ,
    reason: "admin",
  });
  assert.strictEqual(legacyCancel.applied, false);
  assert.strictEqual(legacyCancel.reason, "legacy_order");
  assert.strictEqual(await stockOf(legacyProduct._id), 5);
});

// ---------------------------------------------------------------------------
// 6. Payment-versus-expiry race has exactly one winner
// ---------------------------------------------------------------------------

test("payment and expiry racing on the same order produce one consistent outcome", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  const paymentNow = new Date();
  const expiryNow = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const [payment, release] = await Promise.all([
    markOrderPaid({ orderId: String(order._id), businessId: BIZ, now: paymentNow }),
    releaseExpiredOrders({ businessId: BIZ, limit: 1, now: expiryNow }),
  ]);

  const final = await currentOrder(order._id);
  const winners = Number(payment.applied) + release.released;

  assert.strictEqual(winners, 1, "exactly one transition must win");

  if (payment.applied) {
    assert.strictEqual(final.status, "paid");
    assert.strictEqual(final.inventoryState, "consumed");
    assert.strictEqual(await stockOf(product._id), 4);
  } else {
    assert.strictEqual(final.status, "cancelled");
    assert.strictEqual(final.inventoryState, "released");
    assert.strictEqual(final.cancelReason, "expired");
    assert.strictEqual(await stockOf(product._id), 5);
  }
});

// ---------------------------------------------------------------------------
// 7. Cancellation-versus-payment race has exactly one winner
// ---------------------------------------------------------------------------

test("cancellation and payment racing on the same order produce one consistent outcome", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });

  const [payment, cancellation] = await Promise.all([
    markOrderPaid({ orderId: String(order._id), businessId: BIZ }),
    cancelOrder({ orderId: String(order._id), businessId: BIZ, reason: "customer" }),
  ]);

  const final = await currentOrder(order._id);
  const winners = Number(payment.applied) + Number(cancellation.applied);

  assert.strictEqual(winners, 1, "exactly one transition must win");

  if (payment.applied) {
    assert.strictEqual(final.status, "paid");
    assert.strictEqual(final.inventoryState, "consumed");
    assert.strictEqual(await stockOf(product._id), 4);
  } else {
    assert.strictEqual(final.status, "cancelled");
    assert.strictEqual(final.inventoryState, "released");
    assert.strictEqual(await stockOf(product._id), 5);
  }
});

// ---------------------------------------------------------------------------
// 8. Refunds change status only; stock is never restocked automatically
// ---------------------------------------------------------------------------

test("refund does not restock inventory and is idempotent", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(await stockOf(product._id), 4);

  const refunded = await refundOrder({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(refunded.applied, true);

  const afterRefund = await currentOrder(order._id);
  assert.strictEqual(afterRefund.status, "refunded");
  assert.strictEqual(afterRefund.inventoryState, "consumed");
  assert.ok(afterRefund.refundedAt);
  assert.strictEqual(await stockOf(product._id), 4, "refund must not automatically restock");

  const duplicate = await refundOrder({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(duplicate.applied, false);
  assert.strictEqual(duplicate.reason, "already_refunded");
  assert.strictEqual(await stockOf(product._id), 4);

  const payRefunded = await markOrderPaid({ orderId: String(order._id), businessId: BIZ });
  assert.strictEqual(payRefunded.applied, false);
  assert.strictEqual(payRefunded.reason, "not_pending");
  assert.strictEqual(await stockOf(product._id), 4);
});

// ---------------------------------------------------------------------------
// 9. Transaction rollback: a failed restock must undo the state transition
// ---------------------------------------------------------------------------

test("a failed restock rolls back the cancellation and earlier increments", async () => {
  const first = await createProduct(BIZ, { stock: 5 });
  const second = await createProduct(BIZ, { stock: 5 });
  const ownerToken = await createCart(BIZ, [
    { product: first._id, quantity: 1 },
    { product: second._id, quantity: 1 },
  ]);
  const key = `rollback-${crypto.randomUUID()}`;
  const res = await orderHandler(
    makeRequest(BIZ, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(res.status, 200);
  const order = await Order.findOne({ business: BIZ, idempotencyKey: key });
  assert.ok(order);
  assert.strictEqual(await stockOf(first._id), 4);
  assert.strictEqual(await stockOf(second._id), 4);

  // Force the second restoration to fail after the first one has already run.
  await Product.deleteOne({ _id: second._id });

  await assert.rejects(() =>
    cancelOrder({ orderId: String(order._id), businessId: BIZ, reason: "admin" }),
  );

  const unchanged = await currentOrder(order._id);
  assert.strictEqual(unchanged.status, "pending");
  assert.strictEqual(unchanged.inventoryState, "reserved");
  assert.strictEqual(unchanged.cancelReason, null);
  assert.strictEqual(unchanged.cancelledAt, null);
  assert.strictEqual(unchanged.inventoryReleasedAt, null);
  assert.strictEqual(await stockOf(first._id), 4, "the first increment must roll back");
});

// ---------------------------------------------------------------------------
// 10. Successful orders are isolated to their business during transitions
// ---------------------------------------------------------------------------

test("lifecycle transitions are scoped to the order's business", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });

  const wrongBusiness = await markOrderPaid({
    orderId: String(order._id),
    businessId: BIZ2,
  });
  assert.strictEqual(wrongBusiness.applied, false);
  assert.strictEqual(wrongBusiness.reason, "not_found");

  const stillPending = await currentOrder(order._id);
  assert.strictEqual(stillPending.status, "pending");
  assert.strictEqual(await stockOf(product._id), 4);

  const correctBusiness = await markOrderPaid({
    orderId: String(order._id),
    businessId: BIZ,
  });
  assert.strictEqual(correctBusiness.applied, true);
});

// ---------------------------------------------------------------------------
// 11. Corrupted quantities are rejected before pricing or reservation
// ---------------------------------------------------------------------------

test("corrupted cart quantities cannot create an order or mutate stock", async () => {
  const cases = [
    { label: "zero", quantity: 0 },
    { label: "negative", quantity: -2 },
    { label: "fractional", quantity: 1.5 },
  ];

  for (const bad of cases) {
    const product = await createProduct(BIZ, { stock: 5 });
    const ownerToken = await createCart(BIZ, [
      { product: product._id, quantity: 1 },
    ]);

    // Simulate a corrupted cart written outside normal schema validation.
    await Cart.updateOne(
      { business: BIZ, ownerToken },
      { $set: { "items.0.quantity": bad.quantity } },
    );

    const corrupted = await Cart.findOne({ business: BIZ, ownerToken });
    assert.ok(corrupted);
    assert.strictEqual(
      corrupted.items[0].quantity,
      bad.quantity,
      `${bad.label} quantity must be persisted for the test`,
    );

    const key = `bad-qty-${bad.label}-${crypto.randomUUID()}`;
    const res = await orderHandler(
      makeRequest(BIZ, { ownerToken, idempotencyKey: key }),
    );

    assert.strictEqual(res.status, 400, `${bad.label} quantity must be rejected`);
    const body = await res.json();
    assert.strictEqual(body.code, "invalid_quantity");
    assert.strictEqual(await stockOf(product._id), 5, "stock must not be reserved");
    assert.strictEqual(
      await Order.countDocuments({ business: BIZ, idempotencyKey: key }),
      0,
      "no order may be persisted",
    );
    assert.ok(
      await Cart.findOne({ business: BIZ, ownerToken }),
      "the cart must survive a rejected quantity",
    );
  }
});

// ---------------------------------------------------------------------------
// 12. Cart pricing snapshots are untrusted; product data is authoritative
// ---------------------------------------------------------------------------

test("tampered cart price and currency cannot override product data", async () => {
  const product = await createProduct(BIZ, {
    stock: 5,
    price: 12.5,
    currency: "EUR",
  });
  const ownerToken = await createCart(BIZ, [
    {
      product: product._id,
      quantity: 2,
      price: 0.01,
      currency: "USD",
    },
  ]);
  const key = `tampered-${crypto.randomUUID()}`;

  const res = await orderHandler(
    makeRequest(BIZ, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.subtotal, 25);
  assert.strictEqual(body.total, 25);
  assert.strictEqual(body.items[0].unitPrice, 12.5);
  assert.strictEqual(body.items[0].currency, "EUR");

  const order = await Order.findOne({ business: BIZ, idempotencyKey: key });
  assert.ok(order);
  assert.strictEqual(order.currency, "EUR");
  assert.strictEqual(order.subtotal, 25);
  assert.strictEqual(order.total, 25);
  assert.strictEqual(order.items[0].unitPrice, 12.5);
  assert.strictEqual(order.items[0].currency, "EUR");
  assert.strictEqual(await stockOf(product._id), 3);
});

// ---------------------------------------------------------------------------
// 13. Missing or malformed tenant scope is rejected without side effects
// ---------------------------------------------------------------------------

test("tenant transitions reject missing or invalid business scope", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });

  await assert.rejects(
    markOrderPaid({ orderId: String(order._id) } as any),
    (error: unknown) => {
      const e = error as { status?: number; code?: string };
      return e.status === 400 && e.code === "business_scope_required";
    },
  );
  await assert.rejects(
    cancelOrder({
      orderId: String(order._id),
      businessId: "not-an-object-id",
      reason: "customer",
    } as any),
    (error: unknown) => {
      const e = error as { status?: number; code?: string };
      return e.status === 400 && e.code === "invalid_id";
    },
  );
  await assert.rejects(
    refundOrder({ orderId: String(order._id) } as any),
    (error: unknown) => {
      const e = error as { status?: number; code?: string };
      return e.status === 400 && e.code === "business_scope_required";
    },
  );
  await assert.rejects(
    releaseExpiredOrders({} as any),
    (error: unknown) => {
      const e = error as { status?: number; code?: string };
      return e.status === 400 && e.code === "business_scope_required";
    },
  );

  const unchanged = await currentOrder(order._id);
  assert.strictEqual(unchanged.status, "pending");
  assert.strictEqual(unchanged.inventoryState, "reserved");
  assert.strictEqual(await stockOf(product._id), 4);
});

// ---------------------------------------------------------------------------
// 14. Wrong-business cancellation/refund leaves state and stock untouched
// ---------------------------------------------------------------------------

test("wrong-business cancellation and refund are non-mutating", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });

  const wrongCancel = await cancelOrder({
    orderId: String(order._id),
    businessId: BIZ2,
    reason: "admin",
  });
  assert.strictEqual(wrongCancel.applied, false);
  assert.strictEqual(wrongCancel.reason, "not_found");

  const afterCancel = await currentOrder(order._id);
  assert.strictEqual(afterCancel.status, "pending");
  assert.strictEqual(afterCancel.inventoryState, "reserved");
  assert.strictEqual(await stockOf(product._id), 4);

  const paid = await markOrderPaid({
    orderId: String(order._id),
    businessId: BIZ,
  });
  assert.strictEqual(paid.applied, true);

  const wrongRefund = await refundOrder({
    orderId: String(order._id),
    businessId: BIZ2,
  });
  assert.strictEqual(wrongRefund.applied, false);
  assert.strictEqual(wrongRefund.reason, "not_found");

  const afterRefund = await currentOrder(order._id);
  assert.strictEqual(afterRefund.status, "paid");
  assert.strictEqual(afterRefund.inventoryState, "consumed");
  assert.strictEqual(await stockOf(product._id), 4);
});

// ---------------------------------------------------------------------------
// 15. Expiry sweeps are tenant-scoped; the global sweep is explicit
// ---------------------------------------------------------------------------

test("business-scoped expiry releases only that business; global sweep is explicit", async () => {
  const local = await placeOrder({ businessId: BIZ, stock: 5 });
  const other = await placeOrder({ businessId: BIZ2, stock: 5 });
  const base = Date.now();
  await setReservationExpiry(local.order._id, new Date(base - 20 * 60_000));
  await setReservationExpiry(other.order._id, new Date(base - 10 * 60_000));

  const scoped = await releaseExpiredOrders({
    businessId: BIZ,
    now: new Date(),
    limit: 10,
  });
  assert.strictEqual(scoped.processed, 1);
  assert.strictEqual(scoped.released, 1);
  assert.strictEqual((await currentOrder(local.order._id)).status, "cancelled");
  assert.strictEqual(await stockOf(local.product._id), 5);

  const otherStillPending = await currentOrder(other.order._id);
  assert.strictEqual(otherStillPending.status, "pending");
  assert.strictEqual(otherStillPending.inventoryState, "reserved");
  assert.strictEqual(await stockOf(other.product._id), 4);

  const global = await releaseExpiredOrdersInternalGlobal({
    now: new Date(),
    limit: 10,
  });
  assert.strictEqual(global.processed, 1);
  assert.strictEqual(global.released, 1);
  assert.strictEqual((await currentOrder(other.order._id)).status, "cancelled");
  assert.strictEqual(await stockOf(other.product._id), 5);
});

// ---------------------------------------------------------------------------
// 16. One failed expiry release does not abort later candidates
// ---------------------------------------------------------------------------

test("expiry sweep isolates failures and rolls back the failed order", async () => {
  const first = await createProduct(BIZ, { stock: 5 });
  const second = await createProduct(BIZ, { stock: 5 });
  const ownerToken = await createCart(BIZ, [
    { product: first._id, quantity: 1 },
    { product: second._id, quantity: 1 },
  ]);
  const badKey = `expiry-bad-${crypto.randomUUID()}`;
  const badRes = await orderHandler(
    makeRequest(BIZ, { ownerToken, idempotencyKey: badKey }),
  );
  assert.strictEqual(badRes.status, 200);
  const badOrder = await Order.findOne({ business: BIZ, idempotencyKey: badKey });
  assert.ok(badOrder);
  assert.strictEqual(await stockOf(first._id), 4);
  assert.strictEqual(await stockOf(second._id), 4);

  // Force the second restoration to fail after the first increment has run.
  await Product.deleteOne({ _id: second._id });

  const good = await placeOrder({ businessId: BIZ, stock: 5 });
  const base = Date.now();
  await setReservationExpiry(badOrder._id, new Date(base - 20 * 60_000));
  await setReservationExpiry(good.order._id, new Date(base - 10 * 60_000));

  const sweep = await releaseExpiredOrders({
    businessId: BIZ,
    now: new Date(),
    limit: 10,
  });

  assert.strictEqual(sweep.processed, 2);
  assert.strictEqual(sweep.released, 1);
  assert.strictEqual(sweep.failed, 1);
  assert.strictEqual(sweep.skipped, 0);
  assert.strictEqual(sweep.failures.length, 1);
  assert.strictEqual(sweep.failures[0].orderId, String(badOrder._id));

  const badAfter = await currentOrder(badOrder._id);
  assert.strictEqual(badAfter.status, "pending");
  assert.strictEqual(badAfter.inventoryState, "reserved");
  assert.strictEqual(badAfter.cancelReason, null);
  assert.strictEqual(await stockOf(first._id), 4, "the first increment must roll back");

  const goodAfter = await currentOrder(good.order._id);
  assert.strictEqual(goodAfter.status, "cancelled");
  assert.strictEqual(goodAfter.inventoryState, "released");
  assert.strictEqual(await stockOf(good.product._id), 5);
});

// ---------------------------------------------------------------------------
// 17. Cancellation-versus-expiry race restores stock exactly once
// ---------------------------------------------------------------------------

test("cancellation and expiry racing restore stock exactly once", async () => {
  const { product, order } = await placeOrder({ stock: 5, quantity: 1 });
  await setReservationExpiry(order._id, new Date(Date.now() - 60_000));

  const [cancellation, sweep] = await Promise.all([
    cancelOrder({
      orderId: String(order._id),
      businessId: BIZ,
      reason: "customer",
    }),
    releaseExpiredOrders({ businessId: BIZ, now: new Date(), limit: 1 }),
  ]);

  const final = await currentOrder(order._id);
  const winners = Number(cancellation.applied) + sweep.released;

  assert.strictEqual(winners, 1, "exactly one transition must win");
  assert.strictEqual(final.status, "cancelled");
  assert.strictEqual(final.inventoryState, "released");
  assert.strictEqual(await stockOf(product._id), 5, "stock must be restored exactly once");

  if (cancellation.applied) {
    assert.strictEqual(final.cancelReason, "customer");
  } else {
    assert.strictEqual(final.cancelReason, "expired");
  }
});
