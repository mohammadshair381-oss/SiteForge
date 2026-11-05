import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { checkCoupon, claimCouponUse, createCoupon, customerKeyFor, emailKeyFor, previewCoupon, recordRedemption } from "@/lib/coupons";
import { createOrderRefund, refreshOrderRefund, syncRefundFromProvider } from "@/lib/payments/order-refunds";
import { encryptCredential } from "@/lib/payments/credentials-crypto";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Business } from "@/models/Business";
import { Coupon } from "@/models/Coupon";
import { CouponRedemption } from "@/models/CouponRedemption";
import { InventoryMovement } from "@/models/InventoryMovement";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { OrderRefund } from "@/models/OrderRefund";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import { GET as ordersGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { GET as orderGET } from "@/app/api/businesses/[id]/manage/orders/[orderId]/route";
import { POST as refundPOST } from "@/app/api/businesses/[id]/manage/orders/[orderId]/refund/route";
import { PUT as notePUT } from "@/app/api/businesses/[id]/manage/orders/[orderId]/note/route";
import { GET as exportGET } from "@/app/api/businesses/[id]/manage/orders/export/route";
import { POST as duplicatePOST } from "@/app/api/businesses/[id]/products/[productId]/duplicate/route";
import { GET as productsGET } from "@/app/api/businesses/[id]/products/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { PUT as taxPUT } from "@/app/api/businesses/[id]/tax/route";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  process.env.PAYMENT_CREDENTIALS_KEY ??= Buffer.alloc(32, 7).toString("base64");
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
});

async function setup(status: "draft" | "published" = "published") {
  const { owner, business } = await createBusinessWithOwner({ status });
  const plan = await createPlan({ price: 0, productLimit: 5 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { owner, business, headers, id: String(business._id) };
}

const req = (method: string, body: unknown, headers: unknown, url = "http://localhost/x") =>
  new Request(url, { method, headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

async function paidOrder(businessId: string, overrides: Record<string, unknown> = {}) {
  const product = await Product.create({ business: businessId, name: "Mug", slug: `mug-${Math.random().toString(36).slice(2)}`, price: 100, stock: 3, status: "active", currency: "INR" });
  const order = await Order.create({
    business: businessId, ownerToken: `t-${Math.random()}`, customerName: "Ada", customerEmail: "ada@example.test",
    items: [{ product: String(product._id), productName: "Mug", quantity: 1, unitPrice: 100, currency: "INR" }],
    subtotal: 100, total: 100, status: "paid", currency: "INR", inventoryState: "consumed", paidAt: new Date(), paymentMethod: "online", ...overrides,
  });
  return { order, product };
}

async function connectRazorpay(businessId: string, mode: "test" | "live" = "test") {
  await BusinessPaymentAccount.create({
    business: businessId, provider: "razorpay", mode, status: "active", keyId: `rzp_${mode}_abcdefgh`,
    keySecretEnc: encryptCredential("secret"), webhookSecretEnc: encryptCredential("hook"), connectedAt: new Date(),
  });
}

async function recordPaid(businessId: string, orderId: unknown, amountMinor = 10000) {
  return OrderPayment.create({
    business: businessId, order: orderId, provider: "razorpay", mode: "test", providerLinkId: `plink_${Math.random().toString(36).slice(2)}`,
    shortUrl: "https://rzp.io/x", providerPaymentId: "pay_abc123", amountMinor, currency: "INR", status: "paid", orderOutcome: "applied", paidAt: new Date(),
  });
}

/** A Razorpay that answers refunds, and never touches the network. */
function fakeRazorpay(reply: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const { status, body } = reply(url, init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { impl, calls };
}

// ---- Coupons ----------------------------------------------------------------------------------

test("product and category coupons discount only their lines, and refuse a cart without them", async () => {
  const { id } = await setup();
  const product = new mongoose.Types.ObjectId();
  await Product.create({ _id: product, business: id, name: "Tea", slug: "tea", price: 10, status: "active" });
  await createCoupon(id, { code: "TEA50", type: "percent", value: 50, appliesTo: "products", productIds: [String(product)], maxDiscount: 3 });
  const lines = [
    { product: String(product), category: "Tea", lineTotal: 10 },
    { product: "other", category: "Cups", lineTotal: 90 },
  ];
  const applied = await previewCoupon({ businessId: id, code: "tea50", subtotal: 100, currency: "USD", lines });
  assert.equal(applied.eligible, 10);
  assert.equal(applied.maxDiscount, 3);
  await assert.rejects(previewCoupon({ businessId: id, code: "tea50", subtotal: 90, currency: "USD", lines: [lines[1]] }), (error: { code?: string }) => error.code === "coupon_no_eligible_items");
});

test("a coupon cannot name another store's products", async () => {
  const { id } = await setup();
  const other = await setup();
  const theirs = await Product.create({ business: other.id, name: "Theirs", slug: "theirs", price: 10, status: "active" });
  await assert.rejects(createCoupon(id, { code: "NOPE1", type: "percent", value: 10, appliesTo: "products", productIds: [String(theirs._id)] }), (error: { code?: string }) => error.code === "invalid_coupon_products");
});

test("per-customer limits follow the person across an account, guest checkout and address tricks", async () => {
  const { id } = await setup();
  const created = await createCoupon(id, { code: "ONCE1", type: "percent", value: 10, perCustomerLimit: 1 });
  const session = await mongoose.startSession();
  const order = new mongoose.Types.ObjectId();
  const accountKey = customerKeyFor({ customerId: "507f1f77bcf86cd799439011", email: "ada.l@gmail.com" });
  await session.withTransaction(async () => {
    const coupon = await checkCoupon({ session, businessId: id, code: "ONCE1", subtotal: 100, currency: "USD" });
    await claimCouponUse({ session, businessId: id, coupon, customerKey: accountKey, emailKey: emailKeyFor("ada.l@gmail.com") });
    await recordRedemption({ session, businessId: id, coupon, orderId: order, customerKey: accountKey, emailKey: emailKeyFor("ada.l@gmail.com"), amount: 10, currency: "USD" });
  });
  await session.endSession();

  // The same mailbox as a guest, written differently, is the same person.
  assert.equal(emailKeyFor("ADA.L+promo@gmail.com"), emailKeyFor("adal@googlemail.com".replace("googlemail", "gmail")));
  for (const email of ["ada.l@gmail.com", "adal+promo@gmail.com"]) {
    const retry = await mongoose.startSession();
    await assert.rejects(
      retry.withTransaction(async () => {
        const coupon = await checkCoupon({ session: retry, businessId: id, code: "ONCE1", subtotal: 100, currency: "USD" });
        await claimCouponUse({ session: retry, businessId: id, coupon, customerKey: customerKeyFor({ email }), emailKey: emailKeyFor(email) });
      }),
      (error: { code?: string }) => error.code === "coupon_customer_limit",
    );
    await retry.endSession();
  }
  assert.equal((await Coupon.findById(created.id).lean())?.usedCount, 1, "the refused attempts rolled back");
  assert.equal(await CouponRedemption.countDocuments({ coupon: created.id }), 1);
});

// ---- Refunds ----------------------------------------------------------------------------------

test("a Razorpay refund settles from Razorpay's answer, and cannot exceed what was paid", async () => {
  const { id, owner } = await setup();
  const { order } = await paidOrder(id);
  await connectRazorpay(id);
  await recordPaid(id, order._id);
  const { impl, calls } = fakeRazorpay(() => ({ status: 200, body: { id: "rfnd_one", payment_id: "pay_abc123", amount: 4000, currency: "INR", status: "processed" } }));

  await createOrderRefund({ businessId: id, orderId: String(order._id), amount: 40, method: "razorpay", actorId: owner._id, fetchImpl: impl });
  const partly = (await Order.findById(order._id).lean())!;
  assert.equal(partly.status, "paid");
  assert.equal(partly.refundedTotal, 40);
  assert.equal(partly.refundHoldTotal, 0);
  assert.ok(calls[0].headers["X-Refund-Idempotency"], "the idempotency key is sent");

  await assert.rejects(
    createOrderRefund({ businessId: id, orderId: String(order._id), amount: 61, method: "razorpay", actorId: owner._id, fetchImpl: impl }),
    (error: { code?: string }) => error.code === "refund_amount_invalid",
  );
});

test("concurrent refunds never exceed the amount paid", async () => {
  const { id, owner } = await setup();
  const { order } = await paidOrder(id);
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => createOrderRefund({ businessId: id, orderId: String(order._id), amount: 60, method: "manual", actorId: owner._id })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await Order.findById(order._id).lean())?.refundedTotal, 60);
});

test("a lost response keeps the refund held, and checking again settles it with the same key", async () => {
  const { id, owner } = await setup();
  const { order } = await paidOrder(id);
  await connectRazorpay(id);
  await recordPaid(id, order._id);
  const down = async () => { throw new Error("connection reset"); };
  await assert.rejects(createOrderRefund({ businessId: id, orderId: String(order._id), method: "razorpay", actorId: owner._id, fetchImpl: down }), (error: { code?: string }) => error.code === "refund_outcome_unknown");
  const held = (await Order.findById(order._id).lean())!;
  assert.equal(held.refundHoldTotal, 100);
  assert.equal(held.refundedTotal ?? 0, 0);
  const refund = (await OrderRefund.findOne({ order: order._id }).lean())!;
  assert.equal(refund.status, "pending");

  const { impl, calls } = fakeRazorpay(() => ({ status: 200, body: { id: "rfnd_two", payment_id: "pay_abc123", amount: 10000, currency: "INR", status: "processed" } }));
  await refreshOrderRefund({ businessId: id, refundId: String(refund._id), fetchImpl: impl });
  assert.equal(calls[0].headers["X-Refund-Idempotency"], refund.idempotencyKey);
  const done = (await Order.findById(order._id).lean())!;
  assert.equal(done.status, "refunded");
  assert.equal(done.refundHoldTotal, 0);

  // Repeating changes nothing.
  await syncRefundFromProvider({ businessId: id, providerRefundId: "rfnd_two", fetchImpl: impl });
  assert.equal((await Order.findById(order._id).lean())?.refundedTotal, 100);
});

test("a refused refund gives its hold back", async () => {
  const { id, owner } = await setup();
  const { order } = await paidOrder(id);
  await connectRazorpay(id);
  await recordPaid(id, order._id);
  const { impl } = fakeRazorpay(() => ({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR" } } }));
  await assert.rejects(createOrderRefund({ businessId: id, orderId: String(order._id), method: "razorpay", actorId: owner._id, fetchImpl: impl }), (error: { code?: string }) => error.code === "refund_refused");
  assert.equal((await Order.findById(order._id).lean())?.refundHoldTotal, 0);
  assert.equal((await OrderRefund.findOne({ order: order._id }).lean())?.status, "failed");
});

test("a refund started in Razorpay is recorded once, only for this business's own payment", async () => {
  const { id } = await setup();
  const { order } = await paidOrder(id);
  await connectRazorpay(id);
  await recordPaid(id, order._id);
  const { impl } = fakeRazorpay(() => ({ status: 200, body: { id: "rfnd_dash", payment_id: "pay_abc123", amount: 2500, currency: "INR", status: "processed" } }));
  await syncRefundFromProvider({ businessId: id, providerRefundId: "rfnd_dash", fetchImpl: impl });
  await syncRefundFromProvider({ businessId: id, providerRefundId: "rfnd_dash", fetchImpl: impl });
  assert.equal((await Order.findById(order._id).lean())?.refundedTotal, 25);
  assert.equal(await OrderRefund.countDocuments({ order: order._id }), 1);

  const other = await setup();
  await connectRazorpay(other.id);
  const foreign = await syncRefundFromProvider({ businessId: other.id, providerRefundId: "rfnd_dash", fetchImpl: impl });
  assert.equal(foreign.outcome, "unknown");
});

test("restocking happens once, only with a full refund", async () => {
  const { id, owner } = await setup();
  const { order, product } = await paidOrder(id);
  await assert.rejects(createOrderRefund({ businessId: id, orderId: String(order._id), amount: 10, method: "manual", restock: true, actorId: owner._id }), (error: { code?: string }) => error.code === "restock_needs_full_refund");
  await createOrderRefund({ businessId: id, orderId: String(order._id), method: "manual", restock: true, actorId: owner._id });
  assert.equal((await Product.findById(product._id).lean())?.stock, 4);
  assert.equal((await Order.findById(order._id).lean())?.inventoryState, "released");
  assert.equal(await InventoryMovement.countDocuments({ product: product._id, reason: "order_refunded" }), 1);
  await assert.rejects(createOrderRefund({ businessId: id, orderId: String(order._id), method: "manual", actorId: owner._id }), (error: { code?: string }) => error.code === "already_refunded");
});

test("test and live payments never use each other's keys", async () => {
  const { id, owner } = await setup();
  const { order } = await paidOrder(id);
  await connectRazorpay(id, "live");
  await recordPaid(id, order._id); // a test-mode payment
  const { impl, calls } = fakeRazorpay(() => ({ status: 200, body: {} }));
  await assert.rejects(createOrderRefund({ businessId: id, orderId: String(order._id), method: "razorpay", actorId: owner._id, fetchImpl: impl }), (error: { code?: string }) => error.code === "refund_account_unavailable");
  assert.equal(calls.length, 0);
  assert.equal((await Order.findById(order._id).lean())?.refundHoldTotal, 0);
});

test("only owners refund through Razorpay; managers may record; other stores get nothing", async () => {
  const { id, business } = await setup();
  const { order } = await paidOrder(id);
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const managerHeaders = await createAuthHeadersForUser(String(manager._id), "user", manager.tokenVersion);
  const params = ctx({ id, orderId: String(order._id) });
  assert.equal((await callHandler(refundPOST, req("POST", { method: "razorpay" }, managerHeaders), params)).status, 403);
  assert.equal((await callHandler(refundPOST, req("POST", { method: "manual", amount: 5 }, managerHeaders), params)).status, 200);

  const outsider = await setup();
  assert.equal((await callHandler(refundPOST, req("POST", { method: "manual" }, outsider.headers), params)).status, 403);
  // Their own business id with this order id finds nothing.
  assert.equal((await callHandler(orderGET, req("GET", null, outsider.headers), ctx({ id: outsider.id, orderId: String(order._id) }))).status, 404);
});

// ---- Order management -------------------------------------------------------------------------

test("orders can be searched and filtered, safely and within one business", async () => {
  const { id, headers } = await setup();
  await paidOrder(id, { customerName: "Grace Hopper", customerEmail: "grace@example.test", trackingNumber: "TRK-1" });
  await paidOrder(id, { status: "pending", paymentMethod: "cod", customerName: "Ada Lovelace" });
  const other = await setup();
  await paidOrder(other.id, { customerName: "Grace Other" });
  const list = async (query: string) => {
    const res = await callHandler(ordersGET, req("GET", null, headers, `http://localhost/x?${query}`), ctx({ id }));
    return (await res.json()) as { orders: Array<{ customerName: string; paymentStatus: string }>; hasMore: boolean };
  };
  assert.equal((await list("q=grace")).orders.length, 1);
  assert.equal((await list("q=TRK-1")).orders.length, 1);
  assert.equal((await list("q=.*")).orders.length, 0, "search input is literal");
  assert.equal((await list("payment=cod")).orders[0].customerName, "Ada Lovelace");
  assert.equal((await list("payment=cod")).orders[0].paymentStatus, "cod_due");
  assert.equal((await list("limit=1")).hasMore, true);
  const bad = await callHandler(ordersGET, req("GET", null, headers, "http://localhost/x?payment=nope"), ctx({ id }));
  assert.equal(bad.status, 400);
});

test("order detail shows payment history without secrets, and notes stay private", async () => {
  const { id, headers } = await setup();
  const { order } = await paidOrder(id);
  await recordPaid(id, order._id);
  const params = ctx({ id, orderId: String(order._id) });
  assert.equal((await callHandler(notePUT, req("PUT", { note: "Call first" }, headers), params)).status, 200);
  const res = await callHandler(orderGET, req("GET", null, headers), params);
  const body = await res.json();
  assert.equal(body.order.internalNote, "Call first");
  assert.equal(body.payments.length, 1);
  assert.equal(body.order.testPayment, true);
  const json = JSON.stringify(body);
  for (const secret of ["ownerToken", "orderProofHash", "idempotencyKey", "shortUrl", "keySecret"]) assert.equal(json.includes(secret), false, secret);
});

test("the export is scoped, excludes notes and cannot carry a formula", async () => {
  const { id, headers } = await setup();
  await paidOrder(id, { customerName: "=cmd()", internalNote: "Secret note" });
  const other = await setup();
  await paidOrder(other.id, { customerName: "Other Store Shopper" });
  const res = await callHandler(exportGET, req("GET", null, headers), ctx({ id }));
  const csv = await res.text();
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.equal(csv.includes("\"'=cmd()\""), true);
  assert.equal(csv.includes("Secret note"), false);
  assert.equal(csv.includes("Other Store Shopper"), false);
});

// ---- Products, tax, subscription --------------------------------------------------------------

test("duplicating a product makes a stockless draft within the plan limit", async () => {
  const { id, headers } = await setup();
  const source = await Product.create({ business: id, name: "Shirt", slug: "shirt", price: 20, stock: 9, sku: "S-1", status: "active", ratingAverage: 5, ratingCount: 3, images: [], options: [{ name: "Size", values: ["S", "M"] }], variants: [{ options: [{ name: "Size", value: "S" }], sku: "S-S", stock: 4, price: 25 }, { options: [{ name: "Size", value: "M" }], sku: "S-M", stock: 5, archived: true }] });
  const res = await callHandler(duplicatePOST, req("POST", {}, headers), ctx({ id, productId: String(source._id) }));
  assert.equal(res.status, 201);
  const { product } = await res.json();
  assert.equal(product.status, "draft");
  assert.equal(product.slug, "shirt-copy");
  assert.equal(product.stock, 0);
  assert.equal(product.sku, "");
  assert.equal(product.ratingCount, 0);
  const live = product.variants.filter((v: { archived: boolean }) => !v.archived);
  assert.equal(live.length, 1);
  assert.deepEqual([live[0].price, live[0].stock, live[0].sku], [25, 0, ""]);
  assert.equal((await Product.findById(source._id).lean())?.stock, 9);

  for (let i = 0; i < 3; i += 1) await Product.create({ business: id, name: `P${i}`, slug: `p${i}`, price: 1, status: "draft" });
  assert.equal((await callHandler(duplicatePOST, req("POST", {}, headers), ctx({ id, productId: String(source._id) }))).status, 402);

  const otherStore = await setup();
  assert.equal((await callHandler(duplicatePOST, req("POST", {}, otherStore.headers), ctx({ id: otherStore.id, productId: String(source._id) }))).status, 404);
});

test("an archived product is restored as a draft", async () => {
  const { id, headers } = await setup();
  const product = await Product.create({ business: id, name: "Old", slug: "old", price: 1, status: "archived" });
  const res = await callHandler(productPATCH, req("PATCH", { status: "draft" }, headers), ctx({ id, productId: String(product._id) }));
  assert.equal(res.status, 200);
  assert.equal((await Product.findById(product._id).lean())?.status, "draft");
});

test("archived products are listed separately", async () => {
  const { id, headers } = await setup();
  await Product.create({ business: id, name: "Old", slug: "old", price: 1, status: "archived" });
  await Product.create({ business: id, name: "New", slug: "new", price: 1, status: "active" });
  const names = async (url: string) => ((await (await callHandler(productsGET, req("GET", null, headers, url), ctx({ id }))).json()) as { products: Array<{ name: string }> }).products.map((p) => p.name);
  assert.deepEqual(await names("http://localhost/x"), ["New"]);
  assert.deepEqual(await names("http://localhost/x?status=archived"), ["Old"]);
});

test("tax settings are validated and owner or manager only", async () => {
  const { id, headers, business } = await setup();
  assert.equal((await callHandler(taxPUT, req("PUT", { enabled: true, label: "GST", rate: 18, inclusive: false }, headers), ctx({ id }))).status, 200);
  assert.equal(((await Business.findById(id).lean())?.taxSettings as { rate: number }).rate, 18);
  assert.equal((await callHandler(taxPUT, req("PUT", { enabled: true, rate: 500 }, headers), ctx({ id }))).status, 422);
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  assert.equal((await callHandler(taxPUT, req("PUT", { enabled: false }, staffHeaders), ctx({ id }))).status, 403);
});

test("a paid plan can be cancelled at period end and kept again; a free one cannot", async () => {
  const { id, headers, business } = await setup();
  assert.equal((await callHandler(subscriptionPOST, req("POST", { action: "cancel" }, headers), ctx({ id }))).status, 409, "free plan");
  const paid = await createPlan({ price: 99 });
  await Subscription.updateOne({ business: business._id }, { $set: { plan: paid._id, provider: "manual", currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
  assert.equal((await callHandler(subscriptionPOST, req("POST", { action: "cancel" }, headers), ctx({ id }))).status, 200);
  assert.equal((await Subscription.findOne({ business: business._id }).lean())?.cancelAtPeriodEnd, true);
  assert.equal((await callHandler(subscriptionPOST, req("POST", { action: "resume" }, headers), ctx({ id }))).status, 200);
  assert.equal((await Subscription.findOne({ business: business._id }).lean())?.cancelAtPeriodEnd, false);
});
