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
 * A wrong but well-formed key is caught by the key-check record (lib/payments/key-check.ts),
 * which uses the separate check functions at the end of this file.
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

// ---------------------------------------------------------------------------
// Key check (lib/payments/key-check.ts). Separate from the credential functions above, which
// are unchanged: the check record encrypts a fixed PUBLIC label, never a store's secret, under its
// own associated data, so a credential's ciphertext can never pass as a check record.
// ---------------------------------------------------------------------------

/** The public, fixed plaintext of the key-check record. Not a secret. */
export const KEY_CHECK_LABEL = "siteforge payment credentials key check v1";
const KEY_CHECK_AAD = Buffer.from("siteforge:payment-key-check:v1", "utf8");
/** Same formula as the fingerprint command in docs/backup-and-disaster-recovery.md. */
const FINGERPRINT_PREFIX = "siteforge-payment-key-check:";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A short, non-secret fingerprint of the configured key (16 hex characters), or null when no
 * usable key is configured. It identifies which key is in use; the key cannot be derived from it.
 */
export function paymentKeyFingerprint(): string | null {
  let key: Buffer;
  try {
    key = keyFor(CURRENT_VERSION);
  } catch {
    return null;
  }
  return crypto.createHash("sha256").update(FINGERPRINT_PREFIX).update(key).digest("hex").slice(0, 16);
}

/** Encrypts the public key-check label with the configured key. Throws when no key is configured. */
export function encryptKeyCheck(): EncryptedValue {
  const key = keyFor(CURRENT_VERSION);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(KEY_CHECK_AAD);
  const ct = Buffer.concat([cipher.update(KEY_CHECK_LABEL, "utf8"), cipher.final()]);
  return { v: CURRENT_VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/**
 * Whether the configured key opens a stored key-check value:
 * - `match`: it authenticates and holds the label;
 * - `mismatch`: well-formed, but this key does not authenticate it (a different key wrote it);
 * - `malformed`: not a key-check value this version can read (wrong shape, sizes or version, or a
 *   different plaintext).
 * Throws `PaymentCredentialsKeyError` when no key is configured; callers check that first.
 */
export function verifyKeyCheck(value: unknown): "match" | "mismatch" | "malformed" {
  const key = keyFor(CURRENT_VERSION);
  if (!value || typeof value !== "object") return "malformed";
  const { v, iv, tag, ct } = value as Partial<Record<keyof EncryptedValue, unknown>>;
  if (v !== CURRENT_VERSION) return "malformed";
  if (typeof iv !== "string" || typeof tag !== "string" || typeof ct !== "string") return "malformed";
  if (!BASE64.test(iv) || !BASE64.test(tag) || !BASE64.test(ct)) return "malformed";
  const ivBytes = Buffer.from(iv, "base64");
  const tagBytes = Buffer.from(tag, "base64");
  const ctBytes = Buffer.from(ct, "base64");
  if (ivBytes.length !== 12 || tagBytes.length !== 16 || ctBytes.length === 0) return "malformed";
  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, ivBytes);
    decipher.setAAD(KEY_CHECK_AAD);
    decipher.setAuthTag(tagBytes);
    plaintext = Buffer.concat([decipher.update(ctBytes), decipher.final()]).toString("utf8");
  } catch {
    return "mismatch";
  }
  return plaintext === KEY_CHECK_LABEL ? "match" : "malformed";
}
