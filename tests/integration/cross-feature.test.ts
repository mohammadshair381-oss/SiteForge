import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { freshIp, login, me, registerVerified, sessionCookie, store } from "./helpers/customer-accounts";
import { GET as manageOrdersGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { GET as insightsGET } from "@/app/api/businesses/[id]/insights/route";
import { GET as subscriptionGET } from "@/app/api/businesses/[id]/subscription/route";
import { GET as platformMeGET } from "@/app/api/auth/me/route";
import { POST as payPOST } from "@/app/api/storefront/orders/[orderId]/pay/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { getPlatformOverview } from "@/lib/admin/control-center";
import { getBusinessInsights } from "@/lib/business-insights";
import { parseDateRange } from "@/lib/date-range";
import { cancelOrder, confirmCodPayment, refundOrder, releaseExpiredOrders } from "@/lib/orders/lifecycle";
import { encryptCredential } from "@/lib/payments/credentials-crypto";
import { confirmPaymentLink } from "@/lib/payments/order-payments";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";

/**
 * Cross-feature verification: role separation across admin / business /
 * customer sessions, subscription lapses vs. payments already taken, races
 * between payment confirmation and cancellation/expiry, and consistency of
 * owner insights with the admin overview.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const key of ["CUSTOMER_ACCOUNTS_ENABLED", "ORDER_ONLINE_PAYMENTS_ENABLED", "PAYMENT_CREDENTIALS_KEY"]) delete process.env[key];
  clearRequestCookies();
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});

const realFetch = globalThis.fetch;
/** Fake Razorpay: every Payment Link reads as fully paid for its recorded amount. */
const paidLinks = new Map<string, { amount: number; reference: string }>();
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  process.env.ORDER_ONLINE_PAYMENTS_ENABLED = "true";
  process.env.PAYMENT_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
  paidLinks.clear();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected network request: ${url.origin}`);
    const id = url.pathname.split("/").pop()!;
    const link = paidLinks.get(id);
    if (!link) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({
      id, amount: link.amount, amount_paid: link.amount, currency: "INR", status: "paid", reference_id: link.reference,
      short_url: "https://rzp.io/i/x", payments: [{ payment_id: `pay_${id}`, amount: link.amount, status: "captured" }],
    }), { status: 200 });
  }) as typeof fetch;
  clearRequestCookies();
  await drainAfterResponseTasks();
  await clearAllCollections();
});

async function product(businessId: unknown, stock = 10) {
  return Product.create({ business: businessId, name: "Tea", slug: `tea-${crypto.randomUUID().slice(0, 6)}`, price: 100, currency: "INR", stock, status: "active" });
}

/** A pending order that has reserved `quantity` units (stock already decremented, as checkout does). */
async function reservedOrder(
  businessId: unknown,
  productDoc: { _id: unknown },
  o: { method: "cod" | "online"; quantity?: number; expiresAt?: Date | null },
) {
  const quantity = o.quantity ?? 2;
  await Product.updateOne({ _id: productDoc._id }, { $inc: { stock: -quantity } });
  return Order.create({
    business: businessId, ownerToken: crypto.randomUUID(), customerName: "Shopper", customerEmail: `s${crypto.randomUUID().slice(0, 6)}@example.com`,
    items: [{ product: String(productDoc._id), productName: "Tea", quantity, unitPrice: 100, currency: "INR" }],
    subtotal: 100 * quantity, total: 100 * quantity, currency: "INR", status: "pending", paymentMethod: o.method,
    inventoryState: "reserved", reservationExpiresAt: o.expiresAt === undefined ? new Date(Date.now() + 30 * 60_000) : o.expiresAt,
  });
}

async function connectRazorpay(businessId: unknown) {
  await BusinessPaymentAccount.create({
    business: businessId, provider: "razorpay", mode: "test", status: "active", keyId: "rzp_test_crossfeat1",
    keySecretEnc: encryptCredential("key_secret"), webhookSecretEnc: encryptCredential("webhook_secret"), connectedAt: new Date(),
  });
}

async function paidLinkFor(businessId: unknown, order: { _id: unknown; total: number }) {
  const linkId = `plink_${crypto.randomBytes(6).toString("hex")}`;
  await OrderPayment.create({
    business: businessId, order: order._id, provider: "razorpay", mode: "test", providerLinkId: linkId,
    shortUrl: "https://rzp.io/i/x", amountMinor: order.total * 100, currency: "INR",
  });
  paidLinks.set(linkId, { amount: order.total * 100, reference: String(order._id) });
  return linkId;
}

// ---------------------------------------------------------------------------
// Role separation
// ---------------------------------------------------------------------------

test("super admins are not business members: business order, insights and billing data are refused", async () => {
  const shop = await store();
  const admin = await createUser({ platformRole: "super_admin" });
  const headers = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  const id = String(shop.business._id);
  for (const [handler, path] of [
    [manageOrdersGET, "manage/orders"],
    [insightsGET, "insights"],
    [subscriptionGET, "subscription"],
  ] as const) {
    const res = (await callHandler(handler as never, new Request(`http://localhost/api/businesses/${id}/${path}`, { headers: { ...headers } }), { params: Promise.resolve({ id }) } as never)) as Response;
    assert.equal(res.status, 403, path);
  }
});

test("platform and customer sessions never stand in for each other", async () => {
  const shop = await store();
  await registerVerified(shop.host, "ada@example.com");
  const customerCookie = sessionCookie(await login(shop.host, "ada@example.com"));
  // A customer session on a platform route: not authenticated.
  const platform = (await callHandler(platformMeGET as never, new Request("http://localhost/api/auth/me", { headers: { cookie: customerCookie } }))) as Response;
  assert.equal(platform.status, 401);
  // A platform owner session on the storefront: not a customer.
  const ownerHeaders = await createAuthHeadersForUser(String(shop.owner._id), "user", shop.owner.tokenVersion);
  assert.equal(await me(shop.host, ownerHeaders.cookie), null);
});

// ---------------------------------------------------------------------------
// Subscription lapse vs. payments already taken
// ---------------------------------------------------------------------------

test("a lapsed subscription stops new payments but a payment already captured is still recorded", async () => {
  const shop = await store();
  await connectRazorpay(shop.business._id);
  const tea = await product(shop.business._id);
  const order = await reservedOrder(shop.business._id, tea, { method: "online" });
  const linkId = await paidLinkFor(shop.business._id, order);

  await Subscription.updateMany({ business: shop.business._id }, { $set: { status: "past_due" } });
  // Starting a payment needs the commerce gate (published + entitled): refused.
  const pay = (await callHandler(payPOST, new Request(`http://${shop.host}/api/storefront/orders/${order._id}/pay`, {
    method: "POST", headers: { host: shop.host, "content-type": "application/json", "x-forwarded-for": freshIp(), "x-order-proof": "x" }, body: "{}",
  }), { params: Promise.resolve({ orderId: String(order._id) }) })) as Response;
  assert.equal(pay.status, 404);

  // Money Razorpay already captured is applied, not lost.
  assert.equal((await confirmPaymentLink({ businessId: String(shop.business._id), linkId })).outcome, "applied");
  assert.equal((await Order.findById(order._id).lean())?.status, "paid");
});

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

test("COD 'mark paid' racing a customer cancellation: exactly one wins and stock stays consistent", async () => {
  const shop = await store();
  const tea = await product(shop.business._id, 20);
  for (let round = 0; round < 5; round++) {
    const order = await reservedOrder(shop.business._id, tea, { method: "cod", expiresAt: null });
    const before = (await Product.findById(tea._id).lean())!.stock;
    const [paid, cancelled] = await Promise.all([
      confirmCodPayment({ orderId: String(order._id), businessId: String(shop.business._id) }),
      cancelOrder({ orderId: String(order._id), businessId: String(shop.business._id), reason: "customer" }),
    ]);
    assert.equal(Number(paid.applied) + Number(cancelled.applied), 1, `round ${round}: exactly one transition`);
    const after = await Order.findById(order._id).lean();
    const stock = (await Product.findById(tea._id).lean())!.stock;
    if (paid.applied) {
      assert.deepEqual([after?.status, after?.inventoryState, stock], ["paid", "consumed", before]);
    } else {
      assert.deepEqual([after?.status, after?.inventoryState, stock], ["cancelled", "released", before + 2]);
    }
  }
});

test("a Razorpay-confirmed payment racing the expiry sweep never yields a paid order with released stock", async () => {
  const shop = await store();
  await connectRazorpay(shop.business._id);
  const tea = await product(shop.business._id, 50);
  const businessId = String(shop.business._id);
  const outcomes = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const expiresAt = new Date(Date.now() + 60_000);
    const order = await reservedOrder(shop.business._id, tea, { method: "online", expiresAt });
    const linkId = await paidLinkFor(shop.business._id, order);
    const before = (await Product.findById(tea._id).lean())!.stock;
    const [confirmed] = await Promise.all([
      confirmPaymentLink({ businessId, linkId, now: new Date(expiresAt.getTime() - 1000) }),
      releaseExpiredOrders({ businessId, now: new Date(expiresAt.getTime() + 1000) }),
    ]);
    outcomes.add(confirmed.outcome);
    const after = await Order.findById(order._id).lean();
    const payment = await OrderPayment.findOne({ providerLinkId: linkId }).lean();
    const stock = (await Product.findById(tea._id).lean())!.stock;
    assert.equal(payment?.status, "paid", "the captured payment is always recorded");
    if (after?.status === "paid") {
      assert.equal(after.inventoryState, "consumed");
      assert.equal(stock, before, "stock not restored for a paid order");
      assert.equal(payment?.orderOutcome, "applied");
    } else {
      assert.equal(after?.status, "cancelled");
      assert.equal(stock, before + 2, "stock restored exactly once");
      assert.equal(payment?.orderOutcome, "needs_review", "the owner is told to refund");
    }
  }
  assert.ok([...outcomes].every((o) => o === "applied" || o === "needs_review"), JSON.stringify([...outcomes]));
});

// ---------------------------------------------------------------------------
// Financial consistency
// ---------------------------------------------------------------------------

test("insights follow real order transitions and agree with the admin overview", async () => {
  const a = await store();
  const b = await store();
  const teaA = await product(a.business._id);
  const teaB = await product(b.business._id);
  const range = parseDateRange();

  const paidA = await reservedOrder(a.business._id, teaA, { method: "cod", expiresAt: null, quantity: 3 });
  const refundedA = await reservedOrder(a.business._id, teaA, { method: "cod", expiresAt: null, quantity: 1 });
  const cancelledA = await reservedOrder(a.business._id, teaA, { method: "cod", expiresAt: null, quantity: 1 });
  const paidB = await reservedOrder(b.business._id, teaB, { method: "cod", expiresAt: null, quantity: 2 });
  const ids = (o: { _id: unknown }, business: { _id: unknown }) => ({ orderId: String(o._id), businessId: String(business._id) });
  assert.ok((await confirmCodPayment(ids(paidA, a.business))).applied);
  assert.ok((await confirmCodPayment(ids(refundedA, a.business))).applied);
  assert.ok((await refundOrder(ids(refundedA, a.business))).applied);
  assert.ok((await cancelOrder({ ...ids(cancelledA, a.business), reason: "customer" })).applied);
  assert.ok((await confirmCodPayment(ids(paidB, b.business))).applied);

  const insightsA = await getBusinessInsights(String(a.business._id), range);
  const insightsB = await getBusinessInsights(String(b.business._id), range);
  assert.deepEqual(insightsA.sales.map((s) => [s.currency, s.amount, s.orders, s.cod]), [["INR", 300, 1, 300]]);
  assert.deepEqual(insightsA.refunds, [{ currency: "INR", amount: 100, orders: 1 }]);
  assert.deepEqual(insightsA.orders.byStatus, { pending: 0, paid: 1, cancelled: 1, refunded: 1 });
  assert.equal(insightsA.topProducts[0]?.units, 3, "only the paid order counts towards best sellers");

  // The admin overview's COD figure counts paid AND refunded orders by payment date
  // (money that was collected); owner sales exclude refunds and list them separately.
  const overview = await getPlatformOverview(range);
  const adminCod = overview.inRange.payments.codOrders.find((m) => m.currency === "INR");
  const ownerCollected = [insightsA, insightsB].reduce(
    (n, i) => n + (i.sales.find((s) => s.currency === "INR")?.cod ?? 0) + (i.refunds.find((r) => r.currency === "INR")?.amount ?? 0),
    0,
  );
  assert.equal(adminCod?.amount, ownerCollected);
  assert.equal(adminCod?.amount, 600);
});
