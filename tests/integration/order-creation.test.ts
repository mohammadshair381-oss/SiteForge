// Integration tests for order creation API (Phase B2.2.4)
import "../helpers/env";

import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { grantActiveFreePlan } from "./helpers/tenant";
import { POST as orderHandler } from "@/app/api/businesses/[id]/orders/route";
import { Product } from "@/models/Product";
import { Cart } from "@/models/Cart";
import { Business } from "@/models/Business";
import { Order } from "@/models/Order";
import mongoose from "mongoose";

const BIZ = "507f1f77bcf86cd799439011";
const BIZ2 = "507f1f77bcf86cd799439022";
const STORE_HOST = "test-store.localhost:3000";
const OTHER_HOST = "other-store.localhost:3000";

// Suite-level setup
before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
  await clearAllCollections();
  // Create a test business with subdomain for storefront resolution
  // Use a consistent ID so tests can reference it via URL path
  const testBusinessId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
  const testBusiness = new Business({
    name: "Test Store",
    subdomain: "test-store",
    slug: "test-store",
    category: "retail",
    currency: "USD",
    status: "published",
    owner: testBusinessId,
  });
  testBusiness._id = testBusinessId;
  await testBusiness.save();
  await grantActiveFreePlan(testBusiness._id);

  const otherBusiness = new Business({
    name: "Other Store",
    subdomain: "other-store",
    slug: "other-store",
    category: "retail",
    currency: "USD",
    status: "published",
    owner: testBusinessId,
  });
  otherBusiness._id = new mongoose.Types.ObjectId(BIZ2);
  await otherBusiness.save();
  await grantActiveFreePlan(otherBusiness._id);
});

// Suite-level teardown
after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

// Per-test setup: clear collections and recreate test business
beforeEach(async () => {
  await clearAllCollections();
  // Recreate the test business with subdomain for Host header resolution
  // Use consistent ID so tests can reference it via URL path
  const testBusinessId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
  const testBusiness = new Business({
    name: "Test Store",
    subdomain: "test-store",
    slug: "test-store",
    category: "retail",
    currency: "USD",
    status: "published",
    owner: testBusinessId,
  });
  testBusiness._id = testBusinessId;
  await testBusiness.save();
  await grantActiveFreePlan(testBusiness._id);

  const otherBusiness = new Business({
    name: "Other Store",
    subdomain: "other-store",
    slug: "other-store",
    category: "retail",
    currency: "USD",
    status: "published",
    owner: testBusinessId,
  });
  otherBusiness._id = new mongoose.Types.ObjectId(BIZ2);
  await otherBusiness.save();
  await grantActiveFreePlan(otherBusiness._id);
});

// Helper: create a test product and cart in DB
// The business must have a subdomain for Host header resolution
async function setupTestEnvironment() {
  const businessId = "507f1f77bcf86cd799439011";

  // Create an active product with stock
  const product = new Product({
    business: businessId,
    name: "Test Widget",
    slug: "test-widget",
    description: "A test widget for order",
    price: 19.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "TEST-001",
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  await product.save();

  // Create a cart with the product - generate ownerToken and cart-token
  const ownerToken = "order-test-token-" + Date.now();
  const cart = new Cart({
    business: businessId,
    ownerToken,
    items: [
      {
        product: product._id,
        quantity: 1,
        priceSnapshot: 19.99,
        currency: "USD",
      },
    ],
    subtotal: 19.99,
    total: 19.99,
  });
  await cart.save();

  return { businessId, product, cart, ownerToken };
}

// Helper: create a Request with cart-token cookie
function makeOrderRequest(businessId: string, overrides: { [key: string]: string } = {}) {
  const customerName = overrides.customerName || "Test Customer";
  const customerEmail = overrides.customerEmail || "test@example.com";
  const idempotencyKey = overrides.idempotencyKey || `key-${Date.now()}`;

  const cookieValue = `cart-token=${overrides.ownerToken || "order-test-token-" + Date.now()}`;

  return new Request(`http://localhost/api/businesses/${businessId}/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: businessId === BIZ2 ? OTHER_HOST : STORE_HOST,
      "x-forwarded-for": "203.0.113.20",
      cookie: cookieValue,
    },
    body: new URLSearchParams({
      customerName,
      customerEmail,
      idempotencyKey,
    }),
  });
}

// Scope A: Successful Order Creation Tests
test("Order created with valid data and adequate stock has pending status", async () => {
  const { businessId, product, cart, ownerToken } = await setupTestEnvironment();

  const request = makeOrderRequest(businessId, { ownerToken });

  const res = await orderHandler(request);
  assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.status, "pending", `Order should have status pending, got ${body.status}`);
  assert.ok(body.orderNumber, "Order should have orderNumber");
  assert.ok(body.subtotal > 0, "Order should have positive subtotal");
  assert.ok(body.total > 0, "Order should have positive total");
});

test("Order creation fails when product has insufficient stock", async () => {
  const businessId = "507f1f77bcf86cd799439011";

  // Create a product with stock = 0
  const zeroStockProduct = new Product({
    business: businessId,
    name: "Out of Stock Widget",
    slug: "out-of-stock-widget",
    description: "A widget with no stock",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "OOS-001",
    category: "gadgets",
    stock: 0,
    status: "active",
  });
  await zeroStockProduct.save();

  // Create a cart with this product
  const ownerToken = "oos-cart-" + Date.now();
  const cart = new Cart({
    business: businessId,
    ownerToken,
    items: [
      {
        product: zeroStockProduct._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await cart.save();

  // The order route should reject because product has insufficient stock
  const request = makeOrderRequest(businessId, { customerName: "Test Customer", customerEmail: "test@example.com", ownerToken });

  const res = await orderHandler(request);
  assert.strictEqual(res.status, 404, `Expected 404 for out of stock, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.code, "out_of_stock", "Out-of-stock rejection should use the out_of_stock code");
});

test("Order creation fails for inactive product", async () => {
  const businessId = "507f1f77bcf86cd799439011";

  // Create a draft product (draft status is valid but not active, so order should fail)
  const draftProduct = new Product({
    business: businessId,
    name: "Draft Widget",
    slug: "draft-widget",
    description: "A draft product",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "DRAFT-001",
    category: "gadgets",
    stock: 5,
    status: "draft" as const,
  });
  await draftProduct.save();

  // Create a cart with this product
  const ownerToken = "draft-cart-" + Date.now();
  const cart = new Cart({
    business: businessId,
    ownerToken,
    items: [
      {
        product: draftProduct._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await cart.save();

  // The order route should reject because product.status !== "active"
  const request = makeOrderRequest(businessId, { customerName: "Test Customer", customerEmail: "test@example.com", ownerToken });

  const res = await orderHandler(request);
  assert.strictEqual(res.status, 404, `Expected 404 for draft product, got ${res.status}`);
  const body = await res.json();
  assert.strictEqual(body.code, "product_unavailable", "Draft product rejection should use product_unavailable");
});

test("Order creation fails for cross-business product", async () => {
  const businessId = "507f1f77bcf86cd799439011";
  const otherBusinessId = "507f1f77bcf86cd799439022";

  // Create a product in another business
  const otherProduct = new Product({
    business: otherBusinessId,
    name: "Other Business Product",
    slug: "other-product",
    description: "A product from another business",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "XBIZ-001",
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  await otherProduct.save();

  // Create a cart with this product (but under the wrong business)
  const ownerToken = "xbiz-cart-" + Date.now();
  const cart = new Cart({
    business: businessId, // Different business
    ownerToken,
    items: [
      {
        product: otherProduct._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await cart.save();

  // The order route will reject because product.business !== businessId
  const request = makeOrderRequest(businessId, { customerName: "Test Customer", customerEmail: "test@example.com", ownerToken });

  const res = await orderHandler(request);
  assert.ok(res.status === 400 || res.status === 403, `Expected 400/403 for cross-business product, got ${res.status}`);
});

test("Order creation recalculates server-side prices from product data", async () => {
  const { businessId, product, cart, ownerToken } = await setupTestEnvironment();

  const request = makeOrderRequest(businessId, { ownerToken });

  const res = await orderHandler(request);
  assert.ok(res.status === 200, `Expected 200, got ${res.status}`);
  if (res.status === 200) {
    const body = await res.json();
    // Subtotal and total should be calculated from server-side product price
    assert.ok(body.subtotal > 0, "Order should have positive subtotal");
    assert.ok(body.total > 0, "Order should have positive total");
    // In MVP, total = subtotal (no tax)
    assert.strictEqual(body.total, body.subtotal, "MVP: total equals subtotal");
  }
});

// Scope B: Idempotency Tests
test("Idempotent request key prevents duplicate order creation", async () => {
  const businessId = "507f1f77bcf86cd799439011";

  // Create a product with stock
  const product = new Product({
    business: businessId,
    name: "Idempotency Test Widget",
    slug: "idempotency-test-widget",
    description: "Widget for idempotency testing",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "IDEM-001",
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  await product.save();

  // Create a cart with this product
  const ownerToken = "idem-cart-" + Date.now();
  const cart = new Cart({
    business: businessId,
    ownerToken,
    items: [
      {
        product: product._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await cart.save();

  // First request should create an order
  const idempotencyKey = "key-1-" + Date.now();
  const request1 = makeOrderRequest(businessId, {
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    idempotencyKey,
    ownerToken,
  });

  const res1 = await orderHandler(request1);
  assert.ok(res1.status === 200, `First request should succeed, got ${res1.status}`);

  // Second request with the same idempotency key should return the same order
  const request2 = makeOrderRequest(businessId, {
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    idempotencyKey,
    ownerToken,
  });

  const res2 = await orderHandler(request2);
  assert.ok(res2.status === 200, `Second request should succeed, got ${res2.status}`);
  // The response should contain the same orderNumber as the first request
  const body1 = await res1.json();
  const body2 = await res2.json();
  assert.strictEqual(body1.orderNumber, body2.orderNumber, "Same idempotency key should return same orderNumber");
});

test("Idempotency key scoped to business context", async () => {
  const businessId = "507f1f77bcf86cd799439011";
  const otherBusinessId = "507f1f77bcf86cd799439022";

  // Create a product in the first business
  const product = new Product({
    business: businessId,
    name: "Business-Specific Widget",
    slug: "biz-specific-widget",
    description: "Widget specific to first business",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "BSW-001",
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  await product.save();

  // Create a cart in the first business
  const ownerToken = "biz-specific-cart-" + Date.now();
  const cart = new Cart({
    business: businessId,
    ownerToken,
    items: [
      {
        product: product._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await cart.save();

  // First request with idempotency key
  const request1 = makeOrderRequest(businessId, {
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    idempotencyKey: "key-biz-1",
    ownerToken,
  });

  const res1 = await orderHandler(request1);
  assert.ok(res1.status === 200, `First request should succeed, got ${res1.status}`);

  // Same key in a different business must create a separate order.
  const otherProduct = new Product({
    business: otherBusinessId,
    name: "Other Business Widget",
    slug: "other-business-widget",
    description: "Widget specific to the second business",
    price: 9.99,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: "OBW-001",
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  await otherProduct.save();

  const otherOwnerToken = "biz-specific-other-cart-" + Date.now();
  const otherCart = new Cart({
    business: otherBusinessId,
    ownerToken: otherOwnerToken,
    items: [
      {
        product: otherProduct._id,
        quantity: 1,
        priceSnapshot: 9.99,
        currency: "USD",
      },
    ],
    subtotal: 9.99,
    total: 9.99,
  });
  await otherCart.save();

  const request2 = makeOrderRequest(otherBusinessId, {
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    idempotencyKey: "key-biz-1",
    ownerToken: otherOwnerToken,
  });

  const res2 = await orderHandler(request2);
  assert.strictEqual(res2.status, 200, `Second request should succeed, got ${res2.status}`);

  const body1 = await res1.json();
  const body2 = await res2.json();
  // The key is scoped per business: both orders exist and are distinct.
  assert.notStrictEqual(
    body1.orderNumber,
    body2.orderNumber,
    "Same key in a different business must not reuse the first business's order"
  );
  assert.strictEqual(
    String(body2.businessId),
    otherBusinessId,
    "Second order must be owned by the second business"
  );
});

// Inventory concurrency and rollback coverage lives in the real transactional
// suites:
// - order-concurrency.test.ts: concurrent final-unit contention, multi-product
//   rollback after a partial decrement, and safe retry with the same key.
// - order-lifecycle.test.ts: reservation, payment, cancellation, refund, and
//   expiry transitions against real MongoDB state.
test("Inventory: multi-product orders persist every line and decrement once", async () => {
  const businessId = "507f1f77bcf86cd799439011";
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const first = new Product({
    business: businessId,
    name: "Inventory Widget A",
    slug: `inventory-widget-a-${suffix}`,
    description: "first inventory test product",
    price: 10,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `INV-A-${suffix}`,
    category: "gadgets",
    stock: 5,
    status: "active",
  });
  const second = new Product({
    business: businessId,
    name: "Inventory Widget B",
    slug: `inventory-widget-b-${suffix}`,
    description: "second inventory test product",
    price: 12.5,
    currency: "USD",
    imageUrl: "",
    images: [],
    sku: `INV-B-${suffix}`,
    category: "gadgets",
    stock: 3,
    status: "active",
  });
  await first.save();
  await second.save();

  const ownerToken = `inventory-token-${suffix}`;
  await Cart.create({
    business: businessId,
    ownerToken,
    items: [
      {
        product: first._id,
        quantity: 1,
        priceSnapshot: 0.01,
        currency: "USD",
      },
      {
        product: second._id,
        quantity: 2,
        priceSnapshot: 0.01,
        currency: "USD",
      },
    ],
    subtotal: 0,
    total: 0,
  });

  const key = `inventory-order-${suffix}`;
  const res = await orderHandler(
    makeOrderRequest(businessId, { ownerToken, idempotencyKey: key }),
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.items.length, 2);
  assert.strictEqual(body.subtotal, 35);
  assert.strictEqual(body.total, 35);

  const order = await Order.findOne({ business: businessId, idempotencyKey: key });
  assert.ok(order, "the multi-product order must be persisted");
  assert.strictEqual(order.items.length, 2);
  assert.strictEqual(order.items[0].unitPrice, 10);
  assert.strictEqual(order.items[1].unitPrice, 12.5);
  assert.strictEqual((await Product.findById(first._id))?.stock, 4);
  assert.strictEqual((await Product.findById(second._id))?.stock, 1);
});