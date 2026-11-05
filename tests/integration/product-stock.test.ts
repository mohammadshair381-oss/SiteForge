import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import { POST as productsPOST } from "@/app/api/businesses/[id]/products/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { Product } from "@/models/Product";

/** Stock is settable from the dashboard without clobbering concurrent orders. */

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

async function setup() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0, productLimit: 10 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { id: String(business._id), headers };
}

function json(method: string, url: string, body: unknown, headers: { cookie: string }) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createProduct(id: string, headers: { cookie: string }, stock: number) {
  const res = (await callHandler(
    productsPOST,
    json("POST", `http://localhost/api/businesses/${id}/products`, { name: "Mug", price: 9, stock, status: "active" }, headers),
    { params: Promise.resolve({ id }) },
  )) as Response;
  assert.equal(res.status, 201);
  return String((await res.json()).product._id);
}

function patch(id: string, productId: string, body: unknown, headers: { cookie: string }) {
  return callHandler(
    productPATCH,
    json("PATCH", `http://localhost/api/businesses/${id}/products/${productId}`, body, headers),
    { params: Promise.resolve({ id, productId }) },
  ) as Promise<Response>;
}

const stockOf = async (productId: string) => (await Product.findById(productId).lean())?.stock;

test("stock set at creation is stored", async () => {
  const { id, headers } = await setup();
  const productId = await createProduct(id, headers, 7);
  assert.equal(await stockOf(productId), 7);
});

test("editing other fields never touches stock", async () => {
  const { id, headers } = await setup();
  const productId = await createProduct(id, headers, 7);
  await Product.updateOne({ _id: productId }, { $inc: { stock: -2 } }); // an order reserved 2
  const res = await patch(id, productId, { name: "Big mug", price: 11 }, headers);
  assert.equal(res.status, 200);
  assert.equal(await stockOf(productId), 5);
});

test("a guarded stock edit applies when stock is unchanged", async () => {
  const { id, headers } = await setup();
  const productId = await createProduct(id, headers, 7);
  const res = await patch(id, productId, { stock: 20, expectedStock: 7, name: "Mug v2" }, headers);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.product.stock, 20);
  const stored = await Product.findById(productId).lean();
  assert.equal(stored?.stock, 20);
  assert.equal(stored?.name, "Mug v2");
});

test("a guarded stock edit is rejected if an order changed stock meanwhile", async () => {
  const { id, headers } = await setup();
  const productId = await createProduct(id, headers, 7);
  await Product.updateOne({ _id: productId }, { $inc: { stock: -3 } }); // concurrent reservation
  const res = await patch(id, productId, { stock: 7, expectedStock: 7, name: "Renamed" }, headers);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "stock_changed");
  const stored = await Product.findById(productId).lean();
  assert.equal(stored?.stock, 4, "the reservation is preserved");
  assert.equal(stored?.name, "Mug", "nothing else was applied either");
});

test("stock must be a non-negative integer", async () => {
  const { id, headers } = await setup();
  const productId = await createProduct(id, headers, 7);
  assert.equal((await patch(id, productId, { stock: -1, expectedStock: 7 }, headers)).status, 422);
  assert.equal((await patch(id, productId, { stock: 1.5, expectedStock: 7 }, headers)).status, 422);
  assert.equal(await stockOf(productId), 7);
});
