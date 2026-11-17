import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import { POST as samplesPOST } from "@/app/api/businesses/[id]/products/samples/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { POST as duplicatePOST } from "@/app/api/businesses/[id]/products/[productId]/duplicate/route";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { SAMPLE_PRODUCT_COUNT } from "@/lib/theme-preview-samples";

/** Starter samples are hidden drafts that can never reach a shopper as they are (lib/sample-products.ts). */

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

async function setup(options: { category?: string; productLimit?: number } = {}) {
  const { owner, business } = await createBusinessWithOwner();
  await Business.updateOne({ _id: business._id }, { $set: { category: options.category ?? "food", themeId: "bistro" } });
  const plan = await createPlan({ price: 0, productLimit: options.productLimit ?? 10 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { id: String(business._id), headers };
}

function json(method: string, url: string, body: unknown, headers: { cookie: string }) {
  return new Request(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

const samples = (id: string, action: "add" | "remove", headers: { cookie: string }) =>
  callHandler(samplesPOST, json("POST", `http://localhost/api/businesses/${id}/products/samples`, { action }, headers), { params: Promise.resolve({ id }) }) as Promise<Response>;

const patch = (id: string, productId: string, body: unknown, headers: { cookie: string }) =>
  callHandler(productPATCH, json("PATCH", `http://localhost/api/businesses/${id}/products/${productId}`, body, headers), { params: Promise.resolve({ id, productId }) }) as Promise<Response>;

test("samples are hidden drafts that suit the business, without stock, description or image address", async () => {
  const { id, headers } = await setup();
  const res = await samples(id, "add", headers);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).added, SAMPLE_PRODUCT_COUNT);
  const stored = await Product.find({ business: id }).lean();
  assert.equal(stored.length, SAMPLE_PRODUCT_COUNT);
  for (const product of stored) {
    assert.equal(product.status, "draft");
    assert.ok(product.sample, "marked as a sample");
    assert.equal(product.stock, 0);
    assert.equal(product.imageUrl, "", "a bundled photo is never stored as the product's image address");
    assert.equal(product.description, "");
    assert.equal(product.compareAtPrice ?? null, null, "no invented sale");
  }
  assert.ok(stored.some((product) => product.name === "Butter Croissant"), "a food business gets food samples");

  // Asking again adds nothing twice.
  assert.equal((await (await samples(id, "add", headers)).json()).added, 0);
});

test("a business that does not usually sell products gets no samples", async () => {
  const { id, headers } = await setup({ category: "services" });
  assert.equal((await (await samples(id, "add", headers)).json()).added, 0);
  assert.equal(await Product.countDocuments({ business: id }), 0);
});

test("samples never take more room than the plan has", async () => {
  const { id, headers } = await setup({ productLimit: 2 });
  assert.equal((await (await samples(id, "add", headers)).json()).added, 2);
  assert.equal(await Product.countDocuments({ business: id }), 2);
});

test("a sample cannot go on sale as it is, and becomes the owner's own once they change it", async () => {
  const { id, headers } = await setup();
  await samples(id, "add", headers);
  const sample = await Product.findOne({ business: id }).lean();
  assert.ok(sample);
  const productId = String(sample._id);

  const refused = await patch(id, productId, { status: "active" }, headers);
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).code, "sample_product");
  assert.equal((await Product.findById(productId).lean())?.status, "draft", "nothing saved");

  const sameName = await patch(id, productId, { name: sample.name, status: "active" }, headers);
  assert.equal(sameName.status, 422, "sending the sample's own name again changes nothing");

  const own = await patch(id, productId, { name: "Asha's sourdough", price: 7, status: "active" }, headers);
  assert.equal(own.status, 200);
  const stored = await Product.findById(productId).lean();
  assert.equal(stored?.status, "active");
  assert.equal(stored?.sample, "", "no longer a sample");
});

test("a copy of a sample is still a sample", async () => {
  const { id, headers } = await setup();
  await samples(id, "add", headers);
  const sample = await Product.findOne({ business: id }).lean();
  assert.ok(sample);
  const res = (await callHandler(duplicatePOST, json("POST", `http://localhost/api/businesses/${id}/products/${sample._id}/duplicate`, {}, headers), {
    params: Promise.resolve({ id, productId: String(sample._id) }),
  })) as Response;
  assert.equal(res.status, 201);
  const copy = await Product.findById((await res.json()).product._id).lean();
  assert.equal(copy?.sample, sample.sample);
  assert.equal(copy?.status, "draft");
});

test("removing samples archives only the ones still unchanged", async () => {
  const { id, headers } = await setup();
  await samples(id, "add", headers);
  const [first] = await Product.find({ business: id }).lean();
  await patch(id, String(first._id), { name: "My own product" }, headers);

  const res = await samples(id, "remove", headers);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, SAMPLE_PRODUCT_COUNT - 1);
  assert.equal(body.remaining, 0);
  assert.equal((await Product.findById(first._id).lean())?.status, "draft", "the owner's product stays");
  assert.equal(await Product.countDocuments({ business: id, status: "archived" }), SAMPLE_PRODUCT_COUNT - 1, "archived, never erased");
});

test("the quick start adds samples only when asked, next to the draft pages", async () => {
  await createPlan({ key: "free", price: 0 });
  const user = await createUser();
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  const create = (body: Record<string, unknown>) => callHandler(businessesPOST, makeAuthenticatedRequest("http://localhost/api/businesses", body, headers)) as Promise<Response>;

  const quick = await create({ name: "Asha Bakery", category: "food", themeId: "bistro", subdomain: "asha-bakery", addSamples: true });
  assert.equal(quick.status, 201);
  assert.equal((await quick.json()).samplesAdded, SAMPLE_PRODUCT_COUNT);
  const withSamples = await Business.findOne({ subdomain: "asha-bakery" }).lean();
  assert.equal(await Product.countDocuments({ business: withSamples?._id, status: "draft", sample: { $nin: ["", null] } }), SAMPLE_PRODUCT_COUNT);
  assert.equal(await Product.countDocuments({ business: withSamples?._id, status: "active" }), 0, "nothing on sale");

  const plain = await create({ name: "Plain Shop", category: "food", subdomain: "plain-shop" });
  assert.equal(plain.status, 201);
  const without = await Business.findOne({ subdomain: "plain-shop" }).lean();
  assert.equal(await Product.countDocuments({ business: without?._id }), 0, "API clients that do not ask get no samples");
});
