/**
 * Phase B2.4.2 — durable guest order ownership and read-only order status.
 *
 * These tests drive the real POST/GET route handlers against the replica-set
 * test database. They verify proof issuance for keyed and keyless orders,
 * header/cookie status retrieval, strict redaction, cross-tenant generic 404s,
 * order-read throttling, and safe proof rotation without extra stock changes.
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
import { GET as statusHandler } from "@/app/api/businesses/[id]/orders/[orderId]/route";
import { ORDER_READ_LIMIT, ORDER_READ_WINDOW_MS } from "@/lib/storefront-rate-limit";
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
    name: `Status Widget ${suffix}`,
    slug: `status-widget-${suffix}`,
    description: "status test product",
    price: overrides.price ?? 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `ST-${suffix}`,
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
  params.set("customerName", "Status Customer");
  params.set("customerEmail", "status@example.com");
  if (opts.idempotencyKey) params.set("idempotencyKey", opts.idempotencyKey);
  if (opts.proof && opts.proofInBody) params.set("orderProof", opts.proof);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
    "x-forwarded-for": opts.ip ?? "203.0.113.41",
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

async function getStatus(
  orderId: string,
  opts: Parameters<typeof makeStatusRequest>[1] = {},
  routeBusinessId = BIZ,
) {
  return statusHandler(
    makeStatusRequest(orderId, opts),
    statusContext(orderId, routeBusinessId),
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

function orderAccessSetCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${ORDER_ACCESS_COOKIE}=`));
}

async function bodyOf(response: Response): Promise<any> {
  return response.json();
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number } | null)?.stock ?? -1;
}

async function placeOrder(
  options: { keyed?: boolean; quantity?: number; stock?: number } = {},
) {
  const keyed = options.keyed ?? true;
  const product = await createProduct(BIZ, { stock: options.stock ?? 5, price: 10 });
  const ownerToken = await createCart(BIZ, [
    { product: product._id, quantity: options.quantity ?? 1, price: 10 },
  ]);
  const key = keyed ? `status-${crypto.randomUUID()}` : undefined;

  const response = await orderHandler(
    makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key }),
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

// ---------------------------------------------------------------------------
// Proof issuance
// ---------------------------------------------------------------------------

test("keyed creation returns a proof and a host-only order-access cookie", async () => {
  const { proof, orderAccessCookie, response, order } = await placeOrder();

  assert.match(proof, /^[A-Za-z0-9_-]{43}$/, "proof must be 32 bytes base64url");
  assert.strictEqual(orderAccessCookie, proof, "the cookie must carry the raw proof");

  const setCookie = orderAccessSetCookie(response);
  assert.ok(setCookie, "order-access must be emitted");
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i, "cookies must be host-only");

  assert.strictEqual(
    order.orderProofHash,
    hashOrderProof(proof),
    "only the SHA-256 digest is stored",
  );
  assert.notStrictEqual(order.orderProofHash, proof);

  const status = await getStatus(String(order._id), {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
  });
  assert.strictEqual(status.status, 200);
});

test("keyless creation also issues a usable proof and cookie", async () => {
  const { proof, orderAccessCookie, order } = await placeOrder({ keyed: false });

  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(orderAccessCookie, proof);
  assert.strictEqual(order.orderProofHash, hashOrderProof(proof));

  const byHeader = await getStatus(String(order._id), { proof });
  assert.strictEqual(byHeader.status, 200);

  const byCookie = await getStatus(String(order._id), {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
  });
  assert.strictEqual(byCookie.status, 200);
});

// ---------------------------------------------------------------------------
// Status retrieval
// ---------------------------------------------------------------------------

test("guest status retrieval works with the proof header", async () => {
  const { orderId, proof, body } = await placeOrder();

  const response = await getStatus(orderId, { proof });
  assert.strictEqual(response.status, 200);
  const statusBody = await bodyOf(response);

  assert.strictEqual(statusBody.orderId, orderId);
  assert.strictEqual(statusBody.orderNumber, body.orderNumber);
  assert.strictEqual(statusBody.status, "pending");
  assert.strictEqual(statusBody.currency, "USD");
  assert.strictEqual(statusBody.subtotal, 10);
  assert.strictEqual(statusBody.total, 10);
  assert.strictEqual(statusBody.customerName, "Status Customer");
  assert.strictEqual(statusBody.canCancel, true);
});

test("guest status retrieval works with the order-access cookie", async () => {
  const { orderId, proof, body } = await placeOrder();

  const response = await getStatus(orderId, {
    cookie: `${ORDER_ACCESS_COOKIE}=${proof}`,
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await bodyOf(response)).orderNumber, body.orderNumber);
});

test("the status response uses a strict guest-safe allowlist", async () => {
  const { orderId, proof } = await placeOrder({ quantity: 2 });

  const response = await getStatus(orderId, { proof });
  assert.strictEqual(response.status, 200);
  const statusBody = await bodyOf(response);

  assert.deepStrictEqual(
    Object.keys(statusBody).sort(),
    [
      "canCancel",
      "cancelReason",
      "cancelledAt",
      "createdAt",
      "currency",
      "customerName",
      "items",
      "orderId",
      "orderNumber",
      "paidAt",
      "paymentAttemptFailed",
      "paymentMethod",
      // Whether the order is tied to a customer account: a boolean, never the account.
      "placedAsGuest",
      "refundedAt",
      "refundedTotal",
      "taxInclusive",
      "taxLabel",
      "taxTotal",
      "reservationExpiresAt",
      "status",
      "subtotal",
      "total",
      // Price breakdown and fulfilment/tracking (guest-safe; no address).
      "discountCode",
      "discountTotal",
      "shippingTotal",
      "fulfillmentStatus",
      "tracking",
      "shippedAt",
      "deliveredAt",
    ].sort(),
  );
  // Phase 4B: the order's own payment method ("cod" or null); guest orders record none.
  assert.strictEqual(statusBody.paymentMethod, null);
  // This order has no customer account, and only that yes/no reaches the page.
  assert.strictEqual(statusBody.placedAsGuest, true);

  assert.strictEqual(statusBody.items.length, 1);
  assert.deepStrictEqual(
    Object.keys(statusBody.items[0]).sort(),
    ["currency", "product", "productName", "quantity", "unitPrice", "variantLabel"].sort(),
  );

  for (const forbidden of [
    "ownerToken",
    "orderProofHash",
    "idempotencyKey",
    "orderProof",
    "customer",
    "customerEmail",
    "shippingAddress",
    "inventoryState",
    "business",
    "businessId",
    "notes",
    "paymentIntentId",
    "providerEventId",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(statusBody, forbidden),
      false,
      `${forbidden} must never be exposed`,
    );
  }
  // Nor anywhere inside it: the shopper's email address is not on this page.
  assert.strictEqual(JSON.stringify(statusBody).includes("status@example.com"), false, "no email address in the response");

  assert.strictEqual(statusBody.reservationExpiresAt !== null, true);
  assert.strictEqual(statusBody.paidAt, null);
  assert.strictEqual(statusBody.cancelledAt, null);
  assert.strictEqual(statusBody.refundedAt, null);
  assert.strictEqual(statusBody.cancelReason, null);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

// ---------------------------------------------------------------------------
// Generic 404s / non-authority credentials
// ---------------------------------------------------------------------------

test("invalid proof returns a generic no-store 404", async () => {
  const { orderId } = await placeOrder();

  const response = await getStatus(orderId, {
    proof: crypto.randomBytes(32).toString("base64url"),
  });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const errorBody = await bodyOf(response);
  assert.strictEqual(errorBody.error, "Order not found");
  assert.equal(errorBody.orderNumber, undefined);
  assert.equal(errorBody.orderId, undefined);
});

test("order number alone is not authorization", async () => {
  const { orderId, body } = await placeOrder();

  const response = await getStatus(orderId, { proof: body.orderNumber });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.equal((await bodyOf(response)).orderNumber, undefined);
});

test("order id alone is not authorization", async () => {
  const { orderId } = await placeOrder();

  const response = await getStatus(orderId);
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

test("cart-token alone is not authorization for status retrieval", async () => {
  const { orderId, ownerToken } = await placeOrder();

  const response = await getStatus(orderId, {
    cookie: `cart-token=${ownerToken}`,
  });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
});

test("proof in a query parameter is never accepted", async () => {
  const { orderId, proof } = await placeOrder();

  const response = await getStatus(orderId, {
    query: `?orderProof=${encodeURIComponent(proof)}`,
  });
  assert.strictEqual(response.status, 404);
});

test("a malformed order id returns a generic no-store 404", async () => {
  const { proof } = await placeOrder();

  const response = await getStatus("not-a-valid-object-id", { proof });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.equal((await bodyOf(response)).orderId, undefined);
});

test("cross-tenant access returns a generic 404 without leaking the order", async () => {
  const { orderId, proof, body } = await placeOrder();

  const response = await getStatus(
    orderId,
    { host: OTHER_HOST, proof },
    BIZ2,
  );
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const errorBody = await bodyOf(response);
  assert.strictEqual(errorBody.error, "Order not found");
  assert.equal(errorBody.orderNumber, undefined);
  assert.notStrictEqual(errorBody.orderNumber, body.orderNumber);
});

test("the URL business id is not authoritative; the Host header is", async () => {
  const { orderId, proof, body } = await placeOrder();

  const response = await getStatus(orderId, { proof }, BIZ2);
  assert.strictEqual(
    response.status,
    200,
    "the host-resolved business must be used even when the URL id differs",
  );
  assert.strictEqual((await bodyOf(response)).orderNumber, body.orderNumber);
});

// ---------------------------------------------------------------------------
// Rate limiting and read-only behavior
// ---------------------------------------------------------------------------

/**
 * Rate-limit counters are fixed windows (`floor(now / windowMs)`). Sending
 * `limit + 1` requests while the clock crosses a window boundary splits the
 * count across two buckets and never produces the 429, which made this test
 * flaky under load (same root cause as tests/integration/cart-order-rate-limit).
 * Start only when the current window has comfortably more time left.
 */
async function waitForSafeOrderReadWindow(marginMs = 20_000): Promise<void> {
  for (;;) {
    const remaining = ORDER_READ_WINDOW_MS - (Date.now() % ORDER_READ_WINDOW_MS);
    if (remaining >= marginMs) return;
    await new Promise((resolve) => setTimeout(resolve, marginMs - remaining + 50));
  }
}

test("order reads are limited and a 429 does not mutate order or inventory", async () => {
  await waitForSafeOrderReadWindow();
  const { orderId, proof, product, order } = await placeOrder();
  const ip = "198.51.100.77";
  const before = await Order.findById(order._id).select(
    "+orderProofHash",
  );
  assert.ok(before);

  for (let i = 0; i < ORDER_READ_LIMIT; i += 1) {
    const allowed = await getStatus(orderId, { proof, ip });
    assert.strictEqual(allowed.status, 200, `read ${i + 1} should be allowed`);
  }

  const blocked = await getStatus(orderId, { proof, ip });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.headers.get("cache-control"), "no-store");
  assert.strictEqual((await bodyOf(blocked)).code, "rate_limited");
  const retryAfter = blocked.headers.get("retry-after");
  assert.ok(retryAfter);
  assert.ok(Number.isSafeInteger(Number(retryAfter)) && Number(retryAfter) >= 1);

  const after = await Order.findById(order._id).select("+orderProofHash");
  assert.ok(after);
  assert.strictEqual(after.status, before.status);
  assert.strictEqual(after.inventoryState, before.inventoryState);
  assert.strictEqual(
    after.reservationExpiresAt?.getTime(),
    before.reservationExpiresAt?.getTime(),
  );
  assert.strictEqual(after.orderProofHash, before.orderProofHash);
  assert.strictEqual(await stockOf(product._id), 4);

  // The bucket key must be HMAC-hashed, never the raw client IP.
  const counters = await RateLimit.find().lean();
  assert.ok(counters.length > 0);
  assert.ok(
    counters.every((counter) => !counter.key.includes(ip)),
    "raw client IPs must not be stored in rate-limit counters",
  );
});

// ---------------------------------------------------------------------------
// Idempotent replay and rotation
// ---------------------------------------------------------------------------

test("valid idempotent replay does not decrement stock or extend the reservation", async () => {
  const { orderId, key, ownerToken, proof, product, order } = await placeOrder({
    quantity: 2,
  });
  const reservationBefore = order.reservationExpiresAt?.getTime();
  const hashBefore = order.orderProofHash;

  const replay = await orderHandler(
    makeOrderRequest(BIZ, { idempotencyKey: key, proof }),
  );
  assert.strictEqual(replay.status, 200);
  const replayBody = await bodyOf(replay);
  assert.strictEqual(replayBody.orderProof, proof, "the valid proof is echoed, not rotated");

  const after = await Order.findById(order._id).select("+orderProofHash");
  assert.ok(after);
  assert.strictEqual(after.orderProofHash, hashBefore);
  assert.strictEqual(after.reservationExpiresAt?.getTime(), reservationBefore);
  assert.strictEqual(await stockOf(product._id), 3);

  const status = await getStatus(orderId, { proof });
  assert.strictEqual(status.status, 200);
});

test("cookie-authenticated replay with no proof rotates atomically and invalidates the old proof", async () => {
  const { orderId, key, ownerToken, proof: oldProof, product, order } =
    await placeOrder({ quantity: 2 });
  const reservationBefore = order.reservationExpiresAt?.getTime();

  const replay = await orderHandler(
    makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(replay.status, 200);
  const replayBody = await bodyOf(replay);
  const newProof = replayBody.orderProof as string;

  assert.match(newProof, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(newProof, oldProof);
  assert.strictEqual(
    cookieValue(replay, ORDER_ACCESS_COOKIE),
    newProof,
    "the replacement must be returned through order-access",
  );

  const after = await Order.findById(order._id).select("+orderProofHash");
  assert.ok(after);
  assert.strictEqual(after.orderProofHash, hashOrderProof(newProof));
  assert.strictEqual(after.reservationExpiresAt?.getTime(), reservationBefore);
  assert.strictEqual(await stockOf(product._id), 3);

  const oldStatus = await getStatus(orderId, { proof: oldProof });
  assert.strictEqual(oldStatus.status, 404, "the rotated-out proof must stop working");

  const newStatus = await getStatus(orderId, { proof: newProof });
  assert.strictEqual(newStatus.status, 200);
});

test("replaying with the replacement proof is stable and does not rotate again", async () => {
  const { orderId, key, ownerToken, product, order } = await placeOrder();
  const firstRotation = await orderHandler(
    makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key }),
  );
  const replacement = (await bodyOf(firstRotation)).orderProof as string;
  const hashAfterRotation = (
    await Order.findById(order._id).select("+orderProofHash")
  )?.orderProofHash;

  const replay = await orderHandler(
    makeOrderRequest(BIZ, { idempotencyKey: key, proof: replacement }),
  );
  assert.strictEqual(replay.status, 200);
  assert.strictEqual((await bodyOf(replay)).orderProof, replacement);

  const after = await Order.findById(order._id).select("+orderProofHash");
  assert.strictEqual(after?.orderProofHash, hashAfterRotation);
  assert.strictEqual(await stockOf(product._id), 4);
  assert.strictEqual((await getStatus(orderId, { proof: replacement })).status, 200);
});

test("concurrent cookie-only replays return a usable replacement without extra stock changes", async () => {
  const { orderId, key, ownerToken, product, order } = await placeOrder();
  const reservationBefore = order.reservationExpiresAt?.getTime();

  const [first, second] = await Promise.all([
    orderHandler(makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key })),
    orderHandler(makeOrderRequest(BIZ, { ownerToken, idempotencyKey: key })),
  ]);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);

  const firstBody = await bodyOf(first);
  const secondBody = await bodyOf(second);
  assert.strictEqual(firstBody.orderNumber, secondBody.orderNumber);

  const returnedProofs = [firstBody.orderProof, secondBody.orderProof].filter(
    (value): value is string => typeof value === "string",
  );
  assert.ok(returnedProofs.length >= 1, "one racing request must receive a proof");

  const after = await Order.findById(order._id).select("+orderProofHash");
  assert.ok(after);
  assert.strictEqual(after.reservationExpiresAt?.getTime(), reservationBefore);
  assert.strictEqual(await stockOf(product._id), 4);

  const matching = returnedProofs.filter(
    (proof) => after.orderProofHash === hashOrderProof(proof),
  );
  assert.ok(
    matching.length >= 1,
    "the persisted digest must match at least one returned replacement",
  );

  const status = await getStatus(orderId, { proof: matching[0] });
  assert.strictEqual(status.status, 200);
});
