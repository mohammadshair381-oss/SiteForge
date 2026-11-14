import crypto from "node:crypto";

/**
 * Encryption at rest for per-business payment-provider secrets (server-only).
 *
 * AES-256-GCM with a random 96-bit IV per value. The key-encryption key comes
 * from `PAYMENT_CREDENTIALS_KEY` (32 random bytes, base64), which is
 * deliberately NOT derived from SESSION_SECRET. Values carry a key version so
 * the key can be rotated (decrypt with the recorded version, re-encrypt with
 * the current one); only version 1 exists today.
 *
 * Never log, serialise or return a decrypted value.
 */

export interface EncryptedValue {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

export class PaymentCredentialsKeyError extends Error {
  constructor() {
    super("PAYMENT_CREDENTIALS_KEY is missing or invalid (expected 32 bytes, base64)");
    this.name = "PaymentCredentialsKeyError";
  }
}

const CURRENT_VERSION = 1;

function keyFor(version: number): Buffer {
  if (version !== CURRENT_VERSION) throw new PaymentCredentialsKeyError();
  const raw = process.env.PAYMENT_CREDENTIALS_KEY?.trim();
  if (!raw) throw new PaymentCredentialsKeyError();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new PaymentCredentialsKeyError();
  return key;
}

/** True when a usable key is configured (no value is exposed). */
export function isPaymentCredentialsKeyConfigured(): boolean {
  try {
    keyFor(CURRENT_VERSION);
    return true;
  } catch {
    return false;
  }
}

export function encryptCredential(plaintext: string): EncryptedValue {
  const key = keyFor(CURRENT_VERSION);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: CURRENT_VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** Throws on a wrong key, a tampered value or a malformed record. */
export function decryptCredential(value: EncryptedValue): string {
  if (!value || typeof value !== "object") throw new Error("Invalid encrypted credential");
  const key = keyFor(value.v);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ct, "base64")), decipher.final()]).toString("utf8");
}
