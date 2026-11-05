import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { createUser } from "./helpers/fixtures";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { createActionToken, consumeActionToken } from "@/lib/auth/action-tokens";
import { Business } from "@/models/Business";
import { InventoryMovement } from "@/models/InventoryMovement";
import { Media } from "@/models/Media";
import { Order } from "@/models/Order";
import { OrderRefund } from "@/models/OrderRefund";
import { Product } from "@/models/Product";
import { POST as fulfillmentPOST } from "@/app/api/businesses/[id]/manage/orders/[orderId]/fulfillment/route";
import { GET as localMediaGET } from "@/app/api/businesses/[id]/local-media/route";
import { DELETE as mediaDELETE } from "@/app/api/businesses/[id]/media/[mediaId]/route";
import { GET as membersGET } from "@/app/api/businesses/[id]/members/route";
import { PATCH as orderPATCH } from "@/app/api/businesses/[id]/manage/orders/[orderId]/route";
import { DELETE as productDELETE, PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as passwordPOST } from "@/app/api/auth/password/route";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearRequestCookies();
  await clearAllCollections();
});

async function setup(status: "draft" | "published" | "suspended" = "published") {
  const { owner, business } = await createBusinessWithOwner({ status });
  const plan = await createPlan({ price: 0, productLimit: 5 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { owner, business, headers, id: String(business._id) };
}

const req = (method: string, body: unknown, headers: unknown, url = "http://localhost/x") =>
  new Request(url, { method, headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) }, body: method === "GET" ? undefined : JSON.stringify(body) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

async function mediaFor(id: string) {
  return Media.create({
    business: id, storageKey: `media/${id}/${crypto.randomUUID()}.jpg`, url: "https://cdn.example/x.jpg", kind: "image", mimeType: "image/jpeg", size: 10, originalFilename: "x.jpg", contentType: "image/jpeg",
  });
}

test("the public image route never changes data, whatever is asked", async () => {
  const { id } = await setup();
  const media = await mediaFor(id);
  const key = Buffer.from(media.storageKey).toString("base64");
  const url = `http://localhost/api/businesses/${id}/local-media?key=${encodeURIComponent(key)}`;

  // Not in local mode: the route does not exist.
  delete process.env.LOCAL_MEDIA_ENABLED;
  assert.equal((await callHandler(localMediaGET, req("GET", null, {}, url), ctx({ id }))).status, 404);
  assert.equal((await Media.findById(media._id).lean())?.deletedAt ?? null, null);

  // In local mode, a file that is not on disk is only a 404.
  process.env.LOCAL_MEDIA_ENABLED = "true";
  try {
    assert.equal((await callHandler(localMediaGET, req("GET", null, {}, url), ctx({ id }))).status, 404);
    assert.equal((await Media.findById(media._id).lean())?.deletedAt ?? null, null);
    assert.equal((await callHandler(localMediaGET, req("GET", null, {}, url), ctx({ id: "not-an-id" }))).status, 404);
  } finally {
    delete process.env.LOCAL_MEDIA_ENABLED;
  }
});

test("the order page's refund action leaves a record and keeps later refunds honest", async () => {
  const { id, business } = await setup();
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const headers = await createAuthHeadersForUser(String(manager._id), "user", manager.tokenVersion);
  const product = await Product.create({ business: id, name: "Mug", slug: "mug", price: 100, stock: 3, status: "active" });
  const order = await Order.create({
    business: id, ownerToken: "t-1", customerName: "Ada", customerEmail: "ada@example.test",
    items: [{ product: String(product._id), productName: "Mug", quantity: 1, unitPrice: 100, currency: "INR" }],
    subtotal: 100, total: 100, status: "paid", currency: "INR", inventoryState: "consumed", paidAt: new Date(), paymentMethod: "cod", refundedTotal: 40,
  });
  const res = await callHandler(orderPATCH, req("PATCH", { action: "refund" }, headers), ctx({ id, orderId: String(order._id) }));
  assert.equal(res.status, 200);
  const stored = await Order.findById(order._id).lean();
  assert.equal(stored?.status, "refunded");
  assert.equal(stored?.refundedTotal, 100);
  const [record] = await OrderRefund.find({ order: order._id }).lean();
  assert.equal(record.amount, 60, "only what was left");
  assert.equal(String(record.createdBy), String(manager._id));
  assert.equal((await Product.findById(product._id).lean())?.stock, 3, "no stock back");
  assert.equal((await callHandler(orderPATCH, req("PATCH", { action: "refund" }, headers), ctx({ id, orderId: String(order._id) }))).status, 409);
});

test("moving an order on keeps its tracking unless it is changed", async () => {
  const { id, headers } = await setup();
  const order = await Order.create({
    business: id, ownerToken: "t-2", customerName: "Ada", customerEmail: "ada@example.test",
    items: [{ product: "507f1f77bcf86cd799439011", productName: "Mug", quantity: 1, unitPrice: 10, currency: "INR" }],
    subtotal: 10, total: 10, status: "paid", currency: "INR", inventoryState: "consumed", paidAt: new Date(), paymentMethod: "cod",
  });
  const move = (body: unknown) => callHandler(fulfillmentPOST, req("POST", body, headers), ctx({ id, orderId: String(order._id) }));
  assert.equal((await move({ status: "shipped", trackingCarrier: "Post", trackingNumber: "T1", trackingUrl: "https://track.example/T1" })).status, 200);
  assert.equal((await move({ status: "delivered" })).status, 200);
  let stored = await Order.findById(order._id).lean();
  assert.deepEqual([stored?.fulfillmentStatus, stored?.trackingCarrier, stored?.trackingNumber, stored?.trackingUrl], ["delivered", "Post", "T1", "https://track.example/T1"]);
  // An empty value still clears it.
  assert.equal((await move({ status: "delivered", trackingUrl: "" })).status, 200);
  stored = await Order.findById(order._id).lean();
  assert.deepEqual([stored?.trackingNumber, stored?.trackingUrl], ["T1", ""]);
});

test("stock changes need the stock the editor was shown", async () => {
  const { id, headers } = await setup();
  const product = await Product.create({ business: id, name: "Mug", slug: "mug", price: 10, stock: 7, status: "active" });
  const productId = String(product._id);
  const refused = await callHandler(productPATCH, req("PATCH", { stock: 100 }, headers), ctx({ id, productId }));
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).code, "expected_stock_required");
  assert.equal((await Product.findById(product._id).lean())?.stock, 7);
  // Sending the value it already has changes nothing, so a full form still saves.
  assert.equal((await callHandler(productPATCH, req("PATCH", { stock: 7, name: "Mug two" }, headers), ctx({ id, productId }))).status, 200);
  assert.equal(await InventoryMovement.countDocuments({ product: product._id }), 0);
  assert.equal((await callHandler(productPATCH, req("PATCH", { stock: 9, expectedStock: 7 }, headers), ctx({ id, productId }))).status, 200);
  assert.equal((await Product.findById(product._id).lean())?.stock, 9);
  assert.equal(await InventoryMovement.countDocuments({ product: product._id }), 1);
});

test("team lists do not say who is a platform admin", async () => {
  const { id, headers } = await setup();
  const res = await callHandler(membersGET, req("GET", null, headers), ctx({ id }));
  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(await res.json()).includes("platformRole"), false);
});

test("a suspended store is frozen", async () => {
  const { id, headers } = await setup("suspended");
  const product = await Product.create({ business: id, name: "Mug", slug: "mug", price: 10, stock: 1, status: "active" });
  const media = await mediaFor(id);
  assert.equal((await callHandler(productDELETE, req("DELETE", {}, headers), ctx({ id, productId: String(product._id) }))).status, 403);
  assert.equal((await callHandler(productPATCH, req("PATCH", { status: "archived" }, headers), ctx({ id, productId: String(product._id) }))).status, 403);
  assert.equal((await Product.findById(product._id).lean())?.status, "active");
  assert.equal((await callHandler(mediaDELETE, req("DELETE", {}, headers), ctx({ id, mediaId: String(media._id) }))).status, 403);
  assert.equal((await Media.findById(media._id).lean())?.deletedAt ?? null, null);
  assert.equal((await callHandler(businessPATCH, req("PATCH", { name: "Renamed" }, headers), ctx({ id }))).status, 403);
  assert.notEqual((await Business.findById(id).lean())?.name, "Renamed");
});

test("changing a password retires reset links asked for earlier", async () => {
  const password = "Original-pass-123";
  const user = await createUser({ password });
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  const { rawToken } = await createActionToken(user._id, "password_reset", 60 * 60 * 1000);
  const res = await callHandler(passwordPOST, req("POST", { currentPassword: password, newPassword: "Changed-pass-456" }, headers));
  assert.equal(res.status, 200);
  assert.equal((await consumeActionToken(rawToken, "password_reset")).ok, false);
});
