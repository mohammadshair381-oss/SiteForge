import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { createMembership } from "./helpers/tenant";
import { call, freshIp, setCookies, store } from "./helpers/customer-accounts";
import { POST as cartPOST } from "@/app/api/businesses/[id]/cart/route";
import { POST as orderPOST } from "@/app/api/businesses/[id]/orders/route";
import { GET as accountGET, PUT as accountPUT, DELETE as accountDELETE } from "@/app/api/businesses/[id]/payment-account/route";
import { POST as payPOST } from "@/app/api/storefront/orders/[orderId]/pay/route";
import { GET as returnGET } from "@/app/api/storefront/payments/razorpay/return/route";
import { POST as webhookPOST } from "@/app/api/webhooks/razorpay/[businessId]/route";
import { GET as manageListGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { PATCH as manageOrderPATCH } from "@/app/api/businesses/[id]/manage/orders/[orderId]/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { releaseExpiredOrders } from "@/lib/orders/lifecycle";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { Product } from "@/models/Product";

/**
 * Online order payments through each business's own Razorpay account, against
 * a FAKE Razorpay API (global fetch is replaced; any other URL throws, so no
 * request can leave the process). Nothing here moves real money.
 */

// ---------------------------------------------------------------------------
// Fake Razorpay
// ---------------------------------------------------------------------------

interface FakeLink {
  id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
  reference_id: string;
  short_url: string;
  payments: Array<{ payment_id: string; amount: number; status: string }>;
  keyId: string;
}

const links = new Map<string, FakeLink>();
const providerCalls: Array<{ method: string; path: string; keyId: string }> = [];
let linkCounter = 0;
let providerDown = false;
const realFetch = globalThis.fetch;

function fakeRazorpay(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected network request in test: ${url.origin}`);
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const keyId = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":")[0];
  const method = init?.method ?? "GET";
  providerCalls.push({ method, path: url.pathname, keyId });
  if (providerDown) return Promise.resolve(new Response("{}", { status: 503 }));
  if (method === "POST" && url.pathname === "/v1/payment_links") {
    const body = JSON.parse(String(init?.body));
    if ([...links.values()].some((l) => l.reference_id === body.reference_id && l.keyId === keyId)) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }), { status: 400 }));
    }
    linkCounter += 1;
    const link: FakeLink = {
      id: `plink_T${linkCounter}`,
      amount: body.amount,
      amount_paid: 0,
      currency: body.currency,
      status: "created",
      reference_id: body.reference_id,
      short_url: `https://rzp.io/i/T${linkCounter}`,
      payments: [],
      keyId,
    };
    links.set(link.id, link);
    return Promise.resolve(new Response(JSON.stringify(link), { status: 200 }));
  }
  const match = url.pathname.match(/^\/v1\/payment_links\/(plink_\w+)$/);
  if (method === "GET" && match) {
    const link = links.get(match[1]);
    // A link is only visible to the account that created it.
    if (!link || link.keyId !== keyId) return Promise.resolve(new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }), { status: 400 }));
    return Promise.resolve(new Response(JSON.stringify(link), { status: 200 }));
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

/** The shopper completes the payment on the hosted page. */
function payLink(id: string, overrides: Partial<FakeLink> = {}) {
  const link = links.get(id);
  assert.ok(link, "link exists");
  Object.assign(link, { status: "paid", amount_paid: link.amount, payments: [{ payment_id: `pay_${id}`, amount: link.amount, status: "captured" }] }, overrides);
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

const ENV_KEYS = ["ORDER_ONLINE_PAYMENTS_ENABLED", "ORDER_PAYMENTS_LIVE_ALLOWED", "PAYMENT_CREDENTIALS_KEY", "CUSTOMER_ACCOUNTS_ENABLED"];

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
  for (const key of ENV_KEYS) delete process.env[key];
  clearRequestCookies();
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  globalThis.fetch = fakeRazorpay as typeof fetch;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ORDER_ONLINE_PAYMENTS_ENABLED = "true";
  process.env.PAYMENT_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
  links.clear();
  providerCalls.length = 0;
  providerDown = false;
  clearRequestCookies();
  await drainAfterResponseTasks();
  await clearAllCollections();
});

const KEY_SECRET = "test_key_secret_value_1";
const WEBHOOK_SECRET = "test_webhook_secret_value_1";

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function product(businessId: unknown, options: { price?: number; currency?: string; stock?: number } = {}) {
  return Product.create({
    business: businessId,
    name: "Tea",
    slug: `tea-${crypto.randomUUID().slice(0, 8)}`,
    price: options.price ?? 499.5,
    currency: options.currency ?? "INR",
    stock: options.stock ?? 5,
    status: "active",
  });
}

async function cart(host: string, productId: unknown): Promise<string> {
  const response = await call(cartPOST, host, { productId: String(productId), quantity: 1 }, { ip: freshIp() });
  assert.equal(response.status, 200, await response.clone().text());
  const raw = setCookies(response).find((c) => c.startsWith("cart-token="));
  assert.ok(raw);
  return raw.split(";")[0];
}

function checkout(host: string, cookie: string, body: Record<string, unknown> = {}, options: { origin?: string; contentType?: string } = {}) {
  return call(
    orderPOST,
    host,
    { customerName: "Ada Shopper", customerEmail: "ada@example.com", paymentMethod: "online", ...body },
    { ip: freshIp(), cookie, origin: options.origin, contentType: options.contentType },
  );
}

async function account(
  method: "GET" | "PUT" | "DELETE",
  businessId: unknown,
  user: { _id: unknown; tokenVersion: number },
  body?: unknown,
  origin?: string,
) {
  const id = String(businessId);
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  const handler = method === "GET" ? accountGET : method === "PUT" ? accountPUT : accountDELETE;
  const res = (await callHandler(
    handler,
    new Request(`http://localhost/api/businesses/${id}/payment-account`, {
      method,
      headers: { "Content-Type": "application/json", host: "localhost", ...(origin ? { origin } : {}), ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: await json(res) };
}

function connectBody(overrides: Record<string, unknown> = {}) {
  return { mode: "test", keyId: `rzp_test_${crypto.randomBytes(6).toString("hex")}`, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, ...overrides };
}

async function connectedStore(options: { keySecret?: string; webhookSecret?: string } = {}) {
  const shop = await store();
  const res = await account("PUT", shop.business._id, shop.owner, connectBody({
    ...(options.keySecret ? { keySecret: options.keySecret } : {}),
    ...(options.webhookSecret ? { webhookSecret: options.webhookSecret } : {}),
  }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return shop;
}

async function placeOnlineOrder(shop: { host: string; business: { _id: unknown } }, productOptions = {}) {
  const item = await product(shop.business._id, productOptions);
  const res = await checkout(shop.host, await cart(shop.host, item._id));
  assert.equal(res.status, 200, await res.clone().text());
  const body = await json(res);
  return { item, orderId: String(body.orderId), proof: String(body.orderProof) };
}

function pay(host: string, orderId: string, proof?: string, origin?: string) {
  return callHandler(
    payPOST,
    new Request(`http://${host}/api/storefront/orders/${orderId}/pay`, {
      method: "POST",
      headers: {
        host,
        "content-type": "application/json",
        "x-forwarded-for": freshIp(),
        ...(proof ? { "x-order-proof": proof } : {}),
        ...(origin ? { origin } : {}),
      },
      body: "{}",
    }),
    { params: Promise.resolve({ orderId }) },
  ) as Promise<Response>;
}

function callbackSignature(secret: string, linkId: string, referenceId: string, status: string, paymentId: string) {
  return crypto.createHmac("sha256", secret).update(`${linkId}|${referenceId}|${status}|${paymentId}`).digest("hex");
}

function returnFromProvider(host: string, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return returnGET(
    new Request(`http://${host}/api/storefront/payments/razorpay/return?${query}`, {
      headers: { host, "x-forwarded-for": freshIp() },
    }),
  );
}

function signedReturn(host: string, linkId: string, orderId: string, secret = KEY_SECRET, status = "paid") {
  const paymentId = `pay_${linkId}`;
  return returnFromProvider(host, {
    razorpay_payment_id: paymentId,
    razorpay_payment_link_id: linkId,
    razorpay_payment_link_reference_id: orderId,
    razorpay_payment_link_status: status,
    razorpay_signature: callbackSignature(secret, linkId, orderId, status, paymentId),
  });
}

function webhook(businessId: unknown, linkId: string, options: { secret?: string; event?: string; eventId?: string; rawBody?: string } = {}) {
  const id = String(businessId);
  const body = options.rawBody ?? JSON.stringify({ event: options.event ?? "payment_link.paid", payload: { payment_link: { entity: { id: linkId } } } });
  const signature = crypto.createHmac("sha256", options.secret ?? WEBHOOK_SECRET).update(body).digest("hex");
  return callHandler(
    webhookPOST,
    new Request(`http://localhost/api/webhooks/razorpay/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": options.eventId ?? "evt_1" },
      body,
    }),
    { params: Promise.resolve({ businessId: id }) },
  ) as Promise<Response>;
}

async function startPayment(shop: { host: string }, orderId: string, proof: string) {
  const res = await pay(shop.host, orderId, proof);
  assert.equal(res.status, 200, await res.clone().text());
  const url = String((await json(res)).url);
  const payment = await OrderPayment.findOne({ order: orderId }).lean();
  assert.ok(payment);
  return { url, linkId: payment.providerLinkId };
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

test("online payment is refused while the platform flag is off or the store has no usable account", async () => {
  delete process.env.ORDER_ONLINE_PAYMENTS_ENABLED;
  const shop = await store();
  const item = await product(shop.business._id);
  let res = await checkout(shop.host, await cart(shop.host, item._id));
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, "online_payment_unavailable");

  process.env.ORDER_ONLINE_PAYMENTS_ENABLED = "true";
  res = await checkout(shop.host, await cart(shop.host, item._id));
  assert.equal(res.status, 403, "no connected account");
  assert.equal((await product(shop.business._id)).stock, 5);
  assert.equal(await Order.countDocuments({}), 0);
  assert.equal(providerCalls.length, 0);

  // Guest checkout without a payment method is unchanged.
  res = await checkout(shop.host, await cart(shop.host, item._id), { paymentMethod: undefined });
  assert.equal(res.status, 200);
  assert.equal((await Order.findOne({}).lean())?.paymentMethod, undefined);
});

test("a disconnected account, a missing encryption key, or a live account without approval hides online payment", async () => {
  const shop = await connectedStore();
  const item = await product(shop.business._id);

  const savedKey = process.env.PAYMENT_CREDENTIALS_KEY;
  delete process.env.PAYMENT_CREDENTIALS_KEY;
  assert.equal((await checkout(shop.host, await cart(shop.host, item._id))).status, 403);
  process.env.PAYMENT_CREDENTIALS_KEY = savedKey;

  await BusinessPaymentAccount.updateOne({ business: shop.business._id }, { $set: { mode: "live" } });
  assert.equal((await checkout(shop.host, await cart(shop.host, item._id))).status, 403, "live account needs ORDER_PAYMENTS_LIVE_ALLOWED");
  await BusinessPaymentAccount.updateOne({ business: shop.business._id }, { $set: { mode: "test" } });

  assert.equal((await account("DELETE", shop.business._id, shop.owner)).status, 200);
  assert.equal((await checkout(shop.host, await cart(shop.host, item._id))).status, 403);
  const raw = await BusinessPaymentAccount.collection.findOne({ business: shop.business._id });
  assert.equal(raw?.status, "disabled");
  assert.equal(raw?.keySecretEnc, undefined, "secrets removed on disconnect");
  assert.equal(raw?.webhookSecretEnc, undefined);
});

// ---------------------------------------------------------------------------
// Owner-only account management
// ---------------------------------------------------------------------------

test("only the owner manages the account; secrets are encrypted at rest and never returned", async () => {
  const shop = await store();
  const manager = await createUser({ email: "mgr@example.com" });
  await createMembership(shop.business._id, manager._id, "manager");
  const staff = await createUser({ email: "staff@example.com" });
  await createMembership(shop.business._id, staff._id, "staff");
  const other = await store();

  for (const user of [manager, staff, other.owner]) {
    assert.equal((await account("PUT", shop.business._id, user, connectBody())).status, 403);
    assert.equal((await account("GET", shop.business._id, user)).status, 403);
    assert.equal((await account("DELETE", shop.business._id, user)).status, 403);
  }
  assert.equal(await BusinessPaymentAccount.countDocuments({}), 0);

  const body = connectBody();
  const res = await account("PUT", shop.business._id, shop.owner, body);
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(KEY_SECRET) && !text.includes(WEBHOOK_SECRET) && !text.includes("keySecretEnc"));
  assert.equal((res.body.account as { keyId: string }).keyId, body.keyId);

  const raw = await BusinessPaymentAccount.collection.findOne({ business: shop.business._id });
  const stored = JSON.stringify(raw);
  assert.ok(!stored.includes(KEY_SECRET) && !stored.includes(WEBHOOK_SECRET), "no plaintext secret in the database");
  assert.ok(raw?.keySecretEnc?.ct && raw?.keySecretEnc?.iv && raw?.keySecretEnc?.tag);

  const read = await account("GET", shop.business._id, shop.owner);
  assert.ok(!JSON.stringify(read.body).includes("Enc"));
  // Default queries never select the encrypted fields either.
  const doc = await BusinessPaymentAccount.findOne({ business: shop.business._id });
  assert.equal(doc?.keySecretEnc, undefined);
  // Even a document that explicitly selected them strips them from JSON.
  const withSecrets = await BusinessPaymentAccount.findOne({ business: shop.business._id }).select("+keySecretEnc +webhookSecretEnc");
  assert.ok(withSecrets?.keySecretEnc, "selected for server use");
  const serialized = JSON.stringify(withSecrets?.toJSON());
  assert.ok(!serialized.includes("keySecretEnc") && !serialized.includes("webhookSecretEnc"));
});

test("account input is validated: mode/key prefix, live approval, flag, key configuration and origin", async () => {
  const shop = await store();
  const put = (body: unknown, origin?: string) => account("PUT", shop.business._id, shop.owner, body, origin);

  assert.equal((await put(connectBody({ keyId: "rzp_live_abcdef123" }))).body.code, "invalid_key_id");
  const live = await put(connectBody({ mode: "live", keyId: "rzp_live_abcdef123" }));
  assert.equal(live.status, 403);
  assert.equal(live.body.code, "live_payments_disabled");
  assert.equal((await put({ mode: "test", keyId: "rzp_test_abcdef123" })).status, 422);
  assert.equal((await put(connectBody(), "https://evil.example")).status, 403);

  delete process.env.ORDER_ONLINE_PAYMENTS_ENABLED;
  assert.equal((await put(connectBody())).body.code, "online_payments_disabled");
  process.env.ORDER_ONLINE_PAYMENTS_ENABLED = "true";
  delete process.env.PAYMENT_CREDENTIALS_KEY;
  assert.equal((await put(connectBody())).status, 503);
  assert.equal(await BusinessPaymentAccount.countDocuments({}), 0);

  process.env.PAYMENT_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
  process.env.ORDER_PAYMENTS_LIVE_ALLOWED = "true";
  assert.equal((await put(connectBody({ mode: "live", keyId: "rzp_live_abcdef123" }))).status, 200);
});

// ---------------------------------------------------------------------------
// Checkout and starting a payment
// ---------------------------------------------------------------------------

test("online checkout reserves stock, needs same-origin JSON and INR, and never calls the provider", async () => {
  const shop = await connectedStore();
  const item = await product(shop.business._id, { currency: "USD", price: 10 });
  const usd = await checkout(shop.host, await cart(shop.host, item._id));
  assert.equal(usd.status, 400);
  assert.equal((await json(usd)).code, "currency_not_supported");
  assert.equal((await Product.findById(item._id).lean())?.stock, 5, "stock untouched");

  const inr = await product(shop.business._id);
  assert.equal((await checkout(shop.host, await cart(shop.host, inr._id), {}, { origin: "https://evil.example" })).status, 403);
  const form = await checkout(shop.host, await cart(shop.host, inr._id), {}, { contentType: "application/x-www-form-urlencoded" });
  assert.notEqual(form.status, 200);

  const { orderId } = await placeOnlineOrder(shop);
  const order = await Order.findById(orderId).lean();
  assert.equal(order?.paymentMethod, "online");
  assert.equal(order?.status, "pending");
  assert.ok(order?.reservationExpiresAt instanceof Date, "online reservations expire");
  assert.equal(providerCalls.length, 0, "checkout itself never talks to the provider");
});

test("starting a payment requires the order proof on the same store and reuses one link", async () => {
  const shop = await connectedStore();
  const other = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const second = await placeOnlineOrder(shop);

  assert.equal((await pay(shop.host, orderId)).status, 404, "no proof");
  assert.equal((await pay(shop.host, orderId, second.proof)).status, 404, "another order's proof");
  assert.equal((await pay(other.host, orderId, proof)).status, 404, "another store's host");
  assert.equal((await pay(shop.host, "not-an-id", proof)).status, 404);
  assert.equal((await pay(shop.host, orderId, proof, "https://evil.example")).status, 403);
  assert.equal(providerCalls.length, 0);

  const first = await startPayment(shop, orderId, proof);
  assert.match(first.url, /^https:\/\/rzp\.io\//);
  const again = await pay(shop.host, orderId, proof);
  assert.equal((await json(again)).url, first.url);
  assert.equal(providerCalls.filter((c) => c.method === "POST").length, 1, "one link per order");

  const payment = await OrderPayment.findOne({ order: orderId }).lean();
  assert.equal(payment?.amountMinor, 49950);
  assert.equal(payment?.currency, "INR");
  assert.equal(payment?.mode, "test");
  assert.equal(String(payment?.business), String(shop.business._id));
  const created = links.get(first.linkId);
  assert.equal(created?.reference_id, orderId);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending", "starting a payment changes nothing");
});

test("a provider outage while starting a payment is a 502 and records nothing", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  providerDown = true;
  const res = await pay(shop.host, orderId, proof);
  assert.equal(res.status, 502);
  assert.equal((await json(res)).code, "payment_provider_error");
  assert.equal(await OrderPayment.countDocuments({}), 0);
});

// ---------------------------------------------------------------------------
// Confirmation: never from the redirect alone
// ---------------------------------------------------------------------------

test("the return redirect never marks an order paid unless Razorpay confirms it", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const { linkId } = await startPayment(shop, orderId, proof);

  // Forged signature.
  let res = await signedReturn(shop.host, linkId, orderId, "wrong_secret");
  assert.equal(res.status, 303);
  assert.match(String(res.headers.get("location")), new RegExp(`/order/${orderId}\\?payment=pending$`));
  // Correctly signed "paid" redirect, but the provider says the link is unpaid.
  res = await signedReturn(shop.host, linkId, orderId);
  assert.match(String(res.headers.get("location")), /payment=pending$/);
  // Reference id of another order.
  res = await signedReturn(shop.host, linkId, "64b000000000000000000000");
  assert.equal(new URL(String(res.headers.get("location"))).pathname, "/");
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
  assert.equal((await OrderPayment.findOne({ order: orderId }).lean())?.status, "created");

  payLink(linkId);
  res = await signedReturn(shop.host, linkId, orderId);
  assert.match(String(res.headers.get("location")), /payment=success$/);
  const order = await Order.findById(orderId).lean();
  assert.equal(order?.status, "paid");
  assert.equal(order?.inventoryState, "consumed");
  const payment = await OrderPayment.findOne({ order: orderId }).lean();
  assert.equal(payment?.status, "paid");
  assert.equal(payment?.orderOutcome, "applied");
  assert.equal(payment?.providerPaymentId, `pay_${linkId}`);

  // Replays are harmless.
  res = await signedReturn(shop.host, linkId, orderId);
  assert.match(String(res.headers.get("location")), /payment=success$/);
  assert.equal((await Product.findOne({ business: shop.business._id }).lean())?.stock, 4, "stock consumed once");
});

test("a paid link whose amount or currency differs from the order is not applied", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const { linkId } = await startPayment(shop, orderId, proof);
  payLink(linkId, { amount: 100, amount_paid: 100 });
  let res = await webhook(shop.business._id, linkId);
  assert.equal((await json(res)).outcome, "not_paid");
  payLink(linkId, { currency: "USD" });
  res = await webhook(shop.business._id, linkId);
  assert.equal((await json(res)).outcome, "not_paid");
  payLink(linkId, { amount_paid: 1 });
  links.get(linkId)!.amount_paid = 1;
  res = await webhook(shop.business._id, linkId);
  assert.equal((await json(res)).outcome, "not_paid", "partial payment");
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test("webhooks need a valid signature; duplicates are idempotent; unrelated events are acknowledged", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const { linkId } = await startPayment(shop, orderId, proof);
  payLink(linkId);

  assert.equal((await webhook(shop.business._id, linkId, { secret: "wrong" })).status, 401);
  assert.equal((await webhook("64b000000000000000000000", linkId)).status, 401, "unknown business");
  assert.equal((await webhook("not-an-id", linkId)).status, 401);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");

  const unrelated = await webhook(shop.business._id, linkId, { event: "payment.authorized" });
  assert.equal(unrelated.status, 200);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");

  const results = await Promise.all([1, 2, 3].map(() => webhook(shop.business._id, linkId, { eventId: "evt_dup" })));
  for (const res of results) assert.equal(res.status, 200);
  const outcomes = await Promise.all(results.map(async (r) => (await json(r)).outcome));
  assert.equal(outcomes.filter((o) => o === "applied").length <= 1, true, JSON.stringify(outcomes));
  assert.ok(outcomes.every((o) => o === "applied" || o === "already_applied"), JSON.stringify(outcomes));
  assert.equal((await Order.findById(orderId).lean())?.status, "paid");
  assert.equal((await Product.findOne({ business: shop.business._id }).lean())?.stock, 4);
  assert.equal(await OrderPayment.countDocuments({ order: orderId, status: "paid" }), 1);

  const bad = await webhook(shop.business._id, linkId, { rawBody: "{not json" });
  assert.equal(bad.status, 400);
});

test("a business's webhook secret cannot confirm another business's payment", async () => {
  const a = await connectedStore();
  const b = await connectedStore({ webhookSecret: "other_business_webhook_secret" });
  const { orderId, proof } = await placeOnlineOrder(a);
  const { linkId } = await startPayment(a, orderId, proof);
  payLink(linkId);

  // B's correctly signed webhook naming A's link: scoped to B, so unknown.
  const res = await webhook(b.business._id, linkId, { secret: "other_business_webhook_secret" });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).outcome, "unknown_link");
  // A's link id through B's store return URL is not found either.
  const ret = await signedReturn(b.host, linkId, orderId);
  assert.equal(new URL(String(ret.headers.get("location"))).pathname, "/");
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
});

test("a provider outage during a webhook returns 502 so Razorpay retries", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const { linkId } = await startPayment(shop, orderId, proof);
  payLink(linkId);
  providerDown = true;
  assert.equal((await webhook(shop.business._id, linkId)).status, 502);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
  providerDown = false;
  assert.equal((await json(await webhook(shop.business._id, linkId))).outcome, "applied");
});

test("an expired link is recorded; a payment after the reservation was released is flagged for the owner", async () => {
  const shop = await connectedStore();
  const { orderId, proof } = await placeOnlineOrder(shop);
  const { linkId } = await startPayment(shop, orderId, proof);

  links.get(linkId)!.status = "expired";
  await webhook(shop.business._id, linkId, { event: "payment_link.expired" });
  assert.equal((await OrderPayment.findOne({ order: orderId }).lean())?.status, "failed");

  // The reservation ends and is released, then a (late) payment is captured.
  await Order.updateOne({ _id: orderId }, { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } });
  await releaseExpiredOrders({ businessId: String(shop.business._id) });
  assert.equal((await Order.findById(orderId).lean())?.status, "cancelled");
  payLink(linkId);
  const res = await webhook(shop.business._id, linkId);
  assert.equal((await json(res)).outcome, "needs_review");
  assert.equal((await Order.findById(orderId).lean())?.status, "cancelled", "a released order is never resurrected");
  const payment = await OrderPayment.findOne({ order: orderId }).lean();
  assert.equal(payment?.status, "paid");
  assert.equal(payment?.orderOutcome, "needs_review");

  const headers = await createAuthHeadersForUser(String(shop.owner._id), "user", shop.owner.tokenVersion);
  const id = String(shop.business._id);
  const list = (await callHandler(
    manageListGET,
    new Request(`http://localhost/api/businesses/${id}/manage/orders`, { headers: { ...headers } }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  const orders = (await json(list)).orders as Array<{ id: string; paymentNeedsReview: boolean }>;
  assert.equal(orders.find((o) => o.id === orderId)?.paymentNeedsReview, true);
});

test("owners still cannot mark an online order paid by hand", async () => {
  const shop = await connectedStore();
  const { orderId } = await placeOnlineOrder(shop);
  const id = String(shop.business._id);
  const headers = await createAuthHeadersForUser(String(shop.owner._id), "user", shop.owner.tokenVersion);
  const res = (await callHandler(
    manageOrderPATCH,
    new Request(`http://localhost/api/businesses/${id}/manage/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ action: "mark_paid" }),
    }),
    { params: Promise.resolve({ id, orderId }) },
  )) as Response;
  assert.equal(res.status, 409);
  assert.equal((await Order.findById(orderId).lean())?.status, "pending");
});
