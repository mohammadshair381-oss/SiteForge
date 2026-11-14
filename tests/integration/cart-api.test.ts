/**
 * Phase B2.3.5 — cart API integration tests.
 *
 * These tests call the real GET/POST/PATCH/DELETE route handlers against the
 * replica-set test database. They intentionally do not create Cart documents
 * directly for write-path tests: the handlers must prove they use the resolved
 * storefront host, real Product records, and one consistent owner token.
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
  DELETE as cartDeleteHandler,
  GET as cartGetHandler,
  PATCH as cartPatchHandler,
  POST as cartPostHandler,
} from "@/app/api/businesses/[id]/cart/route";
import { Business } from "@/models/Business";
import { Cart } from "@/models/Cart";
import { Product } from "@/models/Product";
import type { ProductStatus } from "@/lib/constants";

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

beforeEach(async () => {
  await clearAllCollections();
  await createBusiness("test-store", BIZ);
});

async function createBusiness(subdomain: string, id = BIZ): Promise<void> {
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

interface ProductOverrides {
  businessId?: string;
  price?: number;
  currency?: string;
  stock?: number;
  status?: ProductStatus;
}

async function createProduct(overrides: ProductOverrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  return Product.create({
    business: overrides.businessId ?? BIZ,
    name: `Product ${suffix}`,
    slug: `product-${suffix}`,
    description: "cart test product",
    price: overrides.price ?? 10,
    currency: overrides.currency ?? "USD",
    imageUrl: "",
    images: [],
    sku: `SKU-${suffix}`,
    category: "test",
    stock: overrides.stock ?? 5,
    status: overrides.status ?? "active",
  });
}

interface RequestOptions {
  host?: string;
  pathId?: string;
  token?: string | null;
  body?: Record<string, unknown>;
  formBody?: Record<string, string>;
  rawBody?: string;
  contentType?: "json" | "form" | "text";
  productIdQuery?: string;
}

function makeRequest(method: string, options: RequestOptions = {}): Request {
  const host = options.host ?? HOST;
  const pathId = options.pathId ?? BIZ;
  const url = new URL(`http://${host}/api/businesses/${pathId}/cart`);
  if (options.productIdQuery !== undefined) {
    url.searchParams.set("productId", options.productIdQuery);
  }

  const headers: Record<string, string> = { host };
  if (options.token) {
    headers.cookie = `cart-token=${options.token}`;
  }

  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    headers["content-type"] =
      options.contentType === "text" ? "text/plain" : "application/json";
    body = options.rawBody;
  } else if (options.formBody !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.formBody);
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  return new Request(url, { method, headers, body });
}

function setCookieHeader(response: Response): string {
  return response.headers.get("set-cookie") || "";
}

function cartTokenFromResponse(response: Response): string | null {
  const match = setCookieHeader(response).match(
    /(?:^|,\s*)cart-token=([^;]*)/,
  );
  return match && match[1] ? match[1] : null;
}

async function jsonBody(response: Response): Promise<any> {
  return response.json();
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  return (product as { stock: number } | null)?.stock ?? -1;
}

async function cartFor(token: string, businessId = BIZ) {
  return Cart.findOne({ business: businessId, ownerToken: token });
}

// ---------------------------------------------------------------------------
// Creation and token consistency
// ---------------------------------------------------------------------------

test("GET returns an empty cart and a token without storing anything; the first add uses that token", async () => {
  const response = await cartGetHandler(makeRequest("GET"));
  assert.strictEqual(response.status, 200);

  const body = await jsonBody(response);
  // `lines` (what each line means now) and `notices` (what changed while away): cart route `cartResponse`.
  assert.deepStrictEqual(body, { items: [], subtotal: 0, total: 0, lines: [], notices: [] });
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(body, "ownerToken"),
    false,
    "the owner token must never be returned in JSON",
  );

  const cookie = setCookieHeader(response);
  const token = cartTokenFromResponse(response);
  assert.ok(token, "GET must set a cart-token cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  // 30 days, renewed on use (CART_COOKIE_MAX_AGE_SECONDS; docs/commerce-operations.md, "Carts").
  assert.match(cookie, /Max-Age=2592000/i);

  assert.strictEqual(await Cart.countDocuments({}), 0, "a read must never create a cart");

  const product = await createProduct({ price: 4, stock: 3 });
  const added = await cartPostHandler(
    makeRequest("POST", {
      token,
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(added.status, 200);
  const cart = await cartFor(token);
  assert.ok(cart, "the first write stores the cart under the token issued by GET");
  assert.strictEqual(cart.ownerToken, token);
  assert.strictEqual(cart.items.length, 1);
});

test("POST adds a real product, ignores client prices, and uses the cookie token", async () => {
  const product = await createProduct({ price: 12.5, stock: 5 });

  const response = await cartPostHandler(
    makeRequest("POST", {
      body: {
        productId: product._id.toString(),
        quantity: 2,
        price: 0.01,
        currency: "EUR",
        subtotal: 1,
        total: 1,
      },
    }),
  );
  assert.strictEqual(response.status, 200);

  const token = cartTokenFromResponse(response);
  assert.ok(token, "POST must set the cart-token cookie for a new cart");

  const body = await jsonBody(response);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].product, product._id.toString());
  assert.strictEqual(body.items[0].quantity, 2);
  assert.strictEqual(body.items[0].priceSnapshot, 12.5);
  assert.strictEqual(body.items[0].currency, "USD");
  assert.strictEqual(body.subtotal, 25);
  assert.strictEqual(body.total, 25);
  assert.strictEqual(body.ownerToken, undefined);

  const cart = await cartFor(token);
  assert.ok(cart, "the returned token must identify the persisted cart");
  assert.strictEqual(cart.ownerToken, token);
  assert.strictEqual(cart.items[0].priceSnapshot, 12.5);
  assert.strictEqual(cart.items[0].currency, "USD");
  assert.strictEqual(await stockOf(product._id), 5, "adding to a cart must not touch stock");

  const getResponse = await cartGetHandler(
    makeRequest("GET", { token }),
  );
  assert.strictEqual(getResponse.status, 200);
  assert.strictEqual(cartTokenFromResponse(getResponse), token);
  const getBody = await jsonBody(getResponse);
  assert.strictEqual(getBody.items.length, 1);
  assert.strictEqual(getBody.items[0].quantity, 2);
});

test("POST increments an existing line and refreshes the server price", async () => {
  const product = await createProduct({ price: 10, stock: 5 });

  const first = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(first.status, 200);
  const token = cartTokenFromResponse(first);
  assert.ok(token);

  product.price = 15;
  await product.save();

  const second = await cartPostHandler(
    makeRequest("POST", {
      token,
      body: { productId: product._id.toString(), quantity: 2 },
    }),
  );
  assert.strictEqual(second.status, 200);

  const body = await jsonBody(second);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].quantity, 3);
  assert.strictEqual(body.items[0].priceSnapshot, 15);
  assert.strictEqual(body.subtotal, 45);
  assert.strictEqual(body.total, 45);

  const cart = await cartFor(token);
  assert.ok(cart);
  assert.strictEqual(cart.items[0].quantity, 3);
  assert.strictEqual(cart.items[0].priceSnapshot, 15);
  assert.strictEqual(await stockOf(product._id), 5);
});

// ---------------------------------------------------------------------------
// Update, remove and clear
// ---------------------------------------------------------------------------

test("PATCH updates quantity and re-prices from the current product record", async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  product.price = 20;
  await product.save();

  const response = await cartPatchHandler(
    makeRequest("PATCH", {
      token,
      body: { productId: product._id.toString(), quantity: 4 },
    }),
  );
  assert.strictEqual(response.status, 200);
  assert.strictEqual(cartTokenFromResponse(response), token);

  const body = await jsonBody(response);
  assert.strictEqual(body.items[0].quantity, 4);
  assert.strictEqual(body.items[0].priceSnapshot, 20);
  assert.strictEqual(body.subtotal, 80);
  assert.strictEqual(body.total, 80);

  const cart = await cartFor(token);
  assert.ok(cart);
  assert.strictEqual(cart.items[0].quantity, 4);
  assert.strictEqual(cart.items[0].priceSnapshot, 20);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("DELETE with productId removes one line and keeps the rest of the cart", async () => {
  const firstProduct = await createProduct({ price: 10, stock: 5 });
  const secondProduct = await createProduct({ price: 5, stock: 5 });

  const firstAdd = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: firstProduct._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(firstAdd);
  assert.ok(token);

  const secondAdd = await cartPostHandler(
    makeRequest("POST", {
      token,
      body: { productId: secondProduct._id.toString(), quantity: 2 },
    }),
  );
  assert.strictEqual(secondAdd.status, 200);

  const response = await cartDeleteHandler(
    makeRequest("DELETE", {
      token,
      productIdQuery: firstProduct._id.toString(),
    }),
  );
  assert.strictEqual(response.status, 200);
  assert.strictEqual(cartTokenFromResponse(response), token);

  const body = await jsonBody(response);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].product, secondProduct._id.toString());
  assert.strictEqual(body.items[0].quantity, 2);
  assert.strictEqual(body.subtotal, 10);
  assert.strictEqual(body.total, 10);

  const cart = await cartFor(token);
  assert.ok(cart, "removing one line must keep the cart document");
  assert.strictEqual(cart.items.length, 1);
  assert.strictEqual(await stockOf(firstProduct._id), 5);
  assert.strictEqual(await stockOf(secondProduct._id), 5);
});

test("POST action=clear deletes the cart and clears the cookie", async () => {
  const product = await createProduct();
  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  const response = await cartPostHandler(
    makeRequest("POST", { token, body: { action: "clear" } }),
  );
  assert.strictEqual(response.status, 200);

  const body = await jsonBody(response);
  assert.deepStrictEqual(body, { items: [], subtotal: 0, total: 0 });

  const cookie = setCookieHeader(response);
  assert.match(cookie, /cart-token=;/);
  assert.match(cookie, /Max-Age=0/i);
  assert.strictEqual(await Cart.countDocuments({ business: BIZ, ownerToken: token }), 0);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("DELETE without productId clears the cart and is idempotent", async () => {
  const product = await createProduct();
  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  const response = await cartDeleteHandler(makeRequest("DELETE", { token }));
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await jsonBody(response), {
    items: [],
    subtotal: 0,
    total: 0,
  });
  assert.match(setCookieHeader(response), /cart-token=;/);
  assert.match(setCookieHeader(response), /Max-Age=0/i);
  assert.strictEqual(await Cart.countDocuments({ business: BIZ, ownerToken: token }), 0);

  const retry = await cartDeleteHandler(makeRequest("DELETE"));
  assert.strictEqual(retry.status, 200);
  assert.deepStrictEqual(await jsonBody(retry), {
    items: [],
    subtotal: 0,
    total: 0,
  });
  assert.match(setCookieHeader(retry), /cart-token=;/);
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);
});

// ---------------------------------------------------------------------------
// Tenant and product validation
// ---------------------------------------------------------------------------

test("a product from another business is rejected without changing the cart or stock", async () => {
  await createBusiness("other-store", BIZ2);
  const ours = await createProduct({ price: 10, stock: 5 });
  const theirs = await createProduct({
    businessId: BIZ2,
    price: 99,
    stock: 7,
  });

  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: ours._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  const before = await cartFor(token);
  assert.ok(before);

  const response = await cartPostHandler(
    makeRequest("POST", {
      token,
      body: { productId: theirs._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(response.status, 403);
  const body = await jsonBody(response);
  assert.strictEqual(body.code, "cross_business_product");

  const afterCart = await cartFor(token);
  assert.ok(afterCart);
  assert.strictEqual(afterCart.items.length, 1);
  assert.strictEqual(afterCart.items[0].product, ours._id.toString());
  assert.strictEqual(afterCart.items[0].quantity, 1);
  assert.strictEqual(afterCart.items[0].priceSnapshot, 10);
  assert.strictEqual(afterCart.subtotal, 10);
  assert.strictEqual(await stockOf(ours._id), 5);
  assert.strictEqual(await stockOf(theirs._id), 7);
});

test("an inactive product is rejected without creating a cart", async () => {
  const product = await createProduct({ status: "draft", stock: 5 });

  const response = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(response.status, 404);
  const body = await jsonBody(response);
  assert.strictEqual(body.code, "product_unavailable");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("out-of-stock and above-stock quantities are rejected without mutation", async () => {
  const emptyProduct = await createProduct({ stock: 0 });
  const emptyResponse = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: emptyProduct._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(emptyResponse.status, 404);
  assert.strictEqual((await jsonBody(emptyResponse)).code, "out_of_stock");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);

  const lowStock = await createProduct({ price: 10, stock: 2 });
  const tooMany = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: lowStock._id.toString(), quantity: 3 },
    }),
  );
  assert.strictEqual(tooMany.status, 404);
  assert.strictEqual((await jsonBody(tooMany)).code, "out_of_stock");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);

  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: lowStock._id.toString(), quantity: 1 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  const update = await cartPatchHandler(
    makeRequest("PATCH", {
      token,
      body: { productId: lowStock._id.toString(), quantity: 3 },
    }),
  );
  assert.strictEqual(update.status, 404);
  assert.strictEqual((await jsonBody(update)).code, "out_of_stock");

  const cart = await cartFor(token);
  assert.ok(cart);
  assert.strictEqual(cart.items[0].quantity, 1);
  assert.strictEqual(cart.subtotal, 10);
  assert.strictEqual(await stockOf(lowStock._id), 2);
});

test("invalid quantities are rejected on POST and PATCH without changing the cart", async () => {
  const product = await createProduct({ stock: 5 });
  const productId = product._id.toString();
  const invalidQuantities: unknown[] = [
    0,
    -1,
    1.5,
    "abc",
    true,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const quantity of invalidQuantities) {
    const response = await cartPostHandler(
      makeRequest("POST", { body: { productId, quantity } }),
    );
    assert.strictEqual(
      response.status,
      400,
      `POST quantity ${String(quantity)} must be rejected`,
    );
    assert.strictEqual((await jsonBody(response)).code, "invalid_quantity");
    assert.strictEqual(
      await Cart.countDocuments({ business: BIZ }),
      0,
      "a rejected POST must not create a cart",
    );
  }

  const created = await cartPostHandler(
    makeRequest("POST", { body: { productId, quantity: 1 } }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  for (const quantity of invalidQuantities) {
    const response = await cartPatchHandler(
      makeRequest("PATCH", { token, body: { productId, quantity } }),
    );
    assert.strictEqual(
      response.status,
      400,
      `PATCH quantity ${String(quantity)} must be rejected`,
    );
    assert.strictEqual((await jsonBody(response)).code, "invalid_quantity");
  }

  const missingQuantity = await cartPatchHandler(
    makeRequest("PATCH", { token, body: { productId } }),
  );
  assert.strictEqual(missingQuantity.status, 400);
  assert.strictEqual(
    (await jsonBody(missingQuantity)).code,
    "invalid_quantity",
  );

  const cart = await cartFor(token);
  assert.ok(cart);
  assert.strictEqual(cart.items[0].quantity, 1);
  assert.strictEqual(cart.subtotal, 10);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("malformed bodies, unsupported types and invalid product IDs return safe 400s", async () => {
  const product = await createProduct({ stock: 5 });
  const productId = product._id.toString();

  const malformedJson = await cartPostHandler(
    makeRequest("POST", { rawBody: "{" }),
  );
  assert.strictEqual(malformedJson.status, 400);
  assert.strictEqual((await jsonBody(malformedJson)).code, "invalid_payload");

  const unsupportedType = await cartPostHandler(
    makeRequest("POST", {
      rawBody: "hello",
      contentType: "text",
    }),
  );
  assert.strictEqual(unsupportedType.status, 400);
  assert.strictEqual(
    (await jsonBody(unsupportedType)).code,
    "invalid_payload",
  );

  const arrayBody = await cartPostHandler(
    makeRequest("POST", { body: [] as unknown as Record<string, unknown> }),
  );
  assert.strictEqual(arrayBody.status, 400);
  assert.strictEqual((await jsonBody(arrayBody)).code, "invalid_payload");

  const invalidId = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: "not-an-object-id", quantity: 1 },
    }),
  );
  assert.strictEqual(invalidId.status, 400);
  assert.strictEqual((await jsonBody(invalidId)).code, "invalid_product_id");

  const unknownAction = await cartPostHandler(
    makeRequest("POST", {
      body: { productId, quantity: 1, action: "destroy" },
    }),
  );
  assert.strictEqual(unknownAction.status, 400);
  assert.strictEqual(
    (await jsonBody(unknownAction)).code,
    "invalid_payload",
  );

  const patchWithoutCookie = await cartPatchHandler(
    makeRequest("PATCH", {
      body: { productId, quantity: 1 },
    }),
  );
  assert.strictEqual(patchWithoutCookie.status, 404);
  assert.strictEqual(
    (await jsonBody(patchWithoutCookie)).code,
    "cart_not_found",
  );

  const invalidDeleteId = await cartDeleteHandler(
    makeRequest("DELETE", { productIdQuery: "bad-id" }),
  );
  assert.strictEqual(invalidDeleteId.status, 400);
  assert.strictEqual(
    (await jsonBody(invalidDeleteId)).code,
    "invalid_product_id",
  );

  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("form bodies are accepted, numeric strings are validated, and missing POST quantity defaults to 1", async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  const productId = product._id.toString();

  const created = await cartPostHandler(
    makeRequest("POST", {
      formBody: { productId, quantity: "2" },
    }),
  );
  assert.strictEqual(created.status, 200);
  const token = cartTokenFromResponse(created);
  assert.ok(token);
  assert.strictEqual((await jsonBody(created)).items[0].quantity, 2);

  const updated = await cartPatchHandler(
    makeRequest("PATCH", {
      token,
      formBody: { productId, quantity: "3" },
    }),
  );
  assert.strictEqual(updated.status, 200);
  assert.strictEqual((await jsonBody(updated)).items[0].quantity, 3);

  const defaulted = await cartPostHandler(
    makeRequest("POST", { token, formBody: { productId } }),
  );
  assert.strictEqual(defaulted.status, 200);
  assert.strictEqual((await jsonBody(defaulted)).items[0].quantity, 4);

  const invalidFormQuantity = await cartPatchHandler(
    makeRequest("PATCH", {
      token,
      formBody: { productId, quantity: "0" },
    }),
  );
  assert.strictEqual(invalidFormQuantity.status, 400);
  assert.strictEqual(
    (await jsonBody(invalidFormQuantity)).code,
    "invalid_quantity",
  );

  const cart = await cartFor(token);
  assert.ok(cart);
  assert.strictEqual(cart.items[0].quantity, 4);
  assert.strictEqual(await stockOf(product._id), 5);
});

// ---------------------------------------------------------------------------
// Host isolation
// ---------------------------------------------------------------------------

test("the same owner token is isolated per business host", async () => {
  await createBusiness("other-store", BIZ2);
  const product = await createProduct({ price: 10, stock: 5 });

  const created = await cartPostHandler(
    makeRequest("POST", {
      body: { productId: product._id.toString(), quantity: 2 },
    }),
  );
  const token = cartTokenFromResponse(created);
  assert.ok(token);

  const otherGet = await cartGetHandler(
    makeRequest("GET", { host: OTHER_HOST, token }),
  );
  assert.strictEqual(otherGet.status, 200);
  assert.deepStrictEqual(await jsonBody(otherGet), {
    items: [],
    subtotal: 0,
    total: 0,
    lines: [],
    notices: [],
  });
  assert.strictEqual(cartTokenFromResponse(otherGet), token);

  assert.ok(await cartFor(token, BIZ));
  // Reads never persist, so the other business has no cart for this token.
  assert.strictEqual(await cartFor(token, BIZ2), null);

  const crossTenantAdd = await cartPostHandler(
    makeRequest("POST", {
      host: OTHER_HOST,
      token,
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(crossTenantAdd.status, 403);
  assert.strictEqual(
    (await jsonBody(crossTenantAdd)).code,
    "cross_business_product",
  );

  const otherCart = await cartFor(token, BIZ2);
  assert.ok(
    otherCart === null || otherCart.items.length === 0,
    "the rejected cross-tenant add must not put the product in the other business's cart",
  );
  const ownCart = await cartFor(token, BIZ);
  assert.ok(ownCart);
  assert.strictEqual(ownCart.items.length, 1);
  assert.strictEqual(await stockOf(product._id), 5);
});

test("the path business id cannot override the storefront host", async () => {
  const product = await createProduct({ price: 10, stock: 5 });

  const response = await cartPostHandler(
    makeRequest("POST", {
      pathId: BIZ2,
      body: { productId: product._id.toString(), quantity: 1 },
    }),
  );
  assert.strictEqual(response.status, 200);

  const token = cartTokenFromResponse(response);
  assert.ok(token);
  assert.ok(await cartFor(token, BIZ), "the host-resolved business owns the cart");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ2, ownerToken: token }), 0);
});

test("an unknown storefront host is rejected without creating a cart", async () => {
  const response = await cartGetHandler(
    makeRequest("GET", { host: "unknown.localhost:3000" }),
  );
  assert.strictEqual(response.status, 404);
  assert.strictEqual((await jsonBody(response)).code, "not_found");
  assert.strictEqual(await Cart.countDocuments({ business: BIZ }), 0);
});
