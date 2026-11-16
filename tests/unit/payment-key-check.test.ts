import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  KEY_CHECK_LABEL,
  decryptCredential,
  encryptCredential,
  encryptKeyCheck,
  paymentKeyFingerprint,
  verifyKeyCheck,
} from "../../backend/lib/payments/credentials-crypto";
import { USAGE, runPaymentKeyCheckCli } from "../../backend/lib/payments/key-check-cli";
import { PAYMENT_KEY_STATES, isBlockingPaymentKeyState } from "../../backend/lib/payments/key-check";

// Pure tests of the key-check primitives. Throwaway keys only, generated here and never printed.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const original = process.env.PAYMENT_CREDENTIALS_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.PAYMENT_CREDENTIALS_KEY;
  else process.env.PAYMENT_CREDENTIALS_KEY = original;
});

test("the fingerprint is the documented formula, ignores surrounding spaces, and is null without a key", () => {
  process.env.PAYMENT_CREDENTIALS_KEY = `  ${KEY_A} `;
  const expected = crypto.createHash("sha256").update("siteforge-payment-key-check:").update(Buffer.alloc(32, 1)).digest("hex").slice(0, 16);
  assert.equal(paymentKeyFingerprint(), expected);
  assert.match(expected, /^[0-9a-f]{16}$/);
  assert.ok(!KEY_A.includes(expected) && !expected.includes(KEY_A.slice(0, 8)), "the key cannot be read from it");
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_B;
  assert.notEqual(paymentKeyFingerprint(), expected);
  delete process.env.PAYMENT_CREDENTIALS_KEY;
  assert.equal(paymentKeyFingerprint(), null);
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(16).toString("base64");
  assert.equal(paymentKeyFingerprint(), null, "a 16-byte key is not a key");
});

test("a check value opens with its own key and is refused by any other", () => {
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_A;
  const check = encryptKeyCheck();
  assert.equal(check.v, 1);
  assert.ok(!JSON.stringify(check).includes(KEY_CHECK_LABEL), "the label is encrypted");
  assert.equal(verifyKeyCheck(check), "match");
  assert.notDeepEqual(encryptKeyCheck(), check, "a random IV every time");
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_B;
  assert.equal(verifyKeyCheck(check), "mismatch");
});

test("malformed check values are told apart from a wrong key", () => {
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_A;
  const check = encryptKeyCheck();
  const malformed: unknown[] = [
    null,
    "not an object",
    {},
    { ...check, v: 2 },
    { ...check, v: "1" },
    { ...check, iv: undefined },
    { ...check, iv: Buffer.alloc(8).toString("base64") },
    { ...check, tag: Buffer.alloc(4).toString("base64") },
    { ...check, ct: "" },
    { ...check, ct: "not base64 at all!" },
  ];
  for (const value of malformed) assert.equal(verifyKeyCheck(value), "malformed", JSON.stringify(value));

  // Authenticated with the right key and associated data, but not the label: not a check record.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.alloc(32, 1), iv);
  cipher.setAAD(Buffer.from("siteforge:payment-key-check:v1", "utf8"));
  const ct = Buffer.concat([cipher.update("something else", "utf8"), cipher.final()]);
  assert.equal(verifyKeyCheck({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") }), "malformed");
});

test("check values and credentials cannot stand in for each other, and credentials are unchanged", () => {
  process.env.PAYMENT_CREDENTIALS_KEY = KEY_A;
  const credential = encryptCredential("fake-test-secret");
  assert.equal(decryptCredential(credential), "fake-test-secret", "existing credential encryption still round-trips");
  assert.equal(verifyKeyCheck(credential), "mismatch", "a credential's ciphertext never passes as a check record");
  assert.throws(() => decryptCredential(encryptKeyCheck()), "a check value never decrypts as a credential");
});

test("blocking states are exactly mismatch, an unreadable record and an unknown database", () => {
  assert.deepEqual(PAYMENT_KEY_STATES.filter(isBlockingPaymentKeyState), ["mismatch", "check_unreadable", "unknown"]);
});

test("the operator command has exactly status and adopt: anything else is a usage error", async () => {
  const refused = [
    [],
    ["adopt"],
    ["adopt", "--expected-fingerprint"],
    ["adopt", "--authenticate-existing"],
    ["adopt", "--expected-fingerprint", "0123456789abcdef", "--authenticate-existing"],
    ["status", "--authenticate-existing"],
    ["authenticate-existing"],
    ["status", "extra"],
  ];
  for (const args of refused) {
    const lines: string[] = [];
    assert.equal(await runPaymentKeyCheckCli(args, (line) => lines.push(line)), 2, args.join(" "));
    assert.deepEqual(lines, [USAGE]);
  }
  assert.ok(!USAGE.includes("authenticate"));
});

test("no code path decrypts existing store secrets for the key check", () => {
  const root = path.resolve(__dirname, "..", "..");
  const files = [
    "backend/lib/payments/key-check.ts",
    "backend/lib/payments/key-check-cli.ts",
    "backend/scripts/payment-key-check.ts",
    "backend/models/PaymentKeyCheck.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(!/authenticate[-_]?existing/i.test(source), `${file} has no authenticate-existing mode`);
    assert.ok(!/decryptCredential/.test(source), `${file} never decrypts a store's credentials`);
  }
});
