import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as webhookPOST } from "@/app/api/webhooks/razorpay/[businessId]/route";
import { POST as notePOST } from "@/app/api/admin/disputes/[id]/notes/route";
import { GET as paymentsGET } from "@/app/api/admin/payments/route";
import { GET as manageListGET } from "@/app/api/businesses/[id]/manage/orders/route";
import { encryptCredential } from "@/lib/payments/credentials-crypto";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { PaymentDispute } from "@/models/PaymentDispute";

/**
 * Razorpay dispute tracking against a FAKE Razorpay API (global fetch replaced;
 * other URLs throw). Disputes come only from signed webhooks re-read from the
 * API, attach only to the same business's recorded payments, and never change
 * orders or payments.
 */

interface FakeDispute { id: string; payment_id: string; amount: number; amount_deducted: number; currency: string; reason_code: string; respond_by: number; status: string; phase: string; created_at: number; keyId: string }
const disputes = new Map<string, FakeDispute>();
let providerCalls = 0;
const realFetch = globalThis.fetch;

function fakeRazorpay(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected network request in test: ${url.origin}`);
  providerCalls += 1;
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const keyId = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":")[0];
  const match = url.pathname.match(/^\/v1\/disputes\/(disp_\w+)$/);
  const found = match ? disputes.get(match[1]) : undefined;
  if (!found || found.keyId !== keyId) return Promise.resolve(new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }), { status: 400 }));
  const { keyId: _k, ...entity } = found;
  return Promise.resolve(new Response(JSON.stringify(entity), { status: 200 }));
}

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
  delete process.env.PAYMENT_CREDENTIALS_KEY;
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  globalThis.fetch = fakeRazorpay as typeof fetch;
  process.env.PAYMENT_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
  disputes.clear();
  providerCalls = 0;
  clearRequestCookies();
  await clearAllCollections();
});

async function shop(webhookSecret = `whsec_${crypto.randomUUID()}`) {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const keyId = `rzp_test_${crypto.randomBytes(5).toString("hex")}`;
  await BusinessPaymentAccount.create({
    business: business._id, provider: "razorpay", mode: "test", status: "active", keyId,
    keySecretEnc: encryptCredential("key_secret_value"), webhookSecretEnc: encryptCredential(webhookSecret), connectedAt: new Date(),
  });
  const order = await Order.create({
    business: business._id, ownerToken: crypto.randomUUID(), customerName: "Shopper", customerEmail: "shopper@example.com",
    items: [{ product: String(new mongoose.Types.ObjectId()), productName: "Tea", quantity: 1, unitPrice: 499.5, currency: "INR" }],
    subtotal: 499.5, total: 499.5, currency: "INR", status: "paid", paymentMethod: "online", inventoryState: "consumed", paidAt: new Date(),
  });
  const paymentId = `pay_${crypto.randomBytes(6).toString("hex")}`;
  await OrderPayment.create({
    business: business._id, order: order._id, provider: "razorpay", mode: "test", providerLinkId: `plink_${crypto.randomBytes(6).toString("hex")}`,
    shortUrl: "https://rzp.io/i/x", providerPaymentId: paymentId, amountMinor: 49950, currency: "INR", status: "paid", orderOutcome: "applied", paidAt: new Date(),
  });
  return { owner, business, keyId, webhookSecret, order, paymentId };
}

function provider(id: string, s: { keyId: string; paymentId: string }, overrides: Partial<FakeDispute> = {}) {
  const dispute: FakeDispute = {
    id, payment_id: s.paymentId, amount: 49950, amount_deducted: 0, currency: "INR", reason_code: "chargeback_fraud",
    respond_by: Math.floor(Date.now() / 1000) + 7 * 86400, status: "open", phase: "chargeback", created_at: Math.floor(Date.now() / 1000), keyId: s.keyId, ...overrides,
  };
  disputes.set(id, dispute);
  return dispute;
}

function deliver(businessId: unknown, secret: string, disputeId: string, options: { event?: string; eventId?: string; payloadStatus?: string } = {}) {
  const id = String(businessId);
  const body = JSON.stringify({
    event: options.event ?? "payment.dispute.created",
    payload: { dispute: { entity: { id: disputeId, status: options.payloadStatus ?? "open" } } },
  });
  return callHandler(
    webhookPOST,
    new Request(`http://localhost/api/webhooks/razorpay/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": crypto.createHmac("sha256", secret).update(body).digest("hex"), "x-razorpay-event-id": options.eventId ?? `evt_${crypto.randomUUID()}` },
      body,
    }),
    { params: Promise.resolve({ businessId: id }) },
  ) as Promise<Response>;
}

async function outcome(res: Response) {
  return ((await res.json()) as { outcome?: string }).outcome;
}

test("a signed dispute webhook records the provider's dispute on the right business, order and payment", async () => {
  const s = await shop();
  provider("disp_A1", s);
  const res = await deliver(s.business._id, s.webhookSecret, "disp_A1", { eventId: "evt_1" });
  assert.equal(res.status, 200);
  assert.equal(await outcome(res), "created");

  const d = await PaymentDispute.findOne({ providerDisputeId: "disp_A1" }).lean();
  assert.ok(d);
  assert.equal(String(d.business), String(s.business._id));
  assert.equal(String(d.order), String(s.order._id));
  assert.equal(d.providerPaymentId, s.paymentId);
  assert.equal(d.status, "open");
  assert.equal(d.amountMinor, 49950);
  assert.ok(d.respondBy instanceof Date);
  assert.deepEqual(d.history.map((h) => [h.source, h.status, h.eventId]), [["provider", "open", "evt_1"]]);
  // A dispute never changes the order or the payment, and never records a refund.
  const order = await Order.findById(s.order._id).lean();
  assert.equal(order?.status, "paid");
  assert.equal(order?.refundedAt ?? null, null);
  assert.equal((await OrderPayment.findOne({ business: s.business._id }).lean())?.status, "paid");
});

test("bad signatures, unknown payments, other businesses' payments and amount mismatches store nothing", async () => {
  const a = await shop();
  const b = await shop("other_business_secret");
  provider("disp_X1", a);

  assert.equal((await deliver(a.business._id, "wrong-secret", "disp_X1")).status, 401);
  assert.equal(providerCalls, 0, "nothing is fetched before the signature is verified");

  provider("disp_X2", a, { payment_id: "pay_unknown123" });
  assert.equal(await outcome(await deliver(a.business._id, a.webhookSecret, "disp_X2")), "unknown_payment");

  // B's own Razorpay account reports a dispute naming A's payment id: not B's payment.
  provider("disp_X3", { keyId: b.keyId, paymentId: a.paymentId });
  assert.equal(await outcome(await deliver(b.business._id, b.webhookSecret, "disp_X3")), "unknown_payment");

  // B cannot read A's dispute with its own key (provider refuses -> 502, retried later).
  assert.equal((await deliver(b.business._id, b.webhookSecret, "disp_X1")).status, 502);

  provider("disp_X4", a, { amount: 99999999 });
  assert.equal(await outcome(await deliver(a.business._id, a.webhookSecret, "disp_X4")), "mismatch");
  provider("disp_X5", a, { currency: "USD" });
  assert.equal(await outcome(await deliver(a.business._id, a.webhookSecret, "disp_X5")), "mismatch");

  assert.equal(await PaymentDispute.countDocuments(), 0);
});

test("status comes from the provider API, transitions are recorded once, duplicates are ignored", async () => {
  const s = await shop();
  provider("disp_B1", s);
  // The payload claims "won"; the API says "open": the API wins.
  assert.equal(await outcome(await deliver(s.business._id, s.webhookSecret, "disp_B1", { eventId: "evt_a", payloadStatus: "won" })), "created");
  assert.equal((await PaymentDispute.findOne().lean())?.status, "open");

  const dup = await Promise.all([1, 2, 3].map(() => deliver(s.business._id, s.webhookSecret, "disp_B1", { eventId: "evt_a" })));
  for (const r of dup) assert.equal(await outcome(r), "unchanged");

  disputes.get("disp_B1")!.status = "under_review";
  const concurrent = await Promise.all([1, 2, 3].map((i) => deliver(s.business._id, s.webhookSecret, "disp_B1", { event: "payment.dispute.under_review", eventId: `evt_b${i}` })));
  const outcomes = await Promise.all(concurrent.map(outcome));
  assert.equal(outcomes.filter((o) => o === "updated").length, 1, JSON.stringify(outcomes));

  Object.assign(disputes.get("disp_B1")!, { status: "lost", amount_deducted: 49950 });
  assert.equal(await outcome(await deliver(s.business._id, s.webhookSecret, "disp_B1", { event: "payment.dispute.lost", eventId: "evt_c" })), "updated");

  const d = await PaymentDispute.findOne().lean();
  assert.equal(await PaymentDispute.countDocuments(), 1);
  assert.deepEqual(d?.history.map((h) => h.status), ["open", "under_review", "lost"]);
  assert.equal(d?.amountDeductedMinor, 49950);
  assert.ok(d?.closedAt instanceof Date);
  assert.equal((await Order.findById(s.order._id).lean())?.status, "paid", "the order is not changed by a lost dispute");
});

test("concurrent first deliveries create exactly one dispute", async () => {
  const s = await shop();
  provider("disp_C1", s);
  const results = await Promise.all([1, 2, 3, 4].map((i) => deliver(s.business._id, s.webhookSecret, "disp_C1", { eventId: `evt_${i}` })));
  const outcomes = await Promise.all(results.map(outcome));
  assert.equal(outcomes.filter((o) => o === "created").length, 1, JSON.stringify(outcomes));
  assert.equal(await PaymentDispute.countDocuments(), 1);
  assert.equal((await PaymentDispute.findOne().lean())?.history.length, 1);
});

test("only super admins add internal notes; notes are audited and never change the status", async () => {
  const s = await shop();
  provider("disp_D1", s);
  await deliver(s.business._id, s.webhookSecret, "disp_D1");
  const dispute = await PaymentDispute.findOne().lean();
  const id = String(dispute!._id);
  const admin = await createUser({ platformRole: "super_admin" });
  const adminHeaders = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  const ownerHeaders = await createAuthHeadersForUser(String(s.owner._id), "user", s.owner.tokenVersion);
  const note = (headers: { cookie: string } | undefined, body: unknown, target = id) =>
    callHandler(notePOST, new Request(`http://localhost/api/admin/disputes/${target}/notes`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(headers ?? {}) }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: target }) }) as Promise<Response>;

  assert.equal((await note(undefined, { note: "Customer emailed us" })).status, 401);
  assert.equal((await note(ownerHeaders, { note: "Customer emailed us" })).status, 403);
  assert.equal((await note(adminHeaders, { note: "hi" })).status, 422);
  assert.equal((await note(adminHeaders, { note: "Valid note", status: "won" })).status, 422, "no other fields");
  assert.equal((await note(adminHeaders, { note: "Valid note" }, String(new mongoose.Types.ObjectId()))).status, 404);
  assert.equal((await note(adminHeaders, { note: "Business uploaded delivery proof in Razorpay." })).status, 200);

  const after = await PaymentDispute.findById(id).lean();
  assert.equal(after?.status, "open");
  assert.deepEqual(after?.history.map((h) => h.source), ["provider", "admin"]);
  assert.equal(String(after?.history[1].actor), String(admin._id));
  const audit = await AdminAuditLog.find({ action: "dispute.note" }).lean();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].targetId, id);
});

test("disputes appear in the admin list and on the owner's own orders only", async () => {
  const a = await shop();
  const b = await shop();
  provider("disp_E1", a);
  await deliver(a.business._id, a.webhookSecret, "disp_E1");

  const admin = await createUser({ platformRole: "super_admin" });
  const adminHeaders = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  const list = await (await callHandler(paymentsGET, new Request("http://localhost/api/admin/payments?domain=dispute&status=open_any", { headers: { ...adminHeaders } })) as Response).json();
  assert.equal(list.total, 1);
  assert.equal(list.records[0].reference, "disp_E1");
  assert.ok(!JSON.stringify(list).includes("shopper@example.com"));

  const ownerOrders = async (shopData: typeof a) => {
    const id = String(shopData.business._id);
    const headers = await createAuthHeadersForUser(String(shopData.owner._id), "user", shopData.owner.tokenVersion);
    const res = (await callHandler(manageListGET, new Request(`http://localhost/api/businesses/${id}/manage/orders`, { headers: { ...headers } }), { params: Promise.resolve({ id }) })) as Response;
    return ((await res.json()) as { orders: Array<{ dispute: { status: string } | null }> }).orders;
  };
  assert.equal((await ownerOrders(a))[0].dispute?.status, "open");
  assert.equal((await ownerOrders(b))[0].dispute, null);
});
