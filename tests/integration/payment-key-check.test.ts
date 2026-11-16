import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { freshIp, store } from "./helpers/customer-accounts";
import { PUT as accountPUT } from "@/app/api/businesses/[id]/payment-account/route";
import { GET as returnGET } from "@/app/api/storefront/payments/razorpay/return/route";
import { POST as webhookPOST } from "@/app/api/webhooks/razorpay/[businessId]/route";
import { encryptCredential, paymentKeyFingerprint } from "@/lib/payments/credentials-crypto";
import { assertPaymentKeyForEncryption, checkPaymentKey, resetPaymentKeyCheckCache, PAYMENT_KEY_RECHECK_MS } from "@/lib/payments/key-check";
import { runPaymentKeyCheckCli } from "@/lib/payments/key-check-cli";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { createOrderRefund, refreshOrderRefund } from "@/lib/payments/order-refunds";
import { syncDisputeFromProvider } from "@/lib/payments/disputes";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { OrderRefund } from "@/models/OrderRefund";
import { PAYMENT_KEY_CHECK_ID, PaymentKeyCheck } from "@/models/PaymentKeyCheck";
import { Product } from "@/models/Product";

/**
 * The payment-key check (lib/payments/key-check.ts) against an in-memory replica set and a FAKE
 * Razorpay: global fetch is replaced and counts every call, so no request leaves the process.
 * Every key here is a throwaway generated for this file; no store secret is real.
 */

const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const KEY_SECRET = "fake_key_secret_for_tests_1";
const WEBHOOK_SECRET = "fake_webhook_secret_for_tests_1";
const ENV_KEYS = ["ORDER_ONLINE_PAYMENTS_ENABLED", "ORDER_PAYMENTS_LIVE_ALLOWED", "PAYMENT_CREDENTIALS_KEY"];

const realFetch = globalThis.fetch;
let providerCalls = 0;
async function fakeRazorpay(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.razorpay.com") throw new Error(`Unexpected network request in test: ${url.origin}`);
  providerCalls += 1;
  return new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR" } }), { status: 400 });
}
const countingFetch = async (url: string) => fakeRazorpay(url);

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
  resetPaymentKeyCheckCache();
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  globalThis.fetch = fakeRazorpay as typeof fetch;
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ORDER_ONLINE_PAYMENTS_ENABLED = "true";
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_A;
  providerCalls = 0;
  clearRequestCookies();
  await clearAllCollections();
  resetPaymentKeyCheckCache();
});

const useKey = (key: string) => {
  process.env.PAYMENT_CREDENTIALS_KEY = key;
};
const fingerprintOf = (key: string) => {
  const saved = process.env.PAYMENT_CREDENTIALS_KEY;
  process.env.PAYMENT_CREDENTIALS_KEY = key;
  const value = paymentKeyFingerprint();
  process.env.PAYMENT_CREDENTIALS_KEY = saved;
  return value as string;
};
const rawAccount = (businessId: unknown) => BusinessPaymentAccount.collection.findOne({ business: businessId });
const rawCheck = () => PaymentKeyCheck.collection.findOne({ _id: PAYMENT_KEY_CHECK_ID as never });

async function connect(shop: { business: { _id: unknown }; owner: { _id: unknown; tokenVersion: number } }) {
  const id = String(shop.business._id);
  const headers = await createAuthHeadersForUser(String(shop.owner._id), "user", shop.owner.tokenVersion);
  const res = (await callHandler(
    accountPUT,
    new Request(`http://localhost/api/businesses/${id}/payment-account`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", host: "localhost", ...headers },
      body: JSON.stringify({ mode: "test", keyId: `rzp_test_${crypto.randomBytes(6).toString("hex")}`, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET }),
    }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** An account written straight to the database, as an installation from before the check had. */
async function legacyAccount(businessId: unknown) {
  await BusinessPaymentAccount.create({
    business: businessId, provider: "razorpay", mode: "test", status: "active", keyId: "rzp_test_legacy1",
    keySecretEnc: encryptCredential(KEY_SECRET), webhookSecretEnc: encryptCredential(WEBHOOK_SECRET), connectedAt: new Date(),
  });
}

function webhook(businessId: unknown, payload: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const id = String(businessId);
  const body = JSON.stringify(payload);
  return callHandler(
    webhookPOST,
    new Request(`http://localhost/api/webhooks/razorpay/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": crypto.createHmac("sha256", secret).update(body).digest("hex"), "x-razorpay-event-id": `evt_${crypto.randomUUID()}` },
      body,
    }),
    { params: Promise.resolve({ businessId: id }) },
  ) as Promise<Response>;
}
const linkEvent = { event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_unknown1" } } } };

async function paidOnlineOrder(businessId: unknown) {
  const product = await Product.create({ business: businessId, name: "Mug", slug: `mug-${crypto.randomUUID().slice(0, 8)}`, price: 100, stock: 3, status: "active", currency: "INR" });
  const order = await Order.create({
    business: businessId, ownerToken: `t-${crypto.randomUUID()}`, customerName: "Ada", customerEmail: "ada@example.test",
    items: [{ product: String(product._id), productName: "Mug", quantity: 1, unitPrice: 100, currency: "INR" }],
    subtotal: 100, total: 100, status: "paid", currency: "INR", inventoryState: "consumed", paidAt: new Date(), paymentMethod: "online",
  });
  await OrderPayment.create({
    business: businessId, order: order._id, provider: "razorpay", mode: "test", providerLinkId: `plink_${crypto.randomBytes(5).toString("hex")}`,
    shortUrl: "https://rzp.io/x", providerPaymentId: "pay_abc123", amountMinor: 10000, currency: "INR", status: "paid", orderOutcome: "applied", paidAt: new Date(),
  });
  return order;
}

/** Bootstraps with KEY_A, then switches the server to KEY_B: a well-formed but wrong key. */
async function connectedStoreThenWrongKey() {
  const shop = await store();
  assert.equal((await connect(shop)).status, 200);
  useKey(KEY_B);
  return shop;
}

// ---------------------------------------------------------------------------
// Bootstrap and verification
// ---------------------------------------------------------------------------

test("the first connection with no stored secrets creates the check record; later ones verify against it", async () => {
  assert.equal((await checkPaymentKey()).state, "no_check_no_data");
  const first = await store();
  assert.equal((await connect(first)).status, 200);

  const record = await rawCheck();
  assert.ok(record);
  assert.equal(record.createdBy, "bootstrap");
  assert.equal(record.existingEncryptedRecordsAtCreation, 0);
  assert.equal(record.keyFingerprint, fingerprintOf(KEY_A));
  const stored = JSON.stringify(record);
  assert.ok(!stored.includes(KEY_SECRET) && !stored.includes(WEBHOOK_SECRET) && !stored.includes(KEY_A), "no secret in the record");

  const second = await store();
  assert.equal((await connect(second)).status, 200, "the same key verifies");
  assert.equal(await PaymentKeyCheck.countDocuments({}), 1);
  assert.deepEqual(await rawCheck(), record, "never replaced");
  const status = await checkPaymentKey({ fresh: true });
  assert.deepEqual(status, { state: "verified", configuredFingerprint: fingerprintOf(KEY_A), expectedFingerprint: fingerprintOf(KEY_A) });
});

test("the record cannot be updated or replaced through the model", async () => {
  assert.equal((await connect(await store())).status, 200);
  await assert.rejects(PaymentKeyCheck.updateOne({ _id: PAYMENT_KEY_CHECK_ID }, { $set: { keyFingerprint: "0000000000000000" } }), /cannot be changed/);
  await assert.rejects(PaymentKeyCheck.findOneAndUpdate({ _id: PAYMENT_KEY_CHECK_ID }, { $set: { createdBy: "adoption" } }), /cannot be changed/);
  await assert.rejects(PaymentKeyCheck.replaceOne({ _id: PAYMENT_KEY_CHECK_ID }, { keyVersion: 1 }), /cannot be changed/);
  const doc = await PaymentKeyCheck.findById(PAYMENT_KEY_CHECK_ID);
  assert.ok(doc);
  doc.keyFingerprint = "0000000000000000";
  await assert.rejects(doc.save(), /cannot be changed/);
  assert.equal((await rawCheck())?.keyFingerprint, fingerprintOf(KEY_A));
});

// ---------------------------------------------------------------------------
// A different key
// ---------------------------------------------------------------------------

test("a different key is detected, and a reconnect leaves the stored account untouched", async () => {
  const shop = await connectedStoreThenWrongKey();
  const before = await rawAccount(shop.business._id);
  const status = await checkPaymentKey();
  assert.equal(status.state, "mismatch");
  assert.equal(status.configuredFingerprint, fingerprintOf(KEY_B));
  assert.equal(status.expectedFingerprint, fingerprintOf(KEY_A));

  const res = await connect(shop);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "payment_key_unavailable");
  assert.ok(!JSON.stringify(res.body).includes("mismatch"), "owners are not told the diagnosis");
  assert.deepEqual(await rawAccount(shop.business._id), before, "not re-encrypted under the wrong key");
  assert.equal(await isOnlinePaymentAvailable(shop.business._id), false, "checkout stops offering online payment");
  assert.equal(providerCalls, 0);
});

test("restoring the original key resumes everything at once", async () => {
  const shop = await connectedStoreThenWrongKey();
  assert.equal((await checkPaymentKey()).state, "mismatch");
  assert.equal((await webhook(shop.business._id, linkEvent)).status, 503);
  useKey(KEY_A);
  assert.equal((await checkPaymentKey()).state, "verified", "a different key is checked again immediately");
  assert.equal(await isOnlinePaymentAvailable(shop.business._id), true);
  assert.equal((await webhook(shop.business._id, linkEvent)).status, 200, "signed events are accepted again");
  assert.equal((await connect(shop)).status, 200);
});

test("a malformed record fails closed and is never overwritten", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  await PaymentKeyCheck.collection.insertOne({ _id: PAYMENT_KEY_CHECK_ID as never, keyVersion: 1, check: { v: 1, iv: "short", tag: "x", ct: "" }, keyFingerprint: fingerprintOf(KEY_A), createdBy: "bootstrap", existingEncryptedRecordsAtCreation: 0 });
  const before = await rawCheck();
  const accountBefore = await rawAccount(shop.business._id);

  assert.equal((await checkPaymentKey()).state, "check_unreadable");
  assert.equal((await connect(shop)).status, 503);
  assert.equal(await isOnlinePaymentAvailable(shop.business._id), false);
  assert.equal((await webhook(shop.business._id, linkEvent)).status, 503);
  assert.deepEqual(await rawCheck(), before, "the record is left for investigation");
  assert.deepEqual(await rawAccount(shop.business._id), accountBefore);

  await PaymentKeyCheck.collection.deleteMany({});
  await PaymentKeyCheck.collection.insertOne({ _id: PAYMENT_KEY_CHECK_ID as never, keyVersion: 2, check: {}, keyFingerprint: "nope", createdBy: "bootstrap", existingEncryptedRecordsAtCreation: 0 });
  resetPaymentKeyCheckCache();
  const unknownVersion = await checkPaymentKey();
  assert.equal(unknownVersion.state, "check_unreadable");
  assert.equal(unknownVersion.expectedFingerprint, null, "a malformed fingerprint is not shown");
});

// ---------------------------------------------------------------------------
// The database cannot be read
// ---------------------------------------------------------------------------

test("a database read failure is unknown, never a mismatch: nothing is written or cached", async () => {
  const shop = await store();
  const failing = mock.method(PaymentKeyCheck, "findById", () => ({ lean: () => Promise.reject(Object.assign(new Error("connection lost"), { name: "MongoNetworkError" })) }));
  const warnings = mock.method(console, "warn", () => undefined);
  try {
    assert.equal((await checkPaymentKey()).state, "unknown");
    assert.equal((await checkPaymentKey()).state, "unknown");
    assert.equal(failing.mock.callCount(), 2, "unknown is never cached");

    const res = await connect(shop);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "payment_key_unavailable");
    assert.equal((await webhook(shop.business._id, linkEvent)).status, 503);
    const logged = warnings.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(logged.some((line) => line.includes("payment_key_check_unavailable")));
    assert.ok(!logged.some((line) => line.includes("payment_key_mismatch") || line.includes("connection lost")));
  } finally {
    failing.mock.restore();
    warnings.mock.restore();
  }
  assert.equal(await PaymentKeyCheck.countDocuments({}), 0, "no record was created during the outage");
  assert.equal(await BusinessPaymentAccount.countDocuments({}), 0);
  assert.equal((await checkPaymentKey()).state, "no_check_no_data", "the next check reads again");
});

test("verified is cached for the same key; a mismatch is checked again after a minute", async () => {
  await connectedStoreThenWrongKey();
  const reads = mock.method(PaymentKeyCheck, "findById");
  const clock = mock.method(Date, "now");
  const start = Date.now();
  try {
    clock.mock.mockImplementation(() => start);
    assert.equal((await checkPaymentKey()).state, "mismatch");
    assert.equal((await checkPaymentKey()).state, "mismatch");
    assert.equal(reads.mock.callCount(), 1, "mismatch cached");
    clock.mock.mockImplementation(() => start + PAYMENT_KEY_RECHECK_MS + 1);
    await checkPaymentKey();
    assert.equal(reads.mock.callCount(), 2, "checked again after the minute");

    useKey(KEY_A);
    assert.equal((await checkPaymentKey()).state, "verified");
    clock.mock.mockImplementation(() => start + 10 * PAYMENT_KEY_RECHECK_MS);
    assert.equal((await checkPaymentKey()).state, "verified");
    assert.equal(reads.mock.callCount(), 3, "verified cached for this key");
  } finally {
    reads.mock.restore();
    clock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Stored secrets without a record (an installation from before the check)
// ---------------------------------------------------------------------------

test("legacy secrets without a record keep working, warn, and block reconnection without adopting", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const before = await rawAccount(shop.business._id);

  assert.equal((await checkPaymentKey()).state, "unverified_legacy");
  assert.equal(await isOnlinePaymentAvailable(shop.business._id), true, "existing payments keep working");
  const res = await connect(shop);
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "payment_key_unavailable");
  assert.deepEqual(await rawAccount(shop.business._id), before, "never re-encrypted while unverified");
  assert.equal(await PaymentKeyCheck.countDocuments({}), 0, "the key is never adopted silently");

  // A store connecting for the first time is refused too: no new secret under an unproven key.
  const other = await store();
  assert.equal((await connect(other)).status, 503);
  assert.equal(await rawAccount(other.business._id), null);
});

// ---------------------------------------------------------------------------
// Two instances bootstrapping at once
// ---------------------------------------------------------------------------

test("concurrent bootstraps with the same key create one record, and both succeed", async () => {
  await Promise.all([assertPaymentKeyForEncryption(), assertPaymentKeyForEncryption(), assertPaymentKeyForEncryption()]);
  assert.equal(await PaymentKeyCheck.countDocuments({}), 1);
  assert.equal((await checkPaymentKey({ fresh: true })).state, "verified");
});

test("a second instance with a different key loses the race and refuses, leaving the first record", async () => {
  // Instance A (KEY_A) creates the record first.
  await assertPaymentKeyForEncryption();
  const recordA = await rawCheck();

  // Instance B (KEY_B) had read "no record, no data" just before: its insert collides.
  useKey(KEY_B);
  resetPaymentKeyCheckCache();
  const realFindById = PaymentKeyCheck.findById.bind(PaymentKeyCheck);
  let staleReads = 1;
  const stale = mock.method(PaymentKeyCheck, "findById", (...args: Parameters<typeof PaymentKeyCheck.findById>) => {
    if (staleReads-- > 0) return { lean: async () => null };
    return realFindById(...args);
  });
  try {
    await assert.rejects(assertPaymentKeyForEncryption(), (error: { status?: number; code?: string }) => error.status === 503 && error.code === "payment_key_unavailable");
  } finally {
    stale.mock.restore();
  }
  assert.equal(await PaymentKeyCheck.countDocuments({}), 1);
  assert.deepEqual(await rawCheck(), recordA, "the first record stands");
  assert.equal((await checkPaymentKey({ fresh: true })).state, "mismatch");
});

// ---------------------------------------------------------------------------
// Refunds, webhooks, disputes and the return route
// ---------------------------------------------------------------------------

test("a Razorpay refund under a wrong key is refused before any hold, record or request", async () => {
  const shop = await connectedStoreThenWrongKey();
  const id = String(shop.business._id);
  const order = await paidOnlineOrder(id);
  const fetched: string[] = [];
  const impl = async (url: string) => {
    fetched.push(url);
    return countingFetch(url);
  };

  await assert.rejects(
    createOrderRefund({ businessId: id, orderId: String(order._id), method: "razorpay", actorId: shop.owner._id, fetchImpl: impl }),
    (error: { status?: number; code?: string }) => error.status === 503 && error.code === "payment_key_unavailable",
  );
  const after = await Order.findById(order._id).lean();
  assert.equal(Number(after?.refundHoldTotal ?? 0), 0, "no amount held");
  assert.equal(Number(after?.refundedTotal ?? 0), 0);
  assert.equal(await OrderRefund.countDocuments({}), 0, "no refund record");
  assert.equal(fetched.length, 0, "Razorpay was not called");
});

test("checking an existing pending refund under a wrong key changes nothing", async () => {
  const shop = await store();
  const id = String(shop.business._id);
  assert.equal((await connect(shop)).status, 200);
  const order = await paidOnlineOrder(id);
  const pending = await OrderRefund.create({
    business: id, order: order._id, provider: "razorpay", mode: "test", providerPaymentId: "pay_abc123", providerRefundId: "rfnd_abc123",
    idempotencyKey: crypto.randomUUID(), amount: 100, amountMinor: 10000, currency: "INR", status: "pending", reason: "", restock: false, createdBy: shop.owner._id,
  });
  const before = await OrderRefund.collection.findOne({ _id: pending._id });
  useKey(KEY_B);
  const fetched: string[] = [];
  await assert.rejects(
    refreshOrderRefund({ businessId: id, refundId: String(pending._id), fetchImpl: async (url: string) => { fetched.push(url); return countingFetch(url); } }),
    (error: { status?: number }) => error.status === 503,
  );
  assert.deepEqual(await OrderRefund.collection.findOne({ _id: pending._id }), before);
  assert.equal(fetched.length, 0);
});

test("webhooks answer a temporary 503 during a mismatch, the same for every business", async () => {
  const shop = await connectedStoreThenWrongKey();
  const responses = [
    await webhook(shop.business._id, linkEvent),
    await webhook(shop.business._id, linkEvent, "a-wrong-signature-secret"),
    await webhook(crypto.randomBytes(12).toString("hex"), linkEvent),
    await webhook(shop.business._id, { event: "payment.dispute.created", payload: { dispute: { entity: { id: "disp_abc123" } } } }),
    await webhook(shop.business._id, { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_abc123" } } } }),
  ];
  const bodies = await Promise.all(responses.map(async (res) => ({ status: res.status, retry: res.headers.get("retry-after"), body: await res.text() })));
  for (const body of bodies) {
    assert.equal(body.status, 503, "temporary, so Razorpay delivers again; never reported as a bad signature");
    assert.equal(body.retry, "300");
    assert.equal(body.body, bodies[0].body, "identical: no business is told apart");
    assert.ok(!body.body.includes("invalid_signature"));
  }
  assert.equal(providerCalls, 0);
});

test("dispute re-reads fail safely under a wrong key", async () => {
  const shop = await connectedStoreThenWrongKey();
  const fetched: string[] = [];
  await assert.rejects(
    syncDisputeFromProvider({ businessId: String(shop.business._id), disputeId: "disp_abc123", fetchImpl: async (url: string) => { fetched.push(url); return countingFetch(url); } }),
    (error: { status?: number }) => error.status === 503,
  );
  assert.equal(fetched.length, 0);
});

test("the return route shows pending under a wrong key and decrypts nothing", async () => {
  const shop = await store();
  assert.equal((await connect(shop)).status, 200);
  const order = await paidOnlineOrder(shop.business._id);
  const payment = await OrderPayment.findOne({ order: order._id }).lean();
  assert.ok(payment);
  useKey(KEY_B);
  const res = await returnGET(
    new Request(`http://${shop.host}/api/storefront/payments/razorpay/return?${new URLSearchParams({
      razorpay_payment_id: "pay_abc123",
      razorpay_payment_link_id: payment.providerLinkId,
      razorpay_payment_link_reference_id: String(order._id),
      razorpay_payment_link_status: "paid",
      razorpay_signature: crypto.createHmac("sha256", KEY_SECRET).update(`${payment.providerLinkId}|${order._id}|paid|pay_abc123`).digest("hex"),
    })}`, { headers: { host: shop.host, "x-forwarded-for": freshIp() } }),
  );
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location") ?? "", /payment=pending/);
  assert.equal(providerCalls, 0);
});

// ---------------------------------------------------------------------------
// The operator command
// ---------------------------------------------------------------------------

async function cli(...args: string[]) {
  const lines: string[] = [];
  const code = await runPaymentKeyCheckCli(args, (line) => lines.push(line));
  return { code, text: lines.join("\n") };
}

async function assertNoSecrets(text: string) {
  const forbidden = [KEY_A, KEY_B, KEY_SECRET, WEBHOOK_SECRET, "keySecretEnc", "webhookSecretEnc"];
  for (const account of await BusinessPaymentAccount.collection.find({}).toArray()) {
    for (const field of ["keySecretEnc", "webhookSecretEnc"] as const) {
      const value = account[field] as { iv?: string; tag?: string; ct?: string } | undefined;
      if (value) forbidden.push(value.iv ?? "", value.tag ?? "", value.ct ?? "");
    }
  }
  const check = await rawCheck();
  if (check?.check) forbidden.push(check.check.iv, check.check.tag, check.check.ct);
  for (const value of forbidden.filter(Boolean)) assert.ok(!text.includes(value), "the command printed a secret or ciphertext");
}

test("status prints only the state, fingerprints and a count", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const { code, text } = await cli("status");
  assert.equal(code, 1, "not verified yet");
  assert.match(text, /state: unverified_legacy/);
  assert.match(text, new RegExp(`configured key fingerprint: ${fingerprintOf(KEY_A)}`));
  assert.match(text, /encrypted payment accounts: 1/);
  await assertNoSecrets(text);
  assert.equal(await PaymentKeyCheck.countDocuments({}), 0, "status writes nothing");
});

test("adoption refuses a wrong or malformed escrow fingerprint and writes nothing", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const wrong = await cli("adopt", "--expected-fingerprint", fingerprintOf(KEY_B));
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /differs from the escrow fingerprint/);
  for (const malformed of ["", "123", "zzzzzzzzzzzzzzzz", `${fingerprintOf(KEY_A)}00`]) {
    const res = await cli("adopt", "--expected-fingerprint", malformed);
    assert.equal(res.code, 1, malformed);
    assert.match(res.text, /must be the 16 hex characters/);
  }
  await assertNoSecrets(wrong.text);
  assert.equal(await PaymentKeyCheck.countDocuments({}), 0);
});

test("adoption with the escrow fingerprint creates the record once, and refuses an existing one", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const adopted = await cli("adopt", "--expected-fingerprint", fingerprintOf(KEY_A).toUpperCase());
  assert.equal(adopted.code, 0, adopted.text);
  assert.match(adopted.text, /Adopted/);
  assert.match(adopted.text, /state: verified/);
  await assertNoSecrets(adopted.text);
  const record = await rawCheck();
  assert.equal(record?.createdBy, "adoption");
  assert.equal(record?.existingEncryptedRecordsAtCreation, 1);
  assert.equal((await checkPaymentKey()).state, "verified");
  assert.equal((await connect(shop)).status, 200, "reconnection works once adopted");

  const again = await cli("adopt", "--expected-fingerprint", fingerprintOf(KEY_A));
  assert.equal(again.code, 1);
  assert.match(again.text, /already exists/);
  assert.deepEqual(await rawCheck(), record, "never replaced");
});

test("concurrent adoptions create exactly one record", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const results = await Promise.all([1, 2, 3].map(() => cli("adopt", "--expected-fingerprint", fingerprintOf(KEY_A))));
  assert.equal(results.filter((r) => r.code === 0).length, 1, results.map((r) => r.text).join("\n---\n"));
  assert.equal(await PaymentKeyCheck.countDocuments({}), 1);
});

test("adoption refuses while the database cannot be read", async () => {
  const shop = await store();
  await legacyAccount(shop.business._id);
  const failing = mock.method(PaymentKeyCheck, "findById", () => ({ lean: () => Promise.reject(new Error("connection lost")) }));
  const warnings = mock.method(console, "warn", () => undefined);
  let result: Awaited<ReturnType<typeof cli>>;
  try {
    result = await cli("adopt", "--expected-fingerprint", fingerprintOf(KEY_A));
  } finally {
    failing.mock.restore();
    warnings.mock.restore();
  }
  assert.equal(result.code, 1);
  assert.match(result.text, /could not be read/);
  assert.equal(await PaymentKeyCheck.countDocuments({}), 0);
});
