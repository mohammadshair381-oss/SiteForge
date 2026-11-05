/**
 * Phase B2.3.6 — abuse protection for the public guest cart and order APIs.
 *
 * These tests drive the real route handlers against the replica-set test
 * database. They verify the chosen limits, tenant/IP scoping, spoofed-header
 * handling and that a rejected request does not mutate carts, stock or orders.
 */
import "../helpers/env";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import test, { after, before, beforeEach } from "node:test";

import {
  getTestMongoUri,
  startIntegrationSuite,
  stopIntegrationSuite,
} from "./helpers/env";
import {
  clearAllCollections,
  connectTestDB,
  disconnectTestDB,
} from "./helpers/db";
import { grantActiveFreePlan } from "./helpers/tenant";
import {
  GET as cartGetHandler,
  POST as cartPostHandler,
} from "@/app/api/businesses/[id]/cart/route";
import { POST as orderPostHandler } from "@/app/api/businesses/[id]/orders/route";
import {
  CART_READ_LIMIT,
  CART_READ_WINDOW_MS,
  CART_WRITE_LIMIT,
  CART_WRITE_WINDOW_MS,
  ORDER_CREATE_LIMIT,
  ORDER_CREATE_WINDOW_MS,
} from "@/lib/storefront-rate-limit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { Business } from "@/models/Business";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";
import { RateLimit } from "@/models/RateLimit";

const BIZ = "507f1f77bcf86cd799439011";
const BIZ2 = "507f1f77bcf86cd799439022";
const HOST = "test-store.localhost:3000";
const OTHER_HOST = "other-store.localhost:3000";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (
    !uri.startsWith("mongodb://127.0.0.1:") &&
    !uri.startsWith("mongodb://localhost:")
  ) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

/**
 * Rate-limit counters are fixed-window buckets (`floor(now / windowMs)`), so a
 * test that sends `limit + 1` requests while the wall clock crosses a window
 * boundary splits its count across two buckets and never sees the 429. That was
 * the cause of an intermittent "200 !== 429" failure in the full suite (more
 * likely when the machine is loaded and a test runs longer). The limiter itself
 * is correct; to keep these tests deterministic we start each one only when
 * every window in use has comfortably more time left than a test needs.
 */
const WINDOW_SAFETY_MARGIN_MS = 20_000;
const RATE_LIMIT_WINDOWS_MS = [
  CART_READ_WINDOW_MS,
  CART_WRITE_WINDOW_MS,
  ORDER_CREATE_WINDOW_MS,
];

async function waitForSafeRateLimitWindow(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const shortestRemaining = Math.min(
      ...RATE_LIMIT_WINDOWS_MS.map((windowMs) => windowMs - (now % windowMs)),
    );
    if (shortestRemaining >= WINDOW_SAFETY_MARGIN_MS) return;
    await new Promise((resolve) =>
      setTimeout(resolve, WINDOW_SAFETY_MARGIN_MS - shortestRemaining + 50),
    );
  }
}

beforeEach(async () => {
  await waitForSafeRateLimitWindow();
  await clearAllCollections();
  await createStorefrontBusiness("test-store", BIZ);
  await createStorefrontBusiness("other-store", BIZ2);
});

async function createStorefrontBusiness(
  subdomain: string,
  id: string,
): Promise<void> {
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
  overrides: { price?: number; stock?: number } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: businessId,
    name: `Rate Limit Product ${suffix}`,
    slug: `rate-limit-product-${suffix}`,
    description: "rate limit test product",
    price: overrides.price ?? 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `RL-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 100,
    status: "active",
  });
}

async function createCart(
  businessId: string,
  ownerToken: string,
  productId: mongoose.Types.ObjectId,
  quantity = 1,
): Promise<void> {
  await Cart.create({
    business: businessId,
    ownerToken,
    items: [
      {
        product: productId,
        quantity,
        priceSnapshot: 10,
        currency: "USD",
      },
    ],
    subtotal: 10 * quantity,
    total: 10 * quantity,
  });
}

interface RequestOptions {
  host?: string;
  ip?: string;
  token?: string;
  body?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

function makeCartRequest(
  method: string,
  options: RequestOptions = {},
): Request {
  const host = options.host ?? HOST;
  const headers: Record<string, string> = { host };
  if (options.ip) headers["x-forwarded-for"] = options.ip;
  if (options.token) headers.cookie = `cart-token=${options.token}`;
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  return new Request(`http://${host}/api/businesses/${BIZ}/cart`, {
    method,
    headers,
    body,
  });
}

function makeOrderRequest(options: RequestOptions = {}): Request {
  const host = options.host ?? HOST;
  const headers: Record<string, string> = {
    host,
    "content-type": "application/json",
  };
  if (options.ip) headers["x-forwarded-for"] = options.ip;
  if (options.token) headers.cookie = `cart-token=${options.token}`;
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

  return new Request(`http://${host}/api/businesses/${BIZ}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      options.body ?? {
        customerName: "Rate Limit Customer",
        customerEmail: "rate-limit@example.com",
      },
    ),
  });
}

function cartTokenFromResponse(response: Response): string | null {
  const match = (response.headers.get("set-cookie") || "").match(
    /(?:^|,\s*)cart-token=([^;]*)/,
  );
  return match && match[1] ? match[1] : null;
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number } | null)?.stock ?? -1;
}

function assertRetryAfter(response: Response): void {
  const retryAfter = response.headers.get("retry-after");
  assert.ok(retryAfter, "a 429 must include Retry-After");
  assert.ok(
    Number.isSafeInteger(Number(retryAfter)) && Number(retryAfter) >= 1,
    "Retry-After must be a positive integer number of seconds",
  );
}

test("fixed-window counters split across a window boundary (root cause of the former flake)", async () => {
  const key = "boundary-probe";
  const windowMs = 60_000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs + windowMs;
  const realNow = Date.now;
  try {
    // Two requests land in window N, then the clock crosses into N+1.
    Date.now = () => windowStart - 1;
    assert.strictEqual((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
    assert.strictEqual((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
    Date.now = () => windowStart;
    const next = await consumeRateLimit({ key, limit: 2, windowMs });
    assert.strictEqual(next.allowed, true, "a new window starts a new counter");
    // Within the same window the limit is still enforced.
    assert.strictEqual((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
    assert.strictEqual((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, false);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// Cart reads
// ---------------------------------------------------------------------------

test("cart reads allow ordinary traffic and return a stable 429 above the limit", async () => {
  const ip = "198.51.100.10";

  const first = await cartGetHandler(makeCartRequest("GET", { ip }));
  assert.strictEqual(first.status, 200);
  const token = cartTokenFromResponse(first);
  assert.ok(token);

  for (let i = 1; i < CART_READ_LIMIT; i += 1) {
    const allowed = await cartGetHandler(
      makeCartRequest("GET", { ip, token: token ?? undefined }),
    );
    assert.strictEqual(allowed.status, 200, `read ${i + 1} should be allowed`);
  }

  const blocked = await cartGetHandler(
    makeCartRequest("GET", { ip, token: token ?? undefined }),
  );
  assert.strictEqual(blocked.status, 429);
  const body = await blocked.json();
  assert.strictEqual(body.code, "rate_limited");
  assertRetryAfter(blocked);

  // The bucket key must be HMAC-hashed, never the raw client IP.
  const counters = await RateLimit.find().lean();
  assert.ok(counters.length > 0);
  assert.ok(
    counters.every((counter) => !counter.key.includes(ip)),
    "raw client IPs must not be stored in rate-limit counters",
  );
});

// ---------------------------------------------------------------------------
// Cart writes
// ---------------------------------------------------------------------------

test("cart writes are limited without mutating the cart or stock on 429", async () => {
  const ip = "198.51.100.11";
  const product = await createProduct(BIZ, { stock: 200 });

  const first = await cartPostHandler(
    makeCartRequest("POST", {
      ip,
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(first.status, 200);
  const token = cartTokenFromResponse(first);
  assert.ok(token);

  for (let i = 1; i < CART_WRITE_LIMIT; i += 1) {
    const allowed = await cartPostHandler(
      makeCartRequest("POST", {
        ip,
        token,
        body: { productId: product._id.toString(), quantity: 1 },
      }),
    );
    assert.strictEqual(allowed.status, 200, `write ${i + 1} should be allowed`);
  }

  const blocked = await cartPostHandler(
    makeCartRequest("POST", {
      ip,
      token,
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual((await blocked.json()).code, "rate_limited");
  assertRetryAfter(blocked);

  const cart = await Cart.findOne({ business: BIZ, ownerToken: token });
  assert.ok(cart);
  assert.strictEqual(cart.items.length, 1);
  assert.strictEqual(
    cart.items[0].quantity,
    CART_WRITE_LIMIT,
    "the rejected write must not change the cart",
  );
  assert.strictEqual(await stockOf(product._id), 200, "cart writes never touch stock");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 1);
});

test("cart write buckets are isolated per business for the same client IP", async () => {
  const ip = "198.51.100.12";
  const ownProduct = await createProduct(BIZ, { stock: 5 });
  const otherProduct = await createProduct(BIZ2, { stock: 5 });

  // Invalid product IDs are rejected after the limiter, so they consume the
  // write bucket without mutating any cart.
  for (let i = 0; i < CART_WRITE_LIMIT; i += 1) {
    const rejected = await cartPostHandler(
      makeCartRequest("POST", {
        ip,
        body: { productId: "not-an-object-id", quantity: 1 },
      }),
    );
    assert.strictEqual(rejected.status, 400);
  }

  const blocked = await cartPostHandler(
    makeCartRequest("POST", {
      ip,
      body: { productId: ownProduct._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(blocked.status, 429);

  const otherStore = await cartPostHandler(
    makeCartRequest("POST", {
      host: OTHER_HOST,
      ip,
      body: { productId: otherProduct._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(otherStore.status, 200, "another business has its own bucket");
  const otherToken = cartTokenFromResponse(otherStore);
  assert.ok(otherToken);

  assert.strictEqual(
    await Cart.countDocuments({ business: BIZ, ownerToken: otherToken }),
    0,
  );
  assert.strictEqual(await Cart.countDocuments({ business: BIZ2, ownerToken: otherToken }), 1);
  assert.strictEqual(await stockOf(ownProduct._id), 5);
  assert.strictEqual(await stockOf(otherProduct._id), 5);
});

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

test("order creation below the limit still succeeds", async () => {
  const ip = "198.51.100.13";
  const product = await createProduct(BIZ, { stock: 5 });
  const token = `tok-${crypto.randomUUID()}`;
  await createCart(BIZ, token, product._id, 1);

  const response = await orderPostHandler(makeOrderRequest({ ip, token }));
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.ok(body.orderNumber);
  assert.strictEqual(await stockOf(product._id), 4);
  assert.strictEqual(await Cart.countDocuments({ business: BIZ, ownerToken: token }), 0);
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 1);
});

test("order creation returns 429 above the limit without mutating cart or stock", async () => {
  const ip = "198.51.100.14";
  const product = await createProduct(BIZ, { stock: 5 });
  const token = `tok-${crypto.randomUUID()}`;
  await createCart(BIZ, token, product._id, 1);

  // Malformed payloads pass the limiter and fail validation, consuming one
  // attempt each without creating an order.
  for (let i = 0; i < ORDER_CREATE_LIMIT; i += 1) {
    const rejected = await orderPostHandler(
      makeOrderRequest({ ip, body: {} }),
    );
    assert.strictEqual(rejected.status, 400);
    assert.strictEqual((await rejected.json()).code, "invalid_payload");
  }

  const blocked = await orderPostHandler(makeOrderRequest({ ip, token }));
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual((await blocked.json()).code, "rate_limited");
  assertRetryAfter(blocked);

  const cart = await Cart.findOne({ business: BIZ, ownerToken: token });
  assert.ok(cart, "the cart must survive a rejected order attempt");
  assert.strictEqual(cart.items.length, 1);
  assert.strictEqual(cart.items[0].quantity, 1);
  assert.strictEqual(await stockOf(product._id), 5, "stock must not be reserved");
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
});

test("order limits are isolated per business for the same client IP", async () => {
  const ip = "198.51.100.15";
  const ownProduct = await createProduct(BIZ, { stock: 5 });
  const otherProduct = await createProduct(BIZ2, { stock: 5 });
  const ownToken = `tok-${crypto.randomUUID()}`;
  const otherToken = `tok-${crypto.randomUUID()}`;
  await createCart(BIZ, ownToken, ownProduct._id, 1);
  await createCart(BIZ2, otherToken, otherProduct._id, 1);

  for (let i = 0; i < ORDER_CREATE_LIMIT; i += 1) {
    const rejected = await orderPostHandler(
      makeOrderRequest({ ip, body: {} }),
    );
    assert.strictEqual(rejected.status, 400);
  }

  const blocked = await orderPostHandler(
    makeOrderRequest({ ip, token: ownToken }),
  );
  assert.strictEqual(blocked.status, 429, "the first business is exhausted");

  const otherStore = await orderPostHandler(
    makeOrderRequest({ host: OTHER_HOST, ip, token: otherToken }),
  );
  assert.strictEqual(otherStore.status, 200, "another business has its own bucket");
  assert.strictEqual(await stockOf(otherProduct._id), 4);
  assert.strictEqual(await stockOf(ownProduct._id), 5);
  assert.ok(
    await Cart.findOne({ business: BIZ, ownerToken: ownToken }),
    "the blocked business's cart is untouched",
  );
  assert.strictEqual(await Order.countDocuments({ business: BIZ }), 0);
  assert.strictEqual(await Order.countDocuments({ business: BIZ2 }), 1);
});

test("spoofed or untrusted forwarding headers cannot reset the order bucket", async () => {
  const ip = "203.0.113.90";

  for (let i = 0; i < ORDER_CREATE_LIMIT; i += 1) {
    const rejected = await orderPostHandler(
      makeOrderRequest({ ip, body: {} }),
    );
    assert.strictEqual(rejected.status, 400);
  }

  // An extra, untrusted header does not change the trusted x-forwarded-for.
  const withUntrustedHeader = await orderPostHandler(
    makeOrderRequest({
      ip,
      extraHeaders: { "x-real-ip": "203.0.113.91" },
      body: {},
    }),
  );
  assert.strictEqual(withUntrustedHeader.status, 429);

  // Only the right-most (proxy-appended) x-forwarded-for entry is trusted.
  const leftMostSpoof = await orderPostHandler(
    makeOrderRequest({
      extraHeaders: {
        "x-forwarded-for": `198.51.100.99, ${ip}`,
      },
      body: {},
    }),
  );
  assert.strictEqual(leftMostSpoof.status, 429);

  // A genuinely different trusted address gets a fresh bucket.
  const freshIp = await orderPostHandler(
    makeOrderRequest({ ip: "203.0.113.92", body: {} }),
  );
  assert.strictEqual(freshIp.status, 400, "a new trusted IP must not inherit the 429");

  // Without the configured trusted header, x-real-ip is not trusted. Outside
  // production this falls back to the shared "unknown" bucket, which is fresh.
  const untrustedOnly = await orderPostHandler(
    makeOrderRequest({
      extraHeaders: { "x-real-ip": ip },
      body: {},
    }),
  );
  assert.strictEqual(untrustedOnly.status, 400);
});
