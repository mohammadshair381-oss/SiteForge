/**
 * Phase B2.4.3 — secure guest order cancellation.
 *
 * These tests drive the real POST /api/businesses/[id]/orders/[orderId]/cancel
 * route handler against the replica-set test database. They verify proof-based
 * authorization, CSRF protection, cross-tenant isolation, lifecycle outcomes,
 * stock restoration, and rate limiting.
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
import { POST as cancelHandler } from "@/app/api/businesses/[id]/orders/[orderId]/cancel/route";
import { ORDER_CANCEL_LIMIT } from "@/lib/storefront-rate-limit";
import {
  ORDER_ACCESS_COOKIE,
  hashOrderProof,
} from "@/lib/orders/ownership";
import { Product } from "@/models/Product";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { Business } from "@/models/Business";
import { RateLimit } from "@/models/RateLimit";

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
  businessId: string,
  overrides: { stock?: number; price?: number } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: businessId,
    name: `Cancel Widget ${suffix}`,
    slug: `cancel-widget-${suffix}`,
    description: "cancellation test product",
    price: overrides.price ?? 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `CN-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 5,
    status: "active",
  });
}

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

function makeOrderRequest(
  businessId: string,
  opts: {
    ownerToken?: string | null;
    idempotencyKey?: string;
    proof?: string;
    proofInBody?: boolean;
    orderAccessProof?: string;
    ip?: string;
  } = {},
): Request {
  const params = new URLSearchParams();
  params.set("customerName", "Cancel Customer");
  params.set("customerEmail", "cancel@example.com");
  if (opts.idempotencyKey) params.set("idempotencyKey", opts.idempotencyKey);
  if (opts.proof && opts.proofInBody) params.set("orderProof", opts.proof);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
    "x-forwarded-for": opts.ip ?? "203.0.113.99",
  };

  const cookies: string[] = [];
  if (opts.ownerToken) cookies.push(`cart-token=${opts.ownerToken}`);
  if (opts.orderAccessProof) {
    cookies.push(`${ORDER_ACCESS_COOKIE}=${opts.orderAccessProof}`);
  }
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  if (opts.proof && !opts.proofInBody) headers["x-order-proof"] = opts.proof;

  return new Request(`http://localhost/api/businesses/${businessId}/orders`, {
    method: "POST",
    headers,
    body: params,
  });
}

function makeCancelRequest(
  orderId: string,
  opts: {
    host?: string;
    proof?: string;
    cookie?: string;
    reason?: string;
    origin?: string;
    referer?: string;
    ip?: string;
  } = {},
): Request {
  const host = opts.host ?? STORE_HOST;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host,
    "x-forwarded-for": opts.ip ?? "203.0.113.99",
  };
  if (opts.proof) headers["x-order-proof"] = opts.proof;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = opts.origin;
  if (opts.referer) headers.referer = opts.referer;

  const body = JSON.stringify({ reason: opts.reason ?? "customer" });

  return new Request(`http://${host}/api/businesses/${BIZ}/orders/${orderId}/cancel`, {
    method: "POST",
    headers,
    body,
  });
}

function cancelContext(orderId: string, routeBusinessId = BIZ) {
  return {
    params: Promise.resolve({ id: routeBusinessId, orderId }),
  };
}

function makeStatusRequest(
  orderId: string,
  opts: {
    host?: string;
    proof?: string;
    cookie?: string;
    query?: string;
    ip?: string;
  } = {},
): Request {
  const host = opts.host ?? STORE_HOST;
  const headers: Record<string, string> = { host };
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  if (opts.proof) headers["x-order-proof"] = opts.proof;
  if (opts.cookie) headers.cookie = opts.cookie;

  return new Request(
    `http://${host}/api/businesses/${BIZ}/orders/${orderId}${opts.query ?? ""}`,
    { method: "GET", headers },
  );
}

function statusContext(orderId: string, routeBusinessId = BIZ) {
  return {
    params: Promise.resolve({ id: routeBusinessId, orderId }),
  };
}

async function cancelOrder(
  orderId: string,
  opts: Parameters<typeof makeCancelRequest>[1] = {},
  routeBusinessId = BIZ,
) {
  return cancelHandler(
    makeCancelRequest(orderId, opts),
    cancelContext(orderId, routeBusinessId),
  );
}

function cookieValue(response: Response, name: string): string | null {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.slice(name.length + 1).split(";")[0] || null;
    }
  }
  return null;
}

async function bodyOf(response: Response): Promise<any> {
  return response.json();
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number } | null)?.stock ?? -1;
}

async function placeOrder(
  options: { keyed?: boolean; quantity?: number; stock?: number; ip?: string } = {},
) {
  const keyed = options.keyed ?? true;
  const product = await createProduct(BIZ, { stock: options.stock ?? 5, price: 10 });
  const ownerToken = await createCart(BIZ, [
    { product: product._id, quantity: options.quantity ?? 1, price: 10 },
  ]);
  const key = keyed ? `cancel-${crypto.randomUUID()}` : undefined;

  const response = await orderHandler(
    makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key, ip: options.ip }),
  );
  assert.strictEqual(response.status, 200, "initial order creation should succeed");
  const body = await bodyOf(response);
  const order = await Order.findOne({ business: BIZ, ownerToken }).select(
    "+orderProofHash",
  );
  assert.ok(order, "the created order should exist");

  return {
    product,
    ownerToken,
    key,
    response,
    body,
    order,
    orderId: String(order._id),
    proof: body.orderProof as string,
    orderAccessCookie: cookieValue(response, ORDER_ACCESS_COOKIE),
  };
}

async function markOrderPaid(
  orderId: string,
  businessId = BIZ,
) {
  const { cancelOrder: lifecycleCancelOrder } = await import("@/lib/orders/lifecycle");
  // Use markOrderPaid to transition to paid state for tests
  const { markOrderPaid } = await import("@/lib/orders/lifecycle");
  return markOrderPaid({ orderId, businessId });
}

// ---------------------------------------------------------------------------
// Authorization and proof
// ---------------------------------------------------------------------------

test("valid proof-header cancellation succeeds and restores stock", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });
  const stockBefore = await stockOf(product._id);

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 200);
  const body = await bodyOf(response);
  assert.strictEqual(body.status, "cancelled");
  assert.strictEqual(body.cancelReason, "customer");
  assert.ok(body.cancelledAt);

  assert.strictEqual(await stockOf(product._id), stockBefore + 2, "stock restored exactly once");
});

test("valid order-access cookie cancellation succeeds", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
    origin: `https://${STORE_HOST}`,
  });
  assert.strictEqual(response.status, 200);
  const body = await bodyOf(response);
  assert.strictEqual(body.status, "cancelled");
});

test("missing proof is rejected with generic 404", async () => {
  const { orderId } = await placeOrder();

  const response = await cancelOrder(orderId);
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.equal((await bodyOf(response)).error, "Order not found");
});

test("invalid proof is rejected with generic 404", async () => {
  const { orderId } = await placeOrder();

  const response = await cancelOrder(orderId, {
    proof: crypto.randomBytes(32).toString("base64url"),
  });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

test("order number alone cannot authorize cancellation", async () => {
  const { orderId, body } = await placeOrder();

  const response = await cancelOrder(orderId, { proof: body.orderNumber });
  assert.strictEqual(response.status, 404);
  assert.equal((await bodyOf(response)).orderNumber, undefined);
});

test("order id alone cannot authorize cancellation", async () => {
  const { orderId } = await placeOrder();

  const response = await cancelOrder(orderId);
  assert.strictEqual(response.status, 404);
});

test("cart-token alone cannot authorize cancellation", async () => {
  const { orderId, ownerToken } = await placeOrder();

  const response = await cancelOrder(orderId, {
    cookie: `cart-token=${ownerToken}`,
  });
  assert.strictEqual(response.status, 404);
});

test("cross-tenant cancellation is rejected without leaking order existence", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, { host: OTHER_HOST, proof }, BIZ2);
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.equal((await bodyOf(response)).error, "Order not found");
});

test("URL business id is not authoritative; Host header is used", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, { proof }, BIZ2);
  assert.strictEqual(response.status, 200, "host-resolved business must be used");
  assert.strictEqual((await bodyOf(response)).status, "cancelled");
});

// ---------------------------------------------------------------------------
// CSRF / same-origin protection for cookie-authenticated requests
// ---------------------------------------------------------------------------

test("cookie-authenticated request from different origin is rejected", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
    origin: "https://evil.example.com",
  });
  assert.strictEqual(response.status, 403);
  assert.strictEqual((await bodyOf(response)).code, "csrf_failed");
});

test("cookie-authenticated request with mismatched referer is rejected", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
    referer: "https://evil.example.com/page",
  });
  assert.strictEqual(response.status, 403);
  assert.strictEqual((await bodyOf(response)).code, "csrf_failed");
});

test("cookie-authenticated request with matching origin succeeds", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
    origin: `https://${STORE_HOST}`,
  });
  assert.strictEqual(response.status, 200);
});

test("header-authenticated request does not require Origin/Referer", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 200);
});

// ---------------------------------------------------------------------------
// Lifecycle outcomes and stock restoration
// ---------------------------------------------------------------------------

test("paid orders cannot be cancelled by guests", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });
  await markOrderPaid(orderId);

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 404, "paid orders appear as not found to guests");
  assert.strictEqual(await stockOf(product._id), 3, "stock not restored for paid order");
});

test("already-cancelled order does not restore stock twice", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });
  const stockBeforeFirst = await stockOf(product._id);

  await cancelOrder(orderId, { proof });
  const stockAfterFirst = await stockOf(product._id);
  assert.strictEqual(stockAfterFirst, stockBeforeFirst + 2, "stock restored on first cancellation");

  const secondResponse = await cancelOrder(orderId, { proof });
  assert.strictEqual(secondResponse.status, 200, "idempotent cancellation returns success");
  const secondBody = await bodyOf(secondResponse);
  assert.strictEqual(secondBody.status, "cancelled");

  const stockAfterSecond = await stockOf(product._id);
  assert.strictEqual(stockAfterSecond, stockAfterFirst, "stock not restored on second cancellation");
});

test("expired reservation with reserved inventoryState is still cancellable by guest", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });
  const stockBefore = await stockOf(product._id);

  // Expire the reservation by setting reservationExpiresAt in the past
  // but keep inventoryState as "reserved" (which is the initial state)
  const order = await Order.findById(orderId);
  assert.ok(order);
  order.reservationExpiresAt = new Date(Date.now() - 1000);
  await order.save();

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 200, "expired reservation with reserved state is cancellable");
  assert.strictEqual(await stockOf(product._id), stockBefore + 2, "stock restored");
});

test("legacy order without inventoryState is not cancellable", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });

  // Remove inventoryState to simulate a legacy order
  await Order.findByIdAndUpdate(orderId, { $unset: { inventoryState: "" } });

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 404, "legacy orders appear as not found");
  assert.strictEqual(await stockOf(product._id), 3, "stock not restored for legacy order");
});

test("cancellation reason is echoed in response", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, { proof, reason: "customer" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await bodyOf(response)).cancelReason, "customer");
});

test("unknown cancellation reason defaults to customer", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await cancelOrder(orderId, { proof, reason: "invalid_reason" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await bodyOf(response)).cancelReason, "customer");
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

test("cancellation rate limit is enforced and fails closed", async () => {
  const ip = "198.51.100.55";

  // Make ORDER_CANCEL_LIMIT successful cancellations using different IPs
  // for the order creation to avoid hitting the order creation rate limit.
  for (let i = 0; i < ORDER_CANCEL_LIMIT; i += 1) {
    const createIp = `198.51.100.${100 + i}`;
    const { orderId: newOrderId, proof: newProof } = await placeOrder({
      quantity: 1,
      ip: createIp,
    });
    const allowed = await cancelOrder(newOrderId, { proof: newProof, ip });
    assert.strictEqual(allowed.status, 200, `cancellation ${i + 1} should be allowed`);
  }

  const { orderId: blockedOrderId, proof: blockedProof } = await placeOrder({ quantity: 1 });
  const blocked = await cancelOrder(blockedOrderId, { proof: blockedProof, ip });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.headers.get("cache-control"), "no-store");
  assert.strictEqual((await bodyOf(blocked)).code, "rate_limited");
  const retryAfter = blocked.headers.get("retry-after");
  assert.ok(retryAfter);
  assert.ok(Number.isSafeInteger(Number(retryAfter)) && Number(retryAfter) >= 1);

  // Bucket key must be HMAC-hashed, never raw IP.
  const counters = await RateLimit.find().lean();
  assert.ok(counters.length > 0);
  assert.ok(
    counters.every((counter) => !counter.key.includes(ip)),
    "raw client IPs must not be stored in rate-limit counters",
  );
});

// ---------------------------------------------------------------------------
// Response shape and headers
// ---------------------------------------------------------------------------

test("successful cancellation response includes only allowed fields", async () => {
  const { orderId, proof, order } = await placeOrder();

  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 200);
  const body = await bodyOf(response);

  assert.deepStrictEqual(
    Object.keys(body).sort(),
    ["cancelledAt", "cancelReason", "orderId", "orderNumber", "status"].sort(),
  );
  assert.strictEqual(body.status, "cancelled");
  assert.strictEqual(body.orderId, orderId);
  assert.strictEqual(body.orderNumber, order.orderNumber);
  assert.strictEqual(body.cancelReason, "customer");
  assert.ok(body.cancelledAt);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

test("error responses are non-cacheable", async () => {
  const { orderId } = await placeOrder();

  const response = await cancelOrder(orderId);
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

test("rate limited response is non-cacheable", async () => {
  const ip = "198.51.100.77";

  // Exhaust the limit
  for (let i = 0; i < ORDER_CANCEL_LIMIT; i += 1) {
    const createIp = `198.51.100.${200 + i}`;
    const { orderId: newOrderId, proof: newProof } = await placeOrder({
      quantity: 1,
      ip: createIp,
    });
    await cancelOrder(newOrderId, { proof: newProof, ip });
  }

  const { orderId: blockedOrderId, proof: blockedProof } = await placeOrder({ quantity: 1 });
  const blocked = await cancelOrder(blockedOrderId, { proof: blockedProof, ip });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.headers.get("cache-control"), "no-store");
});

// ---------------------------------------------------------------------------
// Order state after cancellation
// ---------------------------------------------------------------------------

test("cancelled order status endpoint reflects cancellation", async () => {
  const { orderId, proof } = await placeOrder();

  await cancelOrder(orderId, { proof });

  const { GET: statusHandler } = await import("@/app/api/businesses/[id]/orders/[orderId]/route");
  const statusResponse = await statusHandler(
    makeStatusRequest(orderId, { proof }),
    statusContext(orderId),
  );
  assert.strictEqual(statusResponse.status, 200);
  const statusBody = await bodyOf(statusResponse);
  assert.strictEqual(statusBody.status, "cancelled");
  assert.strictEqual(statusBody.cancelReason, "customer");
  assert.ok(statusBody.cancelledAt);
});

test("cancellation does not affect other orders or businesses", async () => {
  const { orderId: orderId1, proof: proof1, product: product1 } = await placeOrder({ quantity: 2 });
  const { orderId: orderId2, proof: proof2, product: product2 } = await placeOrder({ quantity: 1 });

  await cancelOrder(orderId1, { proof: proof1 });

  // order1: initial stock 5, quantity 2 -> after order: 3, after cancel: 5
  // order2: initial stock 5, quantity 1 -> after order: 4
  assert.strictEqual(await stockOf(product1._id), 5, "first order's stock restored");
  assert.strictEqual(await stockOf(product2._id), 4, "second order's stock untouched");

  const { GET: statusHandler } = await import("@/app/api/businesses/[id]/orders/[orderId]/route");
  const status2 = await statusHandler(
    makeStatusRequest(orderId2, { proof: proof2 }),
    statusContext(orderId2),
  );
  assert.strictEqual(status2.status, 200);
  assert.strictEqual((await bodyOf(status2)).status, "pending");
});
// ---------------------------------------------------------------------------
// Phase 4 commerce hardening
// ---------------------------------------------------------------------------

test("a guest cannot forge the cancellation reason", async () => {
  for (const reason of ["admin", "payment_failed"]) {
    const { orderId, proof } = await placeOrder();
    const response = await cancelOrder(orderId, { proof, reason });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await bodyOf(response)).cancelReason, "customer");
    const stored = await Order.findById(orderId).lean();
    assert.strictEqual((stored as { cancelReason?: string } | null)?.cancelReason, "customer");
  }
});

test("cookie cancellation accepts a same-host http origin outside production only", async () => {
  const { orderId, proof } = await placeOrder();
  const response = await cancelOrder(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
    origin: `http://${STORE_HOST}`,
  });
  assert.strictEqual(response.status, 200, "local http dev can cancel");

  const other = await placeOrder();
  const crossSite = await cancelOrder(other.orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${other.proof}`,
    origin: "http://evil.example.com",
  });
  assert.strictEqual(crossSite.status, 403, "a foreign origin is still rejected");
});

test("an unpublished or unentitled store cannot take orders", async () => {
  const product = await createProduct(BIZ, { stock: 5 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1 }]);

  await Business.updateOne({ _id: BIZ }, { $set: { status: "draft" } });
  const draft = await orderHandler(makeOrderRequest(BIZ, { ownerToken }));
  assert.strictEqual(draft.status, 404);

  await Business.updateOne({ _id: BIZ }, { $set: { status: "published" } });
  const { Subscription } = await import("@/models/Subscription");
  await Subscription.updateMany({ business: BIZ }, { $set: { status: "past_due" } });
  const lapsed = await orderHandler(makeOrderRequest(BIZ, { ownerToken }));
  assert.strictEqual(lapsed.status, 404);

  assert.strictEqual(await stockOf(product._id), 5, "no stock was reserved");
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
});

test("an existing order stays viewable and cancellable after the store goes offline", async () => {
  const { orderId, proof, product } = await placeOrder({ quantity: 2 });
  await Business.updateOne({ _id: BIZ }, { $set: { status: "draft" } });
  const stockBefore = await stockOf(product._id);
  const response = await cancelOrder(orderId, { proof });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(await stockOf(product._id), stockBefore + 2);
});

test("invalid customer details are rejected with 400 before any stock moves", async () => {
  const product = await createProduct(BIZ, { stock: 5 });
  const cases: Array<[string, string, string]> = [
    ["x".repeat(101), "ok@example.com", "invalid_customer_name"],
    ["Valid Name", "not-an-email", "invalid_customer_email"],
    ["Valid Name", `${"a".repeat(250)}@example.com`, "invalid_customer_email"],
  ];
  for (const [name, email, code] of cases) {
    for (const keyed of [false, true]) {
      const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1 }]);
      const params = new URLSearchParams({ customerName: name, customerEmail: email });
      if (keyed) params.set("idempotencyKey", `val-${crypto.randomUUID()}`);
      const response = await orderHandler(
        new Request(`http://localhost/api/businesses/${BIZ}/orders`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            host: STORE_HOST,
            cookie: `cart-token=${ownerToken}`,
          },
          body: params,
        }),
      );
      assert.strictEqual(response.status, 400, `${code} (keyed=${keyed})`);
      assert.strictEqual((await bodyOf(response)).code, code);
    }
  }
  assert.strictEqual(await stockOf(product._id), 5);
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
});

test("placing an order releases this store's expired reservations first", async () => {
  const stale = await placeOrder({ quantity: 3, stock: 3 });
  assert.strictEqual(await stockOf(stale.product._id), 0, "stock fully reserved");
  await Order.updateOne(
    { _id: stale.orderId },
    { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
  );

  const ownerToken = await createCart(BIZ, [{ product: stale.product._id, quantity: 2 }]);
  const response = await orderHandler(makeOrderRequest(BIZ, { ownerToken }));
  assert.strictEqual(response.status, 200, "the expired reservation no longer blocks a new order");

  const released = await Order.findById(stale.orderId).lean();
  assert.strictEqual((released as { status?: string } | null)?.status, "cancelled");
  assert.strictEqual(await stockOf(stale.product._id), 1, "3 released, then 2 reserved");
});

test("a null JSON cancel body is handled as a normal customer cancellation, not a 500", async () => {
  const { orderId, proof } = await placeOrder();
  const response = await cancelHandler(
    new Request(`http://${STORE_HOST}/api/businesses/${BIZ}/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", host: STORE_HOST, "x-order-proof": proof },
      body: "null",
    }),
    cancelContext(orderId),
  );
  assert.notStrictEqual(response.status, 500);
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await bodyOf(response)).cancelReason, "customer");
});

test("non-string customer fields in JSON are rejected, not stringified", async () => {
  const product = await createProduct(BIZ, { stock: 5 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 1 }]);
  const response = await orderHandler(
    new Request(`http://localhost/api/businesses/${BIZ}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", host: STORE_HOST, cookie: `cart-token=${ownerToken}` },
      body: JSON.stringify({ customerName: { first: "x" }, customerEmail: ["a@b.co"] }),
    }),
  );
  assert.strictEqual(response.status, 400);
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
});
