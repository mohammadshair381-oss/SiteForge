import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { createMembership } from "./helpers/tenant";
import {
  call,
  freshIp,
  login,
  registerVerified,
  sessionCookie,
  setCookies,
  store,
} from "./helpers/customer-accounts";
import { POST as cartPOST } from "@/app/api/businesses/[id]/cart/route";
import { POST as orderPOST } from "@/app/api/businesses/[id]/orders/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { GET as manageListGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { PATCH as manageOrderPATCH } from "@/app/api/businesses/[id]/manage/orders/[orderId]/route";
import { POST as logoutPOST } from "@/app/api/storefront/account/logout/route";
import { GET as customerOrdersGET } from "@/app/api/storefront/account/orders/route";
import { POST as customerCancelPOST } from "@/app/api/storefront/account/orders/[orderId]/cancel/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { MAX_OPEN_COD_ORDERS_PER_CUSTOMER, releaseExpiredOrders } from "@/lib/orders/lifecycle";
import { clearEmailOutbox } from "@/lib/email";
import { Business } from "@/models/Business";
import { Customer } from "@/models/Customer";
import { InventoryMovement } from "@/models/InventoryMovement";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Phase 4B: customer-aware checkout, customer-order association and cash on
 * delivery (COD). Route handlers run against the in-memory replica set.
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
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  clearRequestCookies();
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  clearRequestCookies();
  await drainAfterResponseTasks();
  clearEmailOutbox();
  await clearAllCollections();
});

const EMAIL = "ada@example.com";

async function product(businessId: unknown, stock = 5) {
  return Product.create({
    business: businessId,
    name: "Mug",
    slug: `mug-${crypto.randomUUID().slice(0, 8)}`,
    price: 10,
    currency: "USD",
    stock,
    status: "active",
  });
}

/** A fresh guest cart with one unit of the product; returns the `cart-token=` pair. */
async function cart(host: string, productId: unknown): Promise<string> {
  const response = await call(cartPOST, host, { productId: String(productId), quantity: 1 }, { ip: freshIp() });
  assert.equal(response.status, 200, await response.clone().text());
  const raw = setCookies(response).find((c) => c.startsWith("cart-token="));
  assert.ok(raw, "cart cookie");
  return raw.split(";")[0];
}

function checkout(
  host: string,
  cookie: string,
  body: Record<string, unknown> = {},
  options: { origin?: string; contentType?: string; raw?: string } = {},
) {
  const payload = options.raw ?? { customerName: "Ada Shopper", customerEmail: "typed@example.com", ...body };
  return call(orderPOST, host, payload, { ip: freshIp(), cookie, origin: options.origin, contentType: options.contentType });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function stockOf(id: unknown) {
  return (await Product.findById(id).lean())?.stock;
}

async function signedInStore(options: { cod?: boolean } = {}) {
  const shop = await store();
  if (options.cod) await Business.updateOne({ _id: shop.business._id }, { $set: { codEnabled: true } });
  await registerVerified(shop.host, EMAIL);
  const session = sessionCookie(await login(shop.host, EMAIL));
  const item = await product(shop.business._id);
  return { ...shop, session, item };
}

async function patchBusiness(businessId: unknown, userId: unknown, tokenVersion: number, body: unknown) {
  const id = String(businessId);
  const headers = await createAuthHeadersForUser(String(userId), "user", tokenVersion);
  const res = (await callHandler(
    businessPATCH,
    new Request(`http://localhost/api/businesses/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: await json(res) };
}

async function manage(businessId: unknown, owner: { _id: unknown; tokenVersion: number }, orderId: string, action: string) {
  const id = String(businessId);
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const res = (await callHandler(
    manageOrderPATCH,
    new Request(`http://localhost/api/businesses/${id}/manage/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id, orderId }) },
  )) as Response;
  return { status: res.status, body: await json(res) };
}

// ---------------------------------------------------------------------------
// Schema defaults and the owner-only COD setting
// ---------------------------------------------------------------------------

test("COD is off by default, including for stores saved before the setting existed", async () => {
  const shop = await store();
  assert.equal((await Business.findById(shop.business._id))?.codEnabled, false);
  await Business.collection.updateOne({ _id: shop.business._id }, { $unset: { codEnabled: "" } });
  assert.equal((await Business.findById(shop.business._id))?.codEnabled, false, "legacy document reads as off");
  const item = await product(shop.business._id);
  const res = await checkout(shop.host, await cart(shop.host, item._id), { paymentMethod: "cod" });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, "cod_unavailable");
});

test("only the owner can change COD; managers keep their other settings rights; other stores are refused", async () => {
  const shop = await store();
  const manager = await createUser({ email: "mgr@example.com" });
  await createMembership(shop.business._id, manager._id, "manager");
  const staff = await createUser({ email: "staff@example.com" });
  await createMembership(shop.business._id, staff._id, "staff");
  const other = await store();

  assert.equal((await patchBusiness(shop.business._id, shop.owner._id, shop.owner.tokenVersion, { codEnabled: true })).status, 200);
  assert.equal((await Business.findById(shop.business._id))?.codEnabled, true);

  const byManager = await patchBusiness(shop.business._id, manager._id, manager.tokenVersion, { codEnabled: false });
  assert.equal(byManager.status, 403);
  assert.equal(byManager.body.code, "forbidden");
  assert.equal((await patchBusiness(shop.business._id, staff._id, staff.tokenVersion, { codEnabled: false })).status, 403);
  assert.equal((await patchBusiness(shop.business._id, other.owner._id, other.owner.tokenVersion, { codEnabled: false })).status, 403);
  assert.equal((await Business.findById(shop.business._id))?.codEnabled, true, "unchanged by refused requests");

  assert.equal((await patchBusiness(shop.business._id, manager._id, manager.tokenVersion, { description: "New text" })).status, 200);
  const invalid = await patchBusiness(shop.business._id, shop.owner._id, shop.owner.tokenVersion, { codEnabled: "yes" });
  assert.equal(invalid.status, 422);
  assert.equal((await patchBusiness(shop.business._id, shop.owner._id, shop.owner.tokenVersion, { codEnabled: false })).status, 200);
  assert.equal((await Business.findById(shop.business._id))?.codEnabled, false);
});

// ---------------------------------------------------------------------------
// Guest checkout is unchanged
// ---------------------------------------------------------------------------

test("guest checkout with customer accounts disabled is unchanged, even with a stale session cookie", async () => {
  const { host, business, session, item } = await signedInStore({ cod: true });
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  const res = await checkout(host, `${await cart(host, item._id)}; ${session}`);
  assert.equal(res.status, 200);
  const order = await Order.findById((await json(res)).orderId).lean();
  assert.equal(order?.customer, undefined, "no association while accounts are off");
  assert.equal(order?.paymentMethod, undefined, "guest orders keep no payment method");
  assert.equal(order?.customerEmail, "typed@example.com");
  assert.ok(order?.reservationExpiresAt instanceof Date, "guest reservations still expire");
  assert.equal(String(order?.business), String(business._id));
  // Form posts still work for guests.
  const form = await checkout(host, await cart(host, item._id), {}, {
    raw: "customerName=Ada&customerEmail=form%40example.com",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 200);
});

test("guest checkout with customer accounts enabled (and COD enabled but unused) is unchanged", async () => {
  const shop = await store();
  await Business.updateOne({ _id: shop.business._id }, { $set: { codEnabled: true } });
  const item = await product(shop.business._id);
  const res = await checkout(shop.host, await cart(shop.host, item._id));
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.paymentMethod, undefined);
  assert.ok(body.orderProof, "guest order proof still returned");
  assert.ok(setCookies(res).some((c) => c.startsWith("order-access=")), "order-access cookie still set");
  const order = await Order.findById(body.orderId).lean();
  assert.equal(order?.customer, undefined);
  assert.equal(order?.paymentMethod, undefined);
  assert.equal(await stockOf(item._id), 4);
  const form = await checkout(shop.host, await cart(shop.host, item._id), {}, {
    raw: "customerName=Ada&customerEmail=form%40example.com",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 200, "guest form posts are not affected");
});

// ---------------------------------------------------------------------------
// Signed-in customers
// ---------------------------------------------------------------------------

test("a signed-in verified customer's order is tied to the account (non-COD)", async () => {
  const { host, session, item } = await signedInStore();
  const res = await checkout(host, `${await cart(host, item._id)}; ${session}`);
  assert.equal(res.status, 200);
  const order = await Order.findById((await json(res)).orderId).lean();
  const account = await Customer.findOne({ email: EMAIL }).lean();
  assert.equal(String(order?.customer), String(account?._id));
  assert.equal(order?.customerEmail, EMAIL, "the account email is authoritative");
  assert.equal(order?.paymentMethod, undefined, "no payment method unless COD was chosen");
});

test("customer-aware checkout requires a same-origin JSON request", async () => {
  const { host, origin, session, item } = await signedInStore({ cod: true });
  const foreign = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" }, { origin: "http://evil.localhost:3000" });
  assert.equal(foreign.status, 403);
  assert.equal((await json(foreign)).code, "csrf_failed");
  const foreignPlain = await checkout(host, `${await cart(host, item._id)}; ${session}`, {}, { origin: "http://evil.localhost:3000" });
  assert.equal(foreignPlain.status, 403, "a session cookie alone also requires same origin");
  const form = await checkout(host, `${await cart(host, item._id)}; ${session}`, {}, {
    raw: "customerName=Ada&customerEmail=a%40example.com&paymentMethod=cod",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(form.status, 415);
  assert.equal(await Order.countDocuments(), 0, "no order from refused requests");
  assert.equal(await stockOf(item._id), 5);
  const same = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" }, { origin });
  assert.equal(same.status, 200);
});

test("COD: an eligible customer gets a server-assigned, non-expiring COD order on both creation paths", async () => {
  const { host, business, owner, session, item } = await signedInStore({ cod: true });
  const keyed = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod", idempotencyKey: crypto.randomUUID() });
  const keyless = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  for (const res of [keyed, keyless]) {
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.paymentMethod, "cod");
    const order = await Order.findById(body.orderId).lean();
    assert.equal(order?.paymentMethod, "cod");
    assert.ok(order?.customer, "tied to the account");
    assert.equal(order?.reservationExpiresAt, null, "COD reservations do not expire automatically");
    assert.equal(order?.inventoryState, "reserved");
  }
  assert.equal(await stockOf(item._id), 3);

  // The expiry sweep never cancels COD orders.
  const sweep = await releaseExpiredOrders({ businessId: String(business._id), now: new Date(Date.now() + 365 * 86400_000) });
  assert.equal(sweep.released, 0);
  const keyedId = String((await Order.findOne({ idempotencyKey: { $type: "string" } }).lean())?._id);
  assert.equal((await Order.findById(keyedId).lean())?.status, "pending");

  // Owner confirms payment once; stock is consumed, not restored.
  const paid = await manage(business._id, owner, keyedId, "mark_paid");
  assert.equal(paid.status, 200);
  assert.equal((await Order.findById(keyedId).lean())?.inventoryState, "consumed");
  assert.equal((await manage(business._id, owner, keyedId, "mark_paid")).status, 409);
  assert.equal((await manage(business._id, owner, keyedId, "cancel")).status, 409, "a paid order cannot be cancelled");
  assert.equal(await stockOf(item._id), 3);

  // The other COD order is cancelled: stock restored exactly once, then it cannot be paid.
  const keylessId = String((await Order.findOne({ _id: { $ne: keyedId } }).lean())?._id);
  assert.equal((await manage(business._id, owner, keylessId, "cancel")).status, 200);
  assert.equal(await stockOf(item._id), 4);
  assert.equal((await manage(business._id, owner, keylessId, "cancel")).status, 409);
  assert.equal(await stockOf(item._id), 4, "no double restock");
  assert.equal((await manage(business._id, owner, keylessId, "mark_paid")).status, 409);
});

test("COD is refused without an eligible customer, and nothing is written", async () => {
  const { host, business, session, item } = await signedInStore({ cod: true });
  const signedOut = await checkout(host, await cart(host, item._id), { paymentMethod: "cod" });
  assert.equal(signedOut.status, 401);
  assert.equal((await json(signedOut)).code, "customer_sign_in_required");

  const other = await store();
  await Business.updateOne({ _id: other.business._id }, { $set: { codEnabled: true } });
  const otherItem = await product(other.business._id);
  const foreignSession = await checkout(other.host, `${await cart(other.host, otherItem._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(foreignSession.status, 401, "a session of another store is not accepted");

  await Customer.updateOne({ email: EMAIL }, { $set: { emailVerifiedAt: null } });
  const unverified = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(unverified.status, 403);
  assert.equal((await json(unverified)).code, "customer_email_unverified");

  await Customer.updateOne({ email: EMAIL }, { $set: { emailVerifiedAt: new Date(), active: false } });
  const inactive = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(inactive.status, 401);

  await Customer.updateOne({ email: EMAIL }, { $set: { active: true } });
  await call(logoutPOST, host, {}, { ip: freshIp(), cookie: session });
  const revoked = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(revoked.status, 401, "a revoked session (old token version) is refused");

  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  const flagOff = await checkout(host, await cart(host, item._id), { paymentMethod: "cod" });
  assert.equal(flagOff.status, 403);
  assert.equal((await json(flagOff)).code, "cod_unavailable");

  assert.equal(await Order.countDocuments({ business: business._id }), 0);
  assert.equal(await stockOf(item._id), 5);
});

test("non-COD checkout ignores ineligible sessions and stays a guest order", async () => {
  const { host, session, item } = await signedInStore();
  const other = await store();
  const otherItem = await product(other.business._id);
  const foreign = await checkout(other.host, `${await cart(other.host, otherItem._id)}; ${session}`);
  assert.equal(foreign.status, 200);
  assert.equal((await Order.findById((await json(foreign)).orderId).lean())?.customer, undefined, "another store's session is not used");

  await Customer.updateOne({ email: EMAIL }, { $set: { active: false } });
  const inactive = await checkout(host, `${await cart(host, item._id)}; ${session}`);
  assert.equal(inactive.status, 200);
  assert.equal((await Order.findById((await json(inactive)).orderId).lean())?.customer, undefined);

  const garbage = await checkout(host, `${await cart(host, item._id)}; sf_customer=not-a-token`);
  assert.equal(garbage.status, 200);
  assert.equal((await Order.findById((await json(garbage)).orderId).lean())?.customer, undefined);
});

test("unsupported payment methods are rejected before any write", async () => {
  const { host, session, item } = await signedInStore({ cod: true });
  for (const paymentMethod of ["card", "COD", "Online", 1, true, { method: "cod" }]) {
    const res = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod });
    assert.equal(res.status, 400, JSON.stringify(paymentMethod));
    assert.equal((await json(res)).code, "invalid_payment_method");
  }
  // "online" is a known method, but online payments are off by default
  // (ORDER_ONLINE_PAYMENTS_ENABLED unset), so it is refused before any write.
  const online = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "online" });
  assert.equal(online.status, 403);
  assert.equal((await json(online)).code, "online_payment_unavailable");
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await stockOf(item._id), 5);
});

test("an idempotent retry never duplicates the order or changes its payment method or customer", async () => {
  const { host, session, item } = await signedInStore({ cod: true });
  const key = crypto.randomUUID();
  const cookie = `${await cart(host, item._id)}; ${session}`;
  const first = await checkout(host, cookie, { paymentMethod: "cod", idempotencyKey: key });
  assert.equal(first.status, 200);
  const firstBody = await json(first);
  const proof = String(firstBody.orderProof);

  // Same key, now without COD and without the session: the original order comes back unchanged.
  const retry = await call(orderPOST, host, { customerName: "Someone Else", customerEmail: "else@example.com", idempotencyKey: key, orderProof: proof }, { ip: freshIp() });
  assert.equal(retry.status, 200);
  const retryBody = await json(retry);
  assert.equal(String(retryBody.orderId), String(firstBody.orderId));
  assert.equal(retryBody.paymentMethod, "cod");
  assert.equal(await Order.countDocuments(), 1);
  const order = await Order.findById(firstBody.orderId).lean();
  assert.equal(order?.paymentMethod, "cod");
  assert.equal(order?.customerEmail, EMAIL);
  assert.ok(order?.customer);
  assert.equal(await stockOf(item._id), 4, "stock decremented once");
});

test("a customer may hold a limited number of open COD orders; cancelling frees a slot", async () => {
  const { host, business, owner, session } = await signedInStore({ cod: true });
  const item = await product(business._id, 20);
  const ids: string[] = [];
  for (let i = 0; i < MAX_OPEN_COD_ORDERS_PER_CUSTOMER; i += 1) {
    const res = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
    assert.equal(res.status, 200);
    ids.push(String((await json(res)).orderId));
  }
  const over = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(over.status, 409);
  assert.equal((await json(over)).code, "cod_limit_reached");
  assert.equal(await stockOf(item._id), 20 - MAX_OPEN_COD_ORDERS_PER_CUSTOMER, "refused order reserved nothing");

  // A non-COD order is still possible, and cancelling a COD order frees a slot.
  assert.equal((await checkout(host, `${await cart(host, item._id)}; ${session}`)).status, 200);
  assert.equal((await manage(business._id, owner, ids[0], "cancel")).status, 200);
  assert.equal((await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" })).status, 200);
});

test("parallel COD checkouts by one customer cannot exceed the open-order limit", async () => {
  // Every checkout below belongs to one signed-in customer, and account carts are on (the
  // in-memory database has their index): each request's guest cart merges into that customer's
  // single cart for the store, so the requests compete for it. How they interleave decides which
  // succeed and how many units each order holds. So this checks what must hold in EVERY
  // interleaving, not how many succeed or exactly how much stock is left.
  const { host, business, session } = await signedInStore({ cod: true });
  const bystander = await store();
  const bystanderItem = await product(bystander.business._id, 20);
  const item = await product(business._id, 20);
  const attempts = MAX_OPEN_COD_ORDERS_PER_CUSTOMER + 2;
  const carts: string[] = [];
  for (let i = 0; i < attempts; i += 1) carts.push(await cart(host, item._id));
  const results = await Promise.all(carts.map((c) => checkout(host, `${c}; ${session}`, { paymentMethod: "cod" })));
  const bodies = await Promise.all(results.map((r) => json(r)));
  const outcomes = results.map((r, i) => `${r.status}:${String(bodies[i].code ?? "ok")}`).join(",");

  // Every answer is a success or one of the two expected refusals: the open-order limit, or
  // another request having already used the shared cart. Anything else fails.
  for (const [i, response] of results.entries()) {
    if (response.status === 200) continue;
    assert.equal(response.status, 409, outcomes);
    assert.ok(["cod_limit_reached", "cart_conflict"].includes(String(bodies[i].code)), outcomes);
  }
  const succeeded = bodies.filter((_, i) => results[i].status === 200);
  assert.ok(succeeded.length >= 1, `valid checkouts must not all be refused: ${outcomes}`);
  assert.ok(succeeded.length <= MAX_OPEN_COD_ORDERS_PER_CUSTOMER, outcomes);

  // Exactly the successful requests created orders, all within the open-order limit, all tied
  // to this customer in this store.
  const account = await Customer.findOne({ business: business._id, email: EMAIL }).lean();
  assert.ok(account);
  const orders = await Order.find({ business: business._id }).lean();
  assert.deepEqual(orders.map((o) => String(o._id)).sort(), succeeded.map((b) => String(b.orderId)).sort(), outcomes);
  assert.ok(
    (await Order.countDocuments({ business: business._id, customer: account._id, paymentMethod: "cod", status: "pending" })) <= MAX_OPEN_COD_ORDERS_PER_CUSTOMER,
    outcomes,
  );
  const unitsOf = (order: (typeof orders)[number]) => order.items.reduce((n, line) => n + line.quantity, 0);
  for (const order of orders) {
    assert.equal(order.paymentMethod, "cod");
    assert.equal(order.status, "pending");
    assert.equal(order.inventoryState, "reserved");
    assert.equal(String(order.customer), String(account._id), "tied to the signed-in customer");
    assert.equal(order.customerEmail, EMAIL);
    assert.ok(order.items.every((line) => String(line.product) === String(item._id)), "only this store's product");
    assert.ok(unitsOf(order) >= 1);
  }

  // Stock: exactly what was ordered is held. Merging carts never creates units, so no more than
  // the carts held (one each) can be ordered, and stock never goes below zero.
  const unitsOrdered = orders.reduce((n, order) => n + unitsOf(order), 0);
  assert.ok(unitsOrdered <= attempts, `${unitsOrdered} units ordered from ${attempts} one-unit carts`);
  const stock = await stockOf(item._id);
  assert.equal(stock, 20 - unitsOrdered, "stock fell by exactly the units ordered");
  assert.ok((stock ?? -1) >= 0);

  // The inventory history matches, order by order, and records nothing else.
  const movements = await InventoryMovement.find({ business: business._id }).lean();
  assert.equal(movements.reduce((n, m) => n + m.delta, 0), -unitsOrdered, "movements match the stock change");
  for (const m of movements) {
    assert.equal(m.reason, "order_reserved");
    assert.equal(String(m.product), String(item._id));
    assert.ok(orders.some((order) => String(order._id) === String(m.order)), "every movement belongs to a created order");
  }
  for (const order of orders) {
    const delta = movements.filter((m) => String(m.order) === String(order._id)).reduce((n, m) => n + m.delta, 0);
    assert.equal(delta, -unitsOf(order), "each order reserved exactly its own units");
  }

  // Another store is untouched.
  assert.equal(await stockOf(bystanderItem._id), 20);
  assert.equal(await Order.countDocuments({ business: bystander.business._id }), 0);
  assert.equal(await InventoryMovement.countDocuments({ business: bystander.business._id }), 0);
});

// ---------------------------------------------------------------------------
// Owner dashboard and historical orders
// ---------------------------------------------------------------------------

test("the owner list marks registered and guest orders without exposing account data; legacy orders are unaffected", async () => {
  const { host, business, owner, session, item } = await signedInStore({ cod: true });
  await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  await checkout(host, await cart(host, item._id));
  const legacy = await Order.create({
    business: business._id,
    ownerToken: `legacy-${crypto.randomUUID()}`,
    customerName: "Old Order",
    customerEmail: "old@example.com",
    items: [{ product: String(item._id), productName: "Mug", quantity: 1, unitPrice: 10, currency: "USD" }],
    subtotal: 10,
    total: 10,
    status: "pending",
  });

  const id = String(business._id);
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const res = (await callHandler(manageListGET, new Request(`http://localhost/api/businesses/${id}/manage/orders`, { headers: { ...headers } }), { params: Promise.resolve({ id }) })) as Response;
  assert.equal(res.status, 200);
  const raw = await res.text();
  const orders = (JSON.parse(raw) as { orders: Array<Record<string, unknown>> }).orders;
  assert.equal(orders.length, 3);
  const byName = Object.fromEntries(orders.map((o) => [o.customerEmail, o]));
  assert.equal(byName[EMAIL].placedBy, "registered");
  assert.equal(byName[EMAIL].paymentMethod, "cod");
  assert.equal(byName["typed@example.com"].placedBy, "guest");
  assert.equal(byName["old@example.com"].placedBy, "guest");
  assert.equal(byName["old@example.com"].paymentMethod, null);
  const account = await Customer.findOne({ email: EMAIL }).lean();
  assert.equal(raw.includes(String(account?._id)), false, "no customer id in the dashboard payload");
  assert.equal((await manage(business._id, owner, String(legacy._id), "mark_paid")).status, 409, "legacy orders still cannot be marked paid");
  assert.equal((await Order.findById(legacy._id).lean())?.customer, undefined, "legacy orders are never back-filled");
});

test("cross-tenant: another owner cannot confirm or cancel a store's COD order", async () => {
  const { host, business, session, item } = await signedInStore({ cod: true });
  const res = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  const orderId = String((await json(res)).orderId);
  const other = await store();
  assert.equal((await manage(business._id, other.owner, orderId, "mark_paid")).status, 403);
  assert.equal((await manage(other.business._id, other.owner, orderId, "mark_paid")).status, 404);
  assert.equal((await manage(other.business._id, other.owner, orderId, "cancel")).status, 404);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
  assert.equal(new mongoose.Types.ObjectId(String(business._id)).equals((await Order.findById(orderId).lean())?.business), true);
});

// ---------------------------------------------------------------------------
// Customer order history
// ---------------------------------------------------------------------------

test("order history lists only the signed-in customer's own orders at this store", async () => {
  const { host, business, session, item } = await signedInStore({ cod: true });
  const mine = await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" });
  assert.equal(mine.status, 200);
  const mineId = String((await json(mine)).orderId);
  await checkout(host, await cart(host, item._id)); // a guest order: never listed

  // Another customer of the same store.
  await registerVerified(host, "grace@example.com");
  const graceSession = sessionCookie(await login(host, "grace@example.com"));
  await checkout(host, `${await cart(host, item._id)}; ${graceSession}`);

  // The same email at another store is a different account.
  const other = await signedInStore();
  await checkout(other.host, `${await cart(other.host, other.item._id)}; ${other.session}`);

  const res = await call(customerOrdersGET, host, undefined, { cookie: session });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const raw = await res.text();
  const { orders } = JSON.parse(raw) as { orders: Array<Record<string, unknown>> };
  assert.deepEqual(orders.map((o) => o.orderId), [mineId]);
  assert.equal(orders[0].paymentMethod, "cod");
  for (const secret of ["ownerToken", "orderProofHash", "idempotencyKey", "customer\""]) {
    assert.equal(raw.includes(secret), false, secret);
  }
  assert.equal(await Order.countDocuments({ business: business._id }), 3);

  // Store B's session sees only store B's order, even on store B's host.
  const otherRes = await call(customerOrdersGET, other.host, undefined, { cookie: other.session });
  assert.equal((JSON.parse(await otherRes.text()) as { orders: unknown[] }).orders.length, 1);
  // Store A's session on store B's host: signed out there.
  assert.equal((await call(customerOrdersGET, other.host, undefined, { cookie: session })).status, 401);
});

test("order history requires a session and the feature flag", async () => {
  const { host, session } = await signedInStore();
  assert.equal((await call(customerOrdersGET, host, undefined, {})).status, 401);
  await call(logoutPOST, host, {}, { ip: freshIp(), cookie: session });
  assert.equal((await call(customerOrdersGET, host, undefined, { cookie: session })).status, 401, "revoked session");
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  const off = await call(customerOrdersGET, host, undefined, { cookie: session });
  assert.equal(off.status, 404);
  assert.equal((await json(off)).code, "not_found");
});

// ---------------------------------------------------------------------------
// Customer cancellation of their own orders
// ---------------------------------------------------------------------------

function cancelAsCustomer(host: string, orderId: string, cookie?: string, origin?: string) {
  return (async () => {
    const response = await customerCancelPOST(
      new Request(`http://${host}/api/storefront/account/orders/${orderId}/cancel`, {
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "x-forwarded-for": freshIp(),
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
        body: "{}",
      }),
      { params: Promise.resolve({ orderId }) },
    );
    await drainAfterResponseTasks();
    return response;
  })();
}

test("a customer cancels only their own unpaid orders; stock is restored exactly once", async () => {
  const { host, business, owner, session, item } = await signedInStore({ cod: true });
  const mine = String((await json(await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" }))).orderId);
  const guest = String((await json(await checkout(host, await cart(host, item._id)))).orderId);
  await registerVerified(host, "grace@example.com");
  const graceSession = sessionCookie(await login(host, "grace@example.com"));
  const grace = String((await json(await checkout(host, `${await cart(host, item._id)}; ${graceSession}`))).orderId);
  assert.equal(await stockOf(item._id), 2);

  const foreign = await cancelAsCustomer(host, mine, session, "http://evil.localhost:3000");
  assert.equal(foreign.status, 403);
  assert.equal((await cancelAsCustomer(host, grace, session)).status, 404, "another customer's order");
  assert.equal((await cancelAsCustomer(host, guest, session)).status, 404, "a guest order");
  assert.equal((await cancelAsCustomer(host, "not-an-id", session)).status, 404);
  assert.equal((await cancelAsCustomer(host, mine)).status, 401, "signed out");
  const other = await store();
  assert.equal((await cancelAsCustomer(other.host, mine, session)).status, 401, "another store's host");
  assert.equal(await stockOf(item._id), 2, "nothing changed yet");

  const ok = await cancelAsCustomer(host, mine, session);
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).status, "cancelled");
  assert.equal(await stockOf(item._id), 3);
  assert.equal((await Order.findById(mine).lean())?.cancelReason, "customer");
  assert.equal((await cancelAsCustomer(host, mine, session)).status, 200, "repeating is safe");
  assert.equal(await stockOf(item._id), 3, "no double restock");

  // A paid order cannot be cancelled by the customer.
  const paidId = String((await json(await checkout(host, `${await cart(host, item._id)}; ${session}`, { paymentMethod: "cod" }))).orderId);
  assert.equal((await manage(business._id, owner, paidId, "mark_paid")).status, 200);
  const paid = await cancelAsCustomer(host, paidId, session);
  assert.equal(paid.status, 409);
  assert.equal((await json(paid)).code, "not_cancellable");
  assert.equal((await Order.findById(paidId).lean())?.status, "paid");

  const history = (await json(await call(customerOrdersGET, host, undefined, { cookie: session }))) as { orders: Array<{ orderId: string; canCancel: boolean }> };
  const flags = Object.fromEntries(history.orders.map((o) => [o.orderId, o.canCancel]));
  assert.equal(flags[mine], false);
  assert.equal(flags[paidId], false);
});
