/**
 * Phase B2.2.6 — safe idempotent replay and cart consumption.
 *
 * Retries must be able to recover an order after the cart was consumed or the
 * browser cookie was cleared, WITHOUT allowing another guest (or another
 * business) to retrieve it. Ownership is proven by the one-time high-entropy
 * `orderProof` returned at creation (stored only as a SHA-256 digest) or by the
 * original cart-token cookie. The 12-char order number is never enough.
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

async function createProduct(
  businessId: string,
  overrides: { stock?: number; price?: number } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: businessId,
    name: `Replay Widget ${suffix}`,
    slug: `replay-widget-${suffix}`,
    description: "replay test product",
    price: overrides.price ?? 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `RP-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 5,
    status: "active",
  });
}

async function createCartWithToken(
  businessId: string,
  ownerToken: string,
  items: Array<{ product: mongoose.Types.ObjectId; quantity: number; price?: number }>,
): Promise<string> {
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

async function createCart(
  businessId: string,
  items: Array<{ product: mongoose.Types.ObjectId; quantity: number; price?: number }>,
): Promise<string> {
  return createCartWithToken(businessId, `tok-${crypto.randomUUID()}`, items);
}

/**
 * Build an order request. Omitting `ownerToken` sends no cookie at all;
 * `proofInBody` exercises the body field instead of the header.
 */
function makeRequest(
  businessId: string,
  opts: {
    ownerToken?: string | null;
    idempotencyKey?: string;
    proof?: string;
    proofInBody?: boolean;
  } = {},
): Request {
  const params = new URLSearchParams();
  params.set("customerName", "Replay Customer");
  params.set("customerEmail", "replay@example.com");
  if (opts.idempotencyKey) params.set("idempotencyKey", opts.idempotencyKey);
  if (opts.proof && opts.proofInBody) params.set("orderProof", opts.proof);

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
    "x-forwarded-for": "203.0.113.21",
  };
  if (opts.ownerToken) headers.cookie = `cart-token=${opts.ownerToken}`;
  if (opts.proof && !opts.proofInBody) headers["x-order-proof"] = opts.proof;

  return new Request(`http://localhost/api/businesses/${businessId}/orders`, {
    method: "POST",
    headers,
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

/** Create a product + cart + keyed order and return everything a retry needs. */
async function placeOrder() {
  const product = await createProduct(BIZ, { stock: 5, price: 10 });
  const ownerToken = await createCart(BIZ, [{ product: product._id, quantity: 2, price: 10 }]);
  const key = `replay-${crypto.randomUUID()}`;

  const res = await orderHandler(
    makeRequest(BIZ, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(res.status, 200, "initial order creation should succeed");
  const body = await bodyOf(res);
  return {
    product,
    ownerToken,
    key,
    order: body,
    proof: body.orderProof as string,
    response: res,
  };
}

// ---------------------------------------------------------------------------
// 1. Successful creation → proof is returned, only its digest is stored
// ---------------------------------------------------------------------------

test("successful order returns a high-entropy proof and stores only its hash", async () => {
  const { product, ownerToken, key, order, proof, response } = await placeOrder();

  assert.equal(typeof proof, "string", "keyed orders must return an ownership proof");
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/, "proof must be 32 bytes of base64url");
  assert.equal(order.orderProofHash, undefined, "the stored digest must never be returned");
  assert.ok(order.orderNumber);

  assert.strictEqual(await stockOf(product._id), 3, "stock is decremented once");
  assert.strictEqual(
    await Cart.countDocuments({ business: BIZ, ownerToken }),
    0,
    "the cart is consumed by the order",
  );

  // Both cookies must be emitted. `Headers.set` would overwrite the clear and
  // leave the consumed guest token in the browser.
  const setCookies = response.headers.getSetCookie();
  assert.ok(
    setCookies.some((cookie) => cookie.startsWith("cart-token=;")),
    "the consumed cart-token cookie must be cleared",
  );
  assert.ok(
    setCookies.some((cookie) => cookie.startsWith("order-number=")),
    "the order-number cookie must still be set",
  );

  // Default queries hide the digest (select: false)...
  const defaultView = await Order.findOne({ business: BIZ, idempotencyKey: key });
  assert.ok(defaultView);
  assert.equal(defaultView.orderProofHash, undefined);

  // ...and the persisted value is a SHA-256 digest, not the raw proof.
  const withHash = await Order.findOne({ business: BIZ, idempotencyKey: key })
    .select("+orderProofHash");
  assert.ok(withHash, "order should exist");
  const storedHash = withHash.orderProofHash;
  assert.ok(storedHash, "the order should persist a proof digest");
  assert.match(storedHash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(storedHash, proof);
  assert.strictEqual(
    storedHash,
    crypto.createHash("sha256").update(proof, "utf8").digest("hex"),
  );
  assert.strictEqual(withHash.ownerToken, ownerToken, "guest context stays attached to the order");
});

// ---------------------------------------------------------------------------
// 2. Retry after the cart is gone, with no cookie at all
// ---------------------------------------------------------------------------

test("same-key retry succeeds after the cart is gone and no cookie is sent", async () => {
  const { product, key, order, proof } = await placeOrder();

  assert.strictEqual(
    await Cart.countDocuments({ business: BIZ }),
    0,
    "the successful order already consumed the cart",
  );

  const retry = await orderHandler(
    makeRequest(BIZ, { idempotencyKey: key, proof }),
  );
  assert.strictEqual(retry.status, 200, "proof-based replay must not require a cart or cookie");
  const retryBody = await bodyOf(retry);

  assert.strictEqual(retryBody.orderNumber, order.orderNumber, "the same order is returned");
  assert.strictEqual(await stockOf(product._id), 3, "replay must not decrement stock again");
  assert.strictEqual(await orderCount(), 1, "replay must not create another order");
});

// ---------------------------------------------------------------------------
// 3. Retry after the cookie was cleared/replaced
// ---------------------------------------------------------------------------

test("same-key retry succeeds after the cookie was replaced by a new guest token", async () => {
  const { product, key, order, proof } = await placeOrder();

  const retry = await orderHandler(
    makeRequest(BIZ, {
      ownerToken: `tok-${crypto.randomUUID()}`,
      idempotencyKey: key,
      proof,
      proofInBody: true, // body transport also works
    }),
  );
  assert.strictEqual(retry.status, 200);
  const retryBody = await bodyOf(retry);

  assert.strictEqual(retryBody.orderNumber, order.orderNumber);
  assert.strictEqual(await stockOf(product._id), 3, "stock stays decremented exactly once");
  assert.strictEqual(await orderCount(), 1);
});

// ---------------------------------------------------------------------------
// 4. Another guest cannot retrieve the order
// ---------------------------------------------------------------------------

test("a different guest cannot retrieve the order with the same key", async () => {
  const { product, key, order } = await placeOrder();

  const withoutProof = await orderHandler(
    makeRequest(BIZ, {
      ownerToken: `tok-${crypto.randomUUID()}`,
      idempotencyKey: key,
    }),
  );
  assert.strictEqual(withoutProof.status, 409);
  const withoutProofBody = await bodyOf(withoutProof);
  assert.strictEqual(withoutProofBody.code, "idempotency_conflict");
  assert.equal(withoutProofBody.orderNumber, undefined);
  assert.equal(withoutProofBody.orderId, undefined);
  assert.equal(withoutProofBody.orderProof, undefined);

  const withGuessedProof = await orderHandler(
    makeRequest(BIZ, {
      ownerToken: `tok-${crypto.randomUUID()}`,
      idempotencyKey: key,
      proof: crypto.randomBytes(32).toString("base64url"),
    }),
  );
  assert.strictEqual(withGuessedProof.status, 409);
  const guessedBody = await bodyOf(withGuessedProof);
  assert.equal(guessedBody.orderNumber, undefined, "must not leak the order number");
  assert.equal(guessedBody.orderId, undefined, "must not leak the order id");

  assert.strictEqual(await stockOf(product._id), 3, "rejected retries never touch stock");
  assert.strictEqual(await orderCount(), 1);
  assert.ok(order.orderNumber);
});

// ---------------------------------------------------------------------------
// 5. Another business cannot retrieve the order
// ---------------------------------------------------------------------------

test("the same key cannot retrieve an order across businesses", async () => {
  const { key, order, proof } = await placeOrder();

  const crossTenant = await orderHandler(
    makeRequest(BIZ2, { idempotencyKey: key, proof }),
  );
  assert.strictEqual(crossTenant.status, 404, "no cart exists in the other business");
  const crossTenantBody = await bodyOf(crossTenant);
  assert.equal(crossTenantBody.orderNumber, undefined, "must not leak the other tenant's order");

  assert.strictEqual(await orderCount(BIZ), 1);
  assert.strictEqual(await orderCount(BIZ2), 0);
  assert.ok(order.orderNumber);
});

// ---------------------------------------------------------------------------
// 6. A new key cannot reuse an old order
// ---------------------------------------------------------------------------

test("a new idempotency key never reuses the previous order", async () => {
  const { product, key, order, proof } = await placeOrder();

  const newKey = `new-key-${crypto.randomUUID()}`;
  const noCart = await orderHandler(
    makeRequest(BIZ, { idempotencyKey: newKey, proof }),
  );
  assert.strictEqual(noCart.status, 404, "a new key with no cart cannot resolve the old order");
  const noCartBody = await bodyOf(noCart);
  assert.equal(noCartBody.orderNumber, undefined);
  assert.strictEqual(await orderCount(), 1);
  assert.strictEqual(await stockOf(product._id), 3);

  // With a genuine new cart, the new key creates a genuinely new order.
  const newToken = await createCart(BIZ, [{ product: product._id, quantity: 1, price: 10 }]);
  const second = await orderHandler(
    makeRequest(BIZ, { ownerToken: newToken, idempotencyKey: newKey }),
  );
  assert.strictEqual(second.status, 200);
  const secondBody = await bodyOf(second);
  assert.notStrictEqual(secondBody.orderNumber, order.orderNumber);
  assert.notStrictEqual(secondBody.orderProof, proof, "each order gets its own proof");
  assert.strictEqual(await orderCount(), 2);
  assert.strictEqual(await stockOf(product._id), 2, "the second order decrements once more");

  // The first key still replays the first order, untouched.
  const firstRetry = await orderHandler(
    makeRequest(BIZ, { idempotencyKey: key, proof }),
  );
  assert.strictEqual(firstRetry.status, 200);
  const firstRetryBody = await bodyOf(firstRetry);
  assert.strictEqual(firstRetryBody.orderNumber, order.orderNumber);
  assert.strictEqual(await stockOf(product._id), 2, "replaying the first order changes nothing");
});

// ---------------------------------------------------------------------------
// 7. A stale cart cannot create an unintended duplicate purchase
// ---------------------------------------------------------------------------

test("a leftover cart with a consumed guest token cannot create a second order", async () => {
  const { product, ownerToken, order } = await placeOrder();

  // Simulate a cart that survived the order (e.g. data written before cart
  // consumption was transactional): same business + same guest token.
  await createCartWithToken(BIZ, ownerToken, [
    { product: product._id, quantity: 1, price: 10 },
  ]);

  const staleRetry = await orderHandler(
    makeRequest(BIZ, {
      ownerToken,
      idempotencyKey: `stale-${crypto.randomUUID()}`,
    }),
  );

  assert.strictEqual(staleRetry.status, 409, "a consumed guest token must be rejected");
  const staleBody = await bodyOf(staleRetry);
  assert.strictEqual(staleBody.code, "cart_conflict");
  assert.equal(staleBody.orderNumber, undefined, "the rejection must not expose the first order");

  assert.strictEqual(await orderCount(), 1, "no duplicate order was created");
  assert.strictEqual(await stockOf(product._id), 3, "no second stock decrement happened");
  assert.ok(
    await Cart.countDocuments({ business: BIZ, ownerToken }),
    "the stale cart itself is left untouched",
  );
  assert.ok(order.orderNumber);
});

test("a keyless repeat on a consumed cart does not duplicate the purchase", async () => {
  const product = await createProduct(BIZ, { stock: 5, price: 10 });
  const ownerToken = await createCart(BIZ, [
    { product: product._id, quantity: 1, price: 10 },
  ]);

  const first = await orderHandler(makeRequest(BIZ, { ownerToken }));
  assert.strictEqual(first.status, 200);

  const second = await orderHandler(makeRequest(BIZ, { ownerToken }));
  assert.strictEqual(second.status, 409);
  const secondBody = await bodyOf(second);
  assert.strictEqual(secondBody.code, "cart_conflict");

  assert.strictEqual(await orderCount(), 1);
  assert.strictEqual(await stockOf(product._id), 4);
});
