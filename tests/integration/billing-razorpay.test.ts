import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import { createUser } from "./helpers/fixtures";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { billingConfig, ensureProviderPlan } from "@/lib/billing-razorpay";
import { getEntitlements } from "@/lib/billing";
import { BillingEvent } from "@/models/BillingEvent";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { Payment } from "@/models/Payment";
import { Plan } from "@/models/Plan";
import { Subscription } from "@/models/Subscription";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { GET as invoicesGET } from "@/app/api/businesses/[id]/subscription/invoices/route";
import { POST as webhookPOST } from "@/app/api/webhooks/razorpay-billing/route";
import { POST as adminPlanPOST } from "@/app/api/admin/plans/razorpay/route";

/** Everything goes to this fake: automated tests never reach the network. */
const WEBHOOK_SECRET = "billing-webhook-secret";
type Remote = { id: string; plan_id: string; status: string; current_start: number | null; current_end: number | null; paid_count: number; remaining_count: number; short_url: string };
let remotes: Map<string, Remote>;
let payments: Map<string, { id: string; amount: number; currency: string; status: string; created_at: number }>;
let calls: Array<{ method: string; path: string; body: Record<string, unknown> }>;
let failReads = false;
const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeRazorpay(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  assert.ok(url.startsWith("https://api.razorpay.com/v1"), `unexpected request to ${url}`);
  const path = url.replace("https://api.razorpay.com/v1", "");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ method, path, body });
  if (method === "GET" && failReads) return Promise.resolve(json(500, { error: { code: "SERVER_ERROR" } }));
  if (method === "POST" && path === "/plans") return Promise.resolve(json(200, { id: `plan_${calls.length}` }));
  if (method === "POST" && path === "/subscriptions") {
    const id = `sub${calls.length}x`;
    const remote: Remote = { id: `sub_${id}`, plan_id: body.plan_id, status: "created", current_start: null, current_end: null, paid_count: 0, remaining_count: body.total_count, short_url: `https://rzp.io/i/${id}` };
    remotes.set(remote.id, remote);
    return Promise.resolve(json(200, remote));
  }
  const sub = /^\/subscriptions\/([^/]+)(\/cancel)?$/.exec(path);
  if (sub) {
    const remote = remotes.get(sub[1]);
    if (!remote) return Promise.resolve(json(404, { error: { code: "BAD_REQUEST_ERROR" } }));
    if (method === "PATCH" && body.plan_id) return Promise.resolve(json(200, remote));
    if (method === "POST" && sub[2] && !body.cancel_at_cycle_end) remote.status = "cancelled";
    return Promise.resolve(json(200, remote));
  }
  const pay = /^\/payments\/(.+)$/.exec(path);
  if (pay) return Promise.resolve(payments.has(pay[1]) ? json(200, payments.get(pay[1])) : json(404, { error: { code: "BAD_REQUEST_ERROR" } }));
  if (path.startsWith("/invoices?")) return Promise.resolve(json(200, { items: [{ id: "inv_1", status: "paid", amount: 2900, currency: "USD", billing_start: 1, billing_end: 2, paid_at: 2, short_url: "https://rzp.io/i/inv1" }, { id: "inv_2", status: "issued", amount: 2900, currency: "USD", billing_start: 2, billing_end: 3, paid_at: null, short_url: "https://evil.example/x" }] }));
  return Promise.resolve(json(400, { error: { code: "UNSUPPORTED_IN_FAKE" } }));
}

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  Object.assign(process.env, { PAYMENT_PROVIDER: "razorpay", RAZORPAY_BILLING_KEY_ID: "rzp_test_platform", RAZORPAY_BILLING_KEY_SECRET: "platform-secret", RAZORPAY_BILLING_WEBHOOK_SECRET: WEBHOOK_SECRET, BILLING_GRACE_DAYS: "3" });
  globalThis.fetch = fakeRazorpay as typeof fetch;
  await connectTestDB();
});

after(async () => {
  globalThis.fetch = realFetch;
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
  resetMockCookieStore();
  remotes = new Map();
  payments = new Map();
  calls = [];
  failReads = false;
});

const req = (body: unknown, headers: unknown = {}) => new Request("http://localhost/x", { method: "POST", headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function setup() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const free = await createPlan({ key: "free", price: 0 });
  const pro = await createPlan({ key: "pro", price: 29, productLimit: 50 });
  await createSubscription(business._id, free._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { id: String(business._id), headers, owner, free, pro };
}

const post = (id: string, body: unknown, headers: unknown) => callHandler(subscriptionPOST, req(body, headers), ctx(id));

function delivery(event: string, subId: string, options: { paymentId?: string; eventId?: string; signature?: string } = {}) {
  const raw = JSON.stringify({ event, payload: { subscription: { entity: { id: subId } }, ...(options.paymentId ? { payment: { entity: { id: options.paymentId } } } : {}) } });
  const signature = options.signature ?? crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return webhookPOST(new Request("http://localhost/api/webhooks/razorpay-billing", { method: "POST", headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": options.eventId ?? crypto.randomUUID() }, body: raw }));
}

const periodStart = () => Math.floor(Date.now() / 1000);
const periodEnd = () => periodStart() + 30 * 24 * 3600;

async function checkout(id: string, headers: unknown) {
  await ensureProviderPlan("pro");
  const res = await post(id, { planKey: "pro" }, headers);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.checkoutUrl, /^https:\/\/rzp\.io\//);
  return [...remotes.values()].at(-1) as Remote;
}

async function activate(id: string, headers: unknown) {
  const remote = await checkout(id, headers);
  Object.assign(remote, { status: "active", paid_count: 1, current_start: periodStart(), current_end: periodEnd() });
  payments.set("pay_first", { id: "pay_first", amount: 2900, currency: "USD", status: "captured", created_at: periodStart() });
  assert.equal((await delivery("subscription.charged", remote.id, { paymentId: "pay_first" })).status, 200);
  return remote;
}

test("live keys are refused without their own approval", () => {
  assert.equal(billingConfig()?.mode, "test");
  process.env.RAZORPAY_BILLING_KEY_ID = "rzp_live_platform";
  assert.equal(billingConfig(), null);
  process.env.BILLING_LIVE_ALLOWED = "true";
  assert.equal(billingConfig()?.mode, "live");
  delete process.env.BILLING_LIVE_ALLOWED;
  process.env.RAZORPAY_BILLING_KEY_ID = "rzp_test_platform";
});

test("a plan must be set up at Razorpay first, and a new price makes a new Razorpay plan", async () => {
  const { id, headers } = await setup();
  const refused = await post(id, { planKey: "pro" }, headers);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "plan_not_mapped");

  const first = await ensureProviderPlan("pro");
  assert.equal(first.created, true);
  assert.equal(first.mapping.amountMinor, 2900);
  assert.equal((await ensureProviderPlan("pro")).created, false, "the same price reuses it");
  await Plan.updateOne({ key: "pro" }, { $set: { price: 39 } });
  const repriced = await ensureProviderPlan("pro");
  assert.equal(repriced.created, true);
  assert.equal(repriced.mapping.amountMinor, 3900);
});

test("the admin route needs a super admin and leaves an audit record", async () => {
  const { headers } = await setup();
  assert.equal((await callHandler(adminPlanPOST, req({ key: "pro", reason: "Setting up billing" }, headers))).status, 403);
  const admin = await createUser({ platformRole: "super_admin" });
  const adminHeaders = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  const res = await callHandler(adminPlanPOST, req({ key: "pro", reason: "Setting up billing" }, adminHeaders));
  assert.equal(res.status, 200);
  assert.equal(await AdminAuditLog.countDocuments({ action: "plan.provider_mapping", targetId: "pro" }), 1);
});

test("starting a checkout changes no access, and a second click reuses the page", async () => {
  const { id, headers, free } = await setup();
  await checkout(id, headers);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/subscriptions").length, 1);
  const again = await post(id, { planKey: "pro" }, headers);
  assert.match((await again.json()).checkoutUrl, /rzp\.io/);
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/subscriptions").length, 1, "one Razorpay subscription");
  const stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(String(stored?.plan), String(free._id));
  assert.equal(stored?.provider, "manual");
  assert.equal(await Payment.countDocuments({ business: id }), 0);
});

test("webhooks: a bad signature is refused, and a signed event alone grants nothing", async () => {
  const { id, headers, free } = await setup();
  const remote = await checkout(id, headers);
  assert.equal((await delivery("subscription.activated", remote.id, { signature: "0".repeat(64) })).status, 401);

  // Signed, but Razorpay says it has not been paid.
  const res = await delivery("subscription.activated", remote.id);
  assert.equal(res.status, 200);
  assert.equal(String((await Subscription.findOne({ business: id }).lean())?.plan), String(free._id));
  assert.equal((await getEntitlements(id)).planKey, "free");

  // A subscription SiteForge never created is ignored.
  const unknown = await delivery("subscription.activated", "sub_nobody");
  assert.equal((await unknown.json()).outcome, "unknown_subscription");
});

test("activation comes from Razorpay's own answer, with the payment recorded once", async () => {
  const { id, headers } = await setup();
  const remote = await activate(id, headers);
  const stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(stored?.status, "active");
  assert.equal(stored?.provider, "razorpay");
  assert.equal(stored?.providerSubscriptionId, remote.id);
  assert.equal(stored?.pendingCheckout ?? null, null);
  assert.equal((await getEntitlements(id)).planKey, "pro");
  const payment = await Payment.findOne({ business: id }).lean();
  assert.deepEqual([payment?.amount, payment?.status, payment?.providerPaymentId, payment?.paymentDomain], [29, "succeeded", "pay_first", "subscription"]);

  // The same event again, then concurrently: nothing changes.
  const eventId = "evt_repeat";
  assert.equal((await delivery("subscription.charged", remote.id, { paymentId: "pay_first", eventId })).status, 200);
  const repeats = await Promise.all([1, 2, 3].map(() => delivery("subscription.charged", remote.id, { paymentId: "pay_first", eventId })));
  assert.ok(repeats.every((res) => res.status === 200 || res.status === 502));
  assert.equal(await BillingEvent.countDocuments({ eventId }), 1);
  assert.equal(await Payment.countDocuments({ business: id, status: "succeeded" }), 1);
});

test("a charge for the wrong amount does not extend access", async () => {
  const { id, headers } = await setup();
  const remote = await checkout(id, headers);
  Object.assign(remote, { status: "active", paid_count: 1, current_start: periodStart(), current_end: periodEnd() });
  payments.set("pay_low", { id: "pay_low", amount: 100, currency: "USD", status: "captured", created_at: periodStart() });
  const res = await delivery("subscription.charged", remote.id, { paymentId: "pay_low" });
  assert.equal((await res.json()).outcome, "rejected");
  assert.equal((await getEntitlements(id)).planKey, "free");
});

test("failed renewals: one grace period, then access stops; a later charge restores it", async () => {
  const { id, headers } = await setup();
  const remote = await activate(id, headers);

  remote.status = "pending";
  payments.set("pay_fail", { id: "pay_fail", amount: 2900, currency: "USD", status: "failed", created_at: periodStart() });
  assert.equal((await delivery("subscription.pending", remote.id, { paymentId: "pay_fail" })).status, 200);
  let stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(stored?.status, "past_due");
  const grace = stored?.graceUntil?.getTime() ?? 0;
  assert.ok(grace > Date.now() + 2 * 24 * 3600 * 1000);
  let entitlements = await getEntitlements(id);
  assert.equal(entitlements.active, true, "access continues during the grace period");
  assert.ok(entitlements.graceUntil);
  assert.equal(await Payment.countDocuments({ business: id, status: "failed" }), 1);

  // A retry that also fails does not start a new grace period.
  assert.equal((await delivery("subscription.pending", remote.id)).status, 200);
  stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(stored?.graceUntil?.getTime(), grace);

  // Retries exhausted and the grace period over.
  remote.status = "halted";
  await delivery("subscription.halted", remote.id);
  await Subscription.updateOne({ business: id }, { $set: { graceUntil: new Date(Date.now() - 1000) } });
  entitlements = await getEntitlements(id);
  assert.equal(entitlements.active, false);
  assert.equal(entitlements.themes.length <= 3, true);

  // Paid again.
  Object.assign(remote, { status: "active", paid_count: 2, current_start: periodStart(), current_end: periodEnd() });
  payments.set("pay_back", { id: "pay_back", amount: 2900, currency: "USD", status: "captured", created_at: periodStart() });
  await delivery("subscription.charged", remote.id, { paymentId: "pay_back" });
  stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(stored?.status, "active");
  assert.equal(stored?.graceUntil ?? null, null);
  assert.equal((await getEntitlements(id)).active, true);
});

test("a read that fails is delivered again rather than lost", async () => {
  const { id, headers } = await setup();
  const remote = await checkout(id, headers);
  Object.assign(remote, { status: "active", paid_count: 1, current_start: periodStart(), current_end: periodEnd() });
  failReads = true;
  assert.equal((await delivery("subscription.charged", remote.id, { eventId: "evt_retry" })).status, 502);
  assert.equal(await BillingEvent.countDocuments({ eventId: "evt_retry" }), 0);
  failReads = false;
  assert.equal((await delivery("subscription.charged", remote.id, { eventId: "evt_retry" })).status, 200);
  assert.equal((await getEntitlements(id)).planKey, "pro");
});

test("cancelling waits for the end of the period, then access ends", async () => {
  const { id, headers } = await setup();
  const remote = await activate(id, headers);
  const res = await post(id, { action: "cancel" }, headers);
  assert.equal(res.status, 200);
  const call = calls.find((c) => c.path === `/subscriptions/${remote.id}/cancel`);
  assert.equal(call?.body.cancel_at_cycle_end, true);
  assert.equal((await Subscription.findOne({ business: id }).lean())?.cancelAtPeriodEnd, true);
  assert.equal((await getEntitlements(id)).active, true, "paid until the end of the period");
  assert.equal((await post(id, { action: "resume" }, headers)).status, 409);

  remote.status = "cancelled";
  await delivery("subscription.cancelled", remote.id);
  assert.equal((await Subscription.findOne({ business: id }).lean())?.status, "canceled");
  assert.equal((await getEntitlements(id)).active, false);
});

test("choosing a free plan moves over when the paid period ends", async () => {
  const { id, headers, free } = await setup();
  const remote = await activate(id, headers);
  const res = await post(id, { planKey: "free" }, headers);
  assert.equal((await res.json()).scheduledPlan, "free");
  assert.equal((await getEntitlements(id)).planKey, "pro");
  remote.status = "cancelled";
  await delivery("subscription.cancelled", remote.id);
  const stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(String(stored?.plan), String(free._id));
  assert.equal(stored?.status, "active");
  assert.equal(stored?.provider, "manual");
  assert.equal((await getEntitlements(id)).planKey, "free");
});

test("a paid plan change is scheduled for the cycle end", async () => {
  const { id, headers } = await setup();
  const remote = await activate(id, headers);
  await createPlan({ key: "max", price: 99 });
  await ensureProviderPlan("max");
  const res = await post(id, { planKey: "max" }, headers);
  assert.equal((await res.json()).scheduledPlan, "max");
  assert.equal(calls.find((c) => c.method === "PATCH" && c.path === `/subscriptions/${remote.id}`)?.body.schedule_change_at, "cycle_end");
  assert.equal((await getEntitlements(id)).planKey, "pro", "unchanged until then");
});

test("an unpaid page that expires leaves the current plan alone", async () => {
  const { id, headers, free } = await setup();
  const remote = await checkout(id, headers);
  remote.status = "expired";
  await delivery("subscription.cancelled", remote.id);
  const stored = await Subscription.findOne({ business: id }).lean();
  assert.equal(stored?.pendingCheckout ?? null, null);
  assert.equal(String(stored?.plan), String(free._id));
  assert.equal(stored?.status, "active");
});

test("invoices are owner-only, per store, and only pass on Razorpay's links", async () => {
  const { id, headers } = await setup();
  await activate(id, headers);
  const res = await callHandler(invoicesGET, new Request("http://localhost/x", { headers: headers as unknown as Record<string, string> }), ctx(id));
  const body = await res.json();
  assert.equal(body.invoices.length, 2);
  assert.equal(body.invoices[0].url, "https://rzp.io/i/inv1");
  assert.equal(body.invoices[1].url, null, "a link to anywhere else is dropped");

  const other = await setup().catch(() => null);
  void other;
});
