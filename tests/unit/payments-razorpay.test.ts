import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";

import {
  PaymentCredentialsKeyError,
  decryptCredential,
  encryptCredential,
  isPaymentCredentialsKeyConfigured,
} from "@/lib/payments/credentials-crypto";
import {
  RazorpayApiError,
  createPaymentLink,
  fetchPaymentLink,
  isTrustedPaymentLinkUrl,
  keyIdMatchesMode,
  toMinorUnits,
  verifyPaymentLinkCallbackSignature,
  verifyWebhookSignature,
} from "@/lib/payments/razorpay";

/** Mocked provider only: these tests never make a network request. */

const KEY = crypto.randomBytes(32).toString("base64");
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.PAYMENT_CREDENTIALS_KEY;
  process.env.PAYMENT_CREDENTIALS_KEY = KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.PAYMENT_CREDENTIALS_KEY;
  else process.env.PAYMENT_CREDENTIALS_KEY = savedKey;
});

test("credentials round-trip with AES-256-GCM, a fresh IV each time, and no plaintext in the record", () => {
  const a = encryptCredential("secret_value_123");
  const b = encryptCredential("secret_value_123");
  assert.equal(a.v, 1);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.ok(!JSON.stringify(a).includes("secret_value_123"));
  assert.equal(decryptCredential(a), "secret_value_123");
});

test("tampering, a wrong key or a missing key fails closed", () => {
  const record = encryptCredential("secret_value_123");
  const tampered = { ...record, ct: Buffer.from("x" + Buffer.from(record.ct, "base64").toString("latin1"), "latin1").toString("base64") };
  assert.throws(() => decryptCredential(tampered));
  assert.throws(() => decryptCredential({ ...record, tag: Buffer.alloc(16).toString("base64") }));

  process.env.PAYMENT_CREDENTIALS_KEY = crypto.randomBytes(32).toString("base64");
  assert.throws(() => decryptCredential(record));

  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(16).toString("base64");
  assert.equal(isPaymentCredentialsKeyConfigured(), false, "a 16-byte key is refused");
  assert.throws(() => encryptCredential("x"), PaymentCredentialsKeyError);
  delete process.env.PAYMENT_CREDENTIALS_KEY;
  assert.equal(isPaymentCredentialsKeyConfigured(), false);
  assert.throws(() => decryptCredential(record), PaymentCredentialsKeyError);
  assert.throws(() => decryptCredential({ ...record, v: 2 }), PaymentCredentialsKeyError);
});

test("callback signature: link_id|reference_id|status|payment_id, HMAC-SHA256 with the key secret", () => {
  const secret = "key_secret_abc";
  const params = { linkId: "plink_A1", referenceId: "ref1", status: "paid", paymentId: "pay_B2" };
  const signature = crypto.createHmac("sha256", secret).update("plink_A1|ref1|paid|pay_B2").digest("hex");
  assert.equal(verifyPaymentLinkCallbackSignature(secret, { ...params, signature }), true);
  assert.equal(verifyPaymentLinkCallbackSignature(secret, { ...params, signature: signature.toUpperCase() }), true);
  assert.equal(verifyPaymentLinkCallbackSignature("other", { ...params, signature }), false);
  assert.equal(verifyPaymentLinkCallbackSignature(secret, { ...params, status: "created", signature }), false);
  assert.equal(verifyPaymentLinkCallbackSignature(secret, { ...params, signature: "" }), false);
  assert.equal(verifyPaymentLinkCallbackSignature(secret, { ...params, signature: "zz" }), false);
});

test("webhook signature covers the exact raw body", () => {
  const body = JSON.stringify({ event: "payment_link.paid" });
  const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
  assert.equal(verifyWebhookSignature("whsec", body, signature), true);
  assert.equal(verifyWebhookSignature("whsec", body + " ", signature), false);
  assert.equal(verifyWebhookSignature("whsec", body, null), false);
  assert.equal(verifyWebhookSignature("other", body, signature), false);
});

test("amount conversion refuses fractional subunits, zero, negatives and non-finite values", () => {
  assert.equal(toMinorUnits(499.5), 49950);
  assert.equal(toMinorUnits(0.1 + 0.2), 30);
  assert.equal(toMinorUnits(10), 1000);
  assert.equal(toMinorUnits(10.005), null);
  assert.equal(toMinorUnits(0), null);
  assert.equal(toMinorUnits(-1), null);
  assert.equal(toMinorUnits(Number.NaN), null);
  assert.equal(toMinorUnits(Number.POSITIVE_INFINITY), null);
});

test("key ids must match the mode; only Razorpay-hosted HTTPS links are trusted", () => {
  assert.equal(keyIdMatchesMode("rzp_test_ABCdef123", "test"), true);
  assert.equal(keyIdMatchesMode("rzp_test_ABCdef123", "live"), false);
  assert.equal(keyIdMatchesMode("rzp_live_ABCdef123", "live"), true);
  assert.equal(keyIdMatchesMode("rzp_test_", "test"), false);
  assert.equal(keyIdMatchesMode("rzp_test_abc/../x", "test"), false);

  assert.equal(isTrustedPaymentLinkUrl("https://rzp.io/i/abc"), true);
  assert.equal(isTrustedPaymentLinkUrl("https://pages.razorpay.com/x"), true);
  assert.equal(isTrustedPaymentLinkUrl("http://rzp.io/i/abc"), false);
  assert.equal(isTrustedPaymentLinkUrl("https://rzp.io.evil.example/i/abc"), false);
  assert.equal(isTrustedPaymentLinkUrl("https://evilrazorpay.com/"), false);
  assert.equal(isTrustedPaymentLinkUrl("javascript:alert(1)"), false);
  assert.equal(isTrustedPaymentLinkUrl(42), false);
});

test("createPaymentLink sends basic auth and the documented body; errors never carry secrets", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const okFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ id: "plink_X", amount: 1000, amount_paid: 0, currency: "INR", status: "created", reference_id: "o1", short_url: "https://rzp.io/i/X" }),
      { status: 200 },
    );
  };
  const link = await createPaymentLink(
    { keyId: "rzp_test_K", keySecret: "very_secret" },
    {
      amountMinor: 1000,
      currency: "INR",
      referenceId: "o1",
      description: "Order #1",
      customer: { name: "Ada", email: "ada@example.com" },
      callbackUrl: "https://shop.example/api/storefront/payments/razorpay/return",
      expireBy: 2_000_000_000,
    },
    okFetch,
  );
  assert.equal(link.id, "plink_X");
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payment_links");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from("rzp_test_K:very_secret").toString("base64")}`);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(
    { amount: body.amount, currency: body.currency, accept_partial: body.accept_partial, reference_id: body.reference_id, callback_method: body.callback_method },
    { amount: 1000, currency: "INR", accept_partial: false, reference_id: "o1", callback_method: "get" },
  );
  assert.deepEqual(body.notify, { sms: false, email: false });

  const failing = async () =>
    new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "very_secret leaked?" } }), { status: 400 });
  await assert.rejects(
    () => fetchPaymentLink({ keyId: "rzp_test_K", keySecret: "very_secret" }, "plink_X", failing),
    (error: unknown) => {
      assert.ok(error instanceof RazorpayApiError);
      assert.equal(error.status, 400);
      assert.equal(error.providerCode, "BAD_REQUEST_ERROR");
      assert.ok(!error.message.includes("very_secret"));
      return true;
    },
  );
  await assert.rejects(
    () => fetchPaymentLink({ keyId: "k", keySecret: "s" }, "plink_X", async () => { throw new Error("ECONNRESET very_secret"); }),
    (error: unknown) => error instanceof RazorpayApiError && error.status === 0 && !error.message.includes("very_secret"),
  );
  await assert.rejects(
    () => fetchPaymentLink({ keyId: "k", keySecret: "s" }, "../payments", okFetch),
    RazorpayApiError,
    "path injection in the link id is refused before any request",
  );
});
