/**
 * Phase B2.3.7 — local-only order-expiry harness.
 *
 * This file proves that the existing order-expiry services can be invoked
 * from a standalone test process against a throwaway in-memory MongoDB
 * replica set. It deliberately imports application/database modules only
 * after `startIntegrationSuite()` has validated the local URI and assigned it
 * to `process.env.MONGODB_URI`.
 *
 * Detailed lifecycle edge cases (legacy/null orders, missing products,
 * rollback, batch limits, and races) live in `order-lifecycle.test.ts`. This
 * harness focuses on the safety boundary and the two expiry entry points.
 */

import "../helpers/env";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import {
  getTestMongoUri,
  startIntegrationSuite,
  stopIntegrationSuite,
} from "./helpers/env";
import { assertLocalTestMongoUri } from "./helpers/mongo-safety";

type DbHelpers = typeof import("./helpers/db");

let db: DbHelpers;
let Business: typeof import("@/models/Business").Business;
let Product: typeof import("@/models/Product").Product;
let Order: typeof import("@/models/Order").Order;
let lifecycle: typeof import("@/lib/orders/lifecycle");

before(async () => {
  await startIntegrationSuite();

  // The shared suite already validates its generated URI, but assert again at
  // the point of use so this harness fails loudly if that protection changes.
  assertLocalTestMongoUri(getTestMongoUri(), {
    label: "Started integration test MongoDB URI",
  });

  // Import database modules only after MONGODB_URI points at the in-memory
  // replica set. This keeps lib/env.ts from caching a persistent URI.
  db = await import("./helpers/db");
  await db.connectTestDB();

  const [businessModule, productModule, orderModule, lifecycleModule] =
    await Promise.all([
      import("@/models/Business"),
      import("@/models/Product"),
      import("@/models/Order"),
      import("@/lib/orders/lifecycle"),
    ]);

  Business = businessModule.Business;
  Product = productModule.Product;
  Order = orderModule.Order;
  lifecycle = lifecycleModule;
});

after(async () => {
  try {
    if (db) {
      await db.disconnectTestDB();
    }
  } finally {
    await stopIntegrationSuite();
  }
});

beforeEach(async () => {
  await db.clearAllCollections();
});

async function seedExpiredReservation(
  options: {
    expiresAt?: Date;
    inventoryState?: "reserved" | null;
  } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const businessId = new mongoose.Types.ObjectId();

  const business = await Business.create({
    _id: businessId,
    name: `Expiry harness ${suffix}`,
    slug: `expiry-harness-${suffix}`,
    subdomain: `expiry-harness-${suffix}`,
    category: "retail",
    owner: new mongoose.Types.ObjectId(),
    currency: "USD",
  });

  // Stock 4 represents a reservation already taken from an original 5.
  const product = await Product.create({
    business: businessId,
    name: `Expiry harness product ${suffix}`,
    slug: `expiry-harness-product-${suffix}`,
    description: "throwaway expiry harness product",
    price: 10,
    currency: "USD",
    sku: `EXP-${suffix}`,
    category: "test",
    stock: 4,
    status: "active",
  });

  const order = await Order.create({
    business: businessId,
    ownerToken: `expiry-harness-${crypto.randomUUID()}`,
    customerName: "Expiry Harness Customer",
    customerEmail: "expiry-harness@example.com",
    items: [
      {
        product: String(product._id),
        productName: product.name,
        quantity: 1,
        unitPrice: product.price,
        currency: product.currency,
      },
    ],
    subtotal: product.price,
    total: product.price,
    status: "pending",
    inventoryState: options.inventoryState === undefined ? "reserved" : options.inventoryState,
    reservationExpiresAt:
      options.expiresAt === undefined ? new Date(Date.now() - 60_000) : options.expiresAt,
  });

  return { business, businessId, product, order };
}

async function cleanupBusiness(businessId: mongoose.Types.ObjectId): Promise<void> {
  await Order.deleteMany({ business: businessId });
  await Product.deleteMany({ business: businessId });
  await Business.deleteOne({ _id: businessId });
}

async function stockOf(productId: mongoose.Types.ObjectId): Promise<number> {
  const product = await Product.findById(productId).lean();
  assert.ok(product, "product should still exist");
  return (product as { stock: number }).stock;
}

// ---------------------------------------------------------------------------
// 1. Strict local-only URI guard
// ---------------------------------------------------------------------------

test("local-only guard accepts the in-memory URI and rejects persistent URIs", () => {
  assert.strictEqual(
    assertLocalTestMongoUri("mongodb://127.0.0.1:27017/saas_test_example?replicaSet=rs0"),
    "mongodb://127.0.0.1:27017/saas_test_example?replicaSet=rs0",
  );
  assert.strictEqual(
    assertLocalTestMongoUri("mongodb://localhost:27018/saas_test_example"),
    "mongodb://localhost:27018/saas_test_example",
  );
  assert.strictEqual(
    assertLocalTestMongoUri(getTestMongoUri(), {
      label: "Started integration test MongoDB URI",
    }),
    getTestMongoUri(),
  );
  assert.strictEqual(
    process.env.MONGODB_URI,
    getTestMongoUri(),
    "the harness must replace any inherited MONGODB_URI",
  );

  const rejected: Array<{ uri: string; reason: RegExp }> = [
    { uri: "mongodb+srv://cluster0.example.com/saas_test_example", reason: /scheme/ },
    { uri: "mongodb://cluster0.example.com:27017/saas_test_example", reason: /localhost/ },
    { uri: "mongodb://localhost.example.com/saas_test_example", reason: /localhost/ },
    { uri: "mongodb://127.0.0.2:27017/saas_test_example", reason: /localhost/ },
    { uri: "mongodb://localhost:27017/saas_production", reason: /saas_test_/ },
    { uri: "mongodb://user:pass@localhost:27017/saas_test_example", reason: /credentials/ },
    { uri: "http://localhost:27017/saas_test_example", reason: /scheme/ },
    { uri: "not a MongoDB URI", reason: /valid/ },
  ];

  for (const { uri, reason } of rejected) {
    assert.throws(
      () => assertLocalTestMongoUri(uri),
      reason,
      `expected guard to reject ${uri}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Business-scoped expiry through the standalone harness
// ---------------------------------------------------------------------------

test("harness runs scoped expiry and cannot release another business", async () => {
  const scoped = await seedExpiredReservation();
  const other = await seedExpiredReservation();

  try {
    assert.strictEqual(await stockOf(scoped.product._id), 4, "reservation starts consumed");

    const sweep = await lifecycle.releaseExpiredOrders({
      businessId: String(scoped.businessId),
      now: new Date(),
      limit: 10,
    });

    assert.strictEqual(sweep.processed, 1);
    assert.strictEqual(sweep.released, 1);
    assert.strictEqual(sweep.failed, 0);
    assert.deepStrictEqual(sweep.failures, []);

    const released = await Order.findById(scoped.order._id).lean();
    assert.ok(released, "released order should still exist");
    assert.strictEqual(
      (released as { status: string }).status,
      "cancelled",
      "expired order must be cancelled",
    );
    assert.strictEqual(
      (released as { inventoryState: string }).inventoryState,
      "released",
      "expired order must mark inventory released",
    );
    assert.strictEqual((released as { cancelReason: string }).cancelReason, "expired");
    assert.ok((released as { cancelledAt?: Date }).cancelledAt);
    assert.ok((released as { inventoryReleasedAt?: Date }).inventoryReleasedAt);
    assert.strictEqual(await stockOf(scoped.product._id), 5, "stock is restored exactly once");

    const secondSweep = await lifecycle.releaseExpiredOrders({
      businessId: String(scoped.businessId),
      now: new Date(),
      limit: 10,
    });
    assert.strictEqual(secondSweep.processed, 0, "released orders are no longer due");
    assert.strictEqual(await stockOf(scoped.product._id), 5, "second sweep must not restock");

    const untouched = await Order.findById(other.order._id).lean();
    assert.ok(untouched, "other business order should still exist");
    assert.strictEqual((untouched as { status: string }).status, "pending");
    assert.strictEqual(
      (untouched as { inventoryState: string }).inventoryState,
      "reserved",
    );
    assert.strictEqual(
      await stockOf(other.product._id),
      4,
      "scoped expiry must not touch another business",
    );
  } finally {
    await cleanupBusiness(scoped.businessId);
    await cleanupBusiness(other.businessId);
  }
});

// ---------------------------------------------------------------------------
// 3. Isolated global expiry through the standalone harness
// ---------------------------------------------------------------------------

test("harness runs the explicit global expiry sweep only in isolation", async () => {
  const first = await seedExpiredReservation();
  const second = await seedExpiredReservation();
  const future = await seedExpiredReservation({
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });

  try {
    const sweep = await lifecycle.releaseExpiredOrdersInternalGlobal({
      now: new Date(),
      limit: 10,
    });

    assert.strictEqual(sweep.processed, 2, "only due orders are processed");
    assert.strictEqual(sweep.released, 2);
    assert.strictEqual(sweep.failed, 0);

    for (const seeded of [first, second]) {
      const released = await Order.findById(seeded.order._id).lean();
      assert.ok(released);
      assert.strictEqual((released as { status: string }).status, "cancelled");
      assert.strictEqual(
        (released as { inventoryState: string }).inventoryState,
        "released",
      );
      assert.strictEqual(await stockOf(seeded.product._id), 5);
    }

    const notYetDue = await Order.findById(future.order._id).lean();
    assert.ok(notYetDue);
    assert.strictEqual((notYetDue as { status: string }).status, "pending");
    assert.strictEqual(await stockOf(future.product._id), 4);
  } finally {
    await cleanupBusiness(first.businessId);
    await cleanupBusiness(second.businessId);
    await cleanupBusiness(future.businessId);
  }
});
