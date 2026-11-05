import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import crypto from "node:crypto";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as couponsRoute from "@/app/api/businesses/[id]/coupons/route";
import * as couponRoute from "@/app/api/businesses/[id]/coupons/[couponId]/route";
import * as shippingRoute from "@/app/api/businesses/[id]/shipping/route";
import * as quoteRoute from "@/app/api/businesses/[id]/cart/quote/route";
import * as ordersRoute from "@/app/api/businesses/[id]/orders/route";
import * as fulfillmentRoute from "@/app/api/businesses/[id]/manage/orders/[orderId]/fulfillment/route";
import { cancelOrder } from "@/lib/orders/lifecycle";
import { Business } from "@/models/Business";
import { Cart } from "@/models/Cart";
import { Coupon } from "@/models/Coupon";
import { CouponRedemption } from "@/models/CouponRedemption";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Coupons (server-side validation, usage limits under concurrency, release on
 * cancellation), shipping charges and addresses, and order fulfilment.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };

async function api(handler: unknown, method: string, url: string, params: Record<string, string>, actor: Actor | null, body?: unknown) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost", ...auth },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function store() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  await Business.updateOne({ _id: business._id }, { $set: { currency: "USD" } });
  const product = await Product.create({ business: business._id, name: "Tea", slug: "tea", price: 20, currency: "USD", stock: 100, status: "active" });
  return { owner, business, id: String(business._id), host: `${business.subdomain}.localhost:3000`, product };
}

async function cartWith(businessId: string, productId: unknown, quantity: number) {
  const token = crypto.randomUUID();
  await Cart.create({ business: businessId, ownerToken: token, items: [{ product: String(productId), quantity, priceSnapshot: 20, currency: "USD" }] });
  return token;
}

async function checkout(host: string, token: string, extra: Record<string, unknown> = {}, email = "ada@example.com") {
  const res = await ordersRoute.POST(
    new Request("http://localhost/api/businesses/x/orders", {
      method: "POST",
      headers: { "content-type": "application/json", host, cookie: `cart-token=${token}`, "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify({ customerName: "Ada", customerEmail: email, idempotencyKey: crypto.randomUUID(), ...extra }),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const ADDRESS = { name: "Ada L", line1: "1 Analytical St", city: "London", postalCode: "N1 1AA", country: "UK" };

test("coupon management: owner/manager only, unique codes, validation", async () => {
  const { owner, id, business } = await store();
  const other = await store();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const create = (actor: Actor, body: unknown, bizId = id) => api(couponsRoute.POST, "POST", `/api/businesses/${bizId}/coupons`, { id: bizId }, actor, body);

  assert.equal((await create(staff, { code: "SAVE10", type: "percent", value: 10 })).status, 403);
  assert.equal((await create(other.owner, { code: "SAVE10", type: "percent", value: 10 })).status, 403);
  assert.equal((await create(owner, { code: "SAVE10", type: "percent", value: 150 })).status, 422);
  assert.equal((await create(owner, { code: "no spaces", type: "percent", value: 10 })).status, 422);
  const ok = await create(owner, { code: "save10", type: "percent", value: 10, description: "Ten off" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.coupon.code, "SAVE10");
  assert.equal(ok.body.coupon.currency, "USD");
  assert.equal((await create(owner, { code: "SAVE10", type: "fixed", value: 5 })).body.code, "coupon_code_taken");
  // Same code in another business is fine (scoped per business).
  assert.equal((await create(other.owner, { code: "SAVE10", type: "fixed", value: 5 }, other.id)).status, 201);
  // Editing never touches usedCount; another business cannot edit it.
  await Coupon.updateOne({ _id: ok.body.coupon.id }, { $set: { usedCount: 3 } });
  const edited = await api(couponRoute.PUT, "PUT", `/api/businesses/${id}/coupons/${ok.body.coupon.id}`, { id, couponId: ok.body.coupon.id }, owner, { code: "SAVE10", type: "percent", value: 15, usedCount: 0 });
  assert.equal(edited.body.coupon.value, 15);
  assert.equal(edited.body.coupon.usedCount, 3);
  assert.equal((await api(couponRoute.PUT, "PUT", `/api/businesses/${other.id}/coupons/${ok.body.coupon.id}`, { id: other.id, couponId: ok.body.coupon.id }, other.owner, { code: "X12", type: "percent", value: 1 })).status, 404);
});

test("checkout applies a coupon and shipping on the server; totals are exact", async () => {
  const { owner, id, host, product } = await store();
  await api(couponsRoute.POST, "POST", `/api/businesses/${id}/coupons`, { id }, owner, { code: "TEN", type: "percent", value: 10, minSubtotal: 30 });
  await api(shippingRoute.PUT, "PUT", `/api/businesses/${id}/shipping`, { id }, owner, { enabled: true, flatRate: 4.99, freeOver: 50, requireAddress: true, deliveryInfo: "3-5 days" });

  // Address required once the store ships.
  assert.equal((await checkout(host, await cartWith(id, product._id, 2))).body.code, "invalid_shipping_address");

  // 2 x 20 = 40, 10% off = 36, below the free threshold: +4.99 shipping.
  const a = await checkout(host, await cartWith(id, product._id, 2), { couponCode: "ten", shippingAddress: ADDRESS });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.subtotal, a.body.discountTotal, a.body.shippingTotal, a.body.total], [40, 4, 4.99, 40.99]);
  const order = await Order.findById(a.body.orderId).lean();
  assert.equal(order!.discount!.code, "TEN");
  assert.equal(order!.shippingAddress!.city, "London");
  assert.equal(await CouponRedemption.countDocuments({ order: order!._id, status: "active" }), 1);
  assert.equal((await Coupon.findOne({ business: id }).lean())!.usedCount, 1);

  // 3 x 20 = 60 -> 54 after the coupon, at/above 50: free shipping.
  const b = await checkout(host, await cartWith(id, product._id, 3), { couponCode: "TEN", shippingAddress: ADDRESS }, "bob@example.com");
  assert.deepEqual([b.body.subtotal, b.body.discountTotal, b.body.shippingTotal, b.body.total], [60, 6, 0, 54]);

  // Below the minimum: refused, nothing reserved.
  const before = (await Product.findById(product._id).lean())!.stock;
  const c = await checkout(host, await cartWith(id, product._id, 1), { couponCode: "TEN", shippingAddress: ADDRESS });
  assert.equal(c.body.code, "coupon_min_subtotal");
  assert.equal((await Product.findById(product._id).lean())!.stock, before);
});

test("expired, future, inactive, unknown and other-currency codes are refused without side effects", async () => {
  const { id, host, product, business } = await store();
  const now = Date.now();
  await Coupon.create([
    { business: business._id, code: "OLD", type: "fixed", value: 5, currency: "USD", expiresAt: new Date(now - 1000) },
    { business: business._id, code: "SOON", type: "fixed", value: 5, currency: "USD", startsAt: new Date(now + 86_400_000) },
    { business: business._id, code: "OFF", type: "fixed", value: 5, currency: "USD", active: false },
    { business: business._id, code: "EUROS", type: "fixed", value: 5, currency: "EUR" },
  ]);
  for (const [code, expected] of [["OLD", "coupon_expired"], ["SOON", "coupon_not_started"], ["OFF", "coupon_invalid"], ["NOPE", "coupon_invalid"], ["EUROS", "coupon_currency"], ["<x>", "coupon_invalid"]]) {
    const res = await checkout(host, await cartWith(id, product._id, 1), { couponCode: code });
    assert.equal(res.body.code, expected, code);
  }
  assert.equal(await Order.countDocuments({ business: id }), 0);
  assert.equal((await Product.findById(product._id).lean())!.stock, 100);
});

test("a one-use coupon is used exactly once under concurrent checkouts", async () => {
  const { id, host, product, business } = await store();
  await Coupon.create({ business: business._id, code: "ONCE", type: "fixed", value: 5, currency: "USD", usageLimit: 1 });
  const tokens = await Promise.all(Array.from({ length: 5 }, () => cartWith(id, product._id, 1)));
  const results = await Promise.all(tokens.map((t, i) => checkout(host, t, { couponCode: "ONCE" }, `p${i}@example.com`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "coupon_usage_limit"));
  assert.equal((await Coupon.findOne({ code: "ONCE" }).lean())!.usedCount, 1);
  assert.equal(await CouponRedemption.countDocuments({ business: id }), 1);
  assert.equal((await Product.findById(product._id).lean())!.stock, 99, "refused checkouts reserve nothing");
});

test("per-customer limits hold under concurrency; cancellation gives the use back exactly once", async () => {
  const { id, host, product, business } = await store();
  await Coupon.create({ business: business._id, code: "WELCOME", type: "percent", value: 20, currency: "USD", perCustomerLimit: 1 });
  const tokens = await Promise.all(Array.from({ length: 4 }, () => cartWith(id, product._id, 1)));
  const results = await Promise.all(tokens.map((t) => checkout(host, t, { couponCode: "WELCOME" }, "same@example.com")));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "coupon_customer_limit"));
  // Another shopper may still use it.
  const other = await checkout(host, await cartWith(id, product._id, 1), { couponCode: "WELCOME" }, "OTHER@example.com");
  assert.equal(other.status, 200);
  assert.equal((await Coupon.findOne({ code: "WELCOME" }).lean())!.usedCount, 2);

  const won = results.find((r) => r.status === 200)!;
  assert.equal((await cancelOrder({ orderId: won.body.orderId, businessId: id, reason: "customer" })).applied, true);
  assert.equal((await cancelOrder({ orderId: won.body.orderId, businessId: id, reason: "customer" })).applied, false);
  assert.equal((await Coupon.findOne({ code: "WELCOME" }).lean())!.usedCount, 1);
  assert.equal(await CouponRedemption.countDocuments({ order: won.body.orderId, status: "released" }), 1);
  // The same shopper can use it again now.
  assert.equal((await checkout(host, await cartWith(id, product._id, 1), { couponCode: "WELCOME" }, "same@example.com")).status, 200);
});

test("the cart quote previews totals and coupon errors without consuming a use", async () => {
  const { owner, id, host, product, business } = await store();
  await Coupon.create({ business: business._id, code: "FIVE", type: "fixed", value: 5, currency: "USD", usageLimit: 1 });
  await api(shippingRoute.PUT, "PUT", `/api/businesses/${id}/shipping`, { id }, owner, { enabled: true, flatRate: 3, freeOver: null });
  const token = await cartWith(id, product._id, 2);
  const quote = async (couponCode: string) => {
    const res = await quoteRoute.POST(new Request("http://localhost/api/businesses/x/cart/quote", {
      method: "POST",
      headers: { "content-type": "application/json", host, cookie: `cart-token=${token}`, "x-forwarded-for": "203.0.113.50" },
      body: JSON.stringify({ couponCode }),
    }));
    return (await res.json()) as Record<string, any>;
  };
  const good = await quote("five");
  assert.deepEqual([good.subtotal, good.discountTotal, good.shippingTotal, good.total, good.coupon?.code], [40, 5, 3, 38, "FIVE"]);
  assert.equal(good.shipping.requireAddress, true);
  const bad = await quote("NOPE1");
  assert.equal(bad.couponError.code, "coupon_invalid");
  assert.equal(bad.total, 43);
  assert.equal((await Coupon.findOne({ code: "FIVE" }).lean())!.usedCount, 0, "a preview never uses the coupon");
});

test("fulfilment: forward only, paid or COD orders, https tracking; shoppers cannot cancel shipped orders", async () => {
  const { owner, id, host, product, business } = await store();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const placed = await checkout(host, await cartWith(id, product._id, 1));
  const orderId = placed.body.orderId as string;
  const fulfil = (actor: Actor, body: unknown) => api(fulfillmentRoute.POST, "POST", `/api/businesses/${id}/manage/orders/${orderId}/fulfillment`, { id, orderId }, actor, body);

  assert.equal((await fulfil(owner, { status: "shipped" })).body.code, "not_fulfillable", "an unpaid online/unknown order cannot ship");
  await Order.updateOne({ _id: orderId }, { $set: { paymentMethod: "cod" } });
  assert.equal((await fulfil(staff, { status: "processing" })).status, 403);
  assert.equal((await fulfil(owner, { status: "shipped", trackingUrl: "http://track.example/1" })).status, 422);
  const shipped = await fulfil(owner, { status: "shipped", trackingCarrier: "Royal Mail", trackingNumber: "RM123", trackingUrl: "https://track.example/RM123" });
  assert.equal(shipped.status, 200, JSON.stringify(shipped.body));
  assert.equal(shipped.body.order.fulfillmentStatus, "shipped");
  assert.ok(shipped.body.order.shippedAt);
  assert.equal((await fulfil(owner, { status: "processing" })).body.code, "fulfillment_backwards");

  // The shopper can no longer cancel; the business still can (refused delivery).
  assert.equal((await cancelOrder({ orderId, businessId: id, reason: "customer" })).applied, false);
  assert.equal((await Order.findById(orderId).lean())!.status, "pending");
  assert.equal((await cancelOrder({ orderId, businessId: id, reason: "admin" })).applied, true);
  assert.equal((await fulfil(owner, { status: "delivered" })).body.code, "not_fulfillable");
});
