import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { encryptKeyCheck, paymentKeyFingerprint, verifyKeyCheck } from "@/lib/payments/credentials-crypto";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { PAYMENT_KEY_CHECK_ID, PaymentKeyCheck, type PaymentKeyCheckCreator } from "@/models/PaymentKeyCheck";

/**
 * Is the configured `PAYMENT_CREDENTIALS_KEY` the one the stored payment secrets were written with?
 * (server-only; see docs/payments-architecture.md, "Payment key check")
 *
 * One immutable record (models/PaymentKeyCheck.ts) holds a fixed public label encrypted with the
 * original key. Opening it proves the key without decrypting any store's credentials. States:
 *
 * - `unconfigured`: no usable key. Payment features are off, as before.
 * - `verified`: the record opens with this key.
 * - `mismatch`: the record was READ and this key does not open it. Payments fail closed.
 * - `check_unreadable`: the record exists but cannot be checked (wrong shape or version). Fails closed.
 * - `no_check_no_data`: no record and no encrypted secrets: the first connection creates the record.
 * - `unverified_legacy`: no record but encrypted secrets exist. Payments keep working with a warning;
 *   connecting or reconnecting is refused until an operator adopts the key (`npm run payment-key-check`).
 *   The record is NEVER created automatically in this state.
 * - `unknown`: the database could not be read. NEVER reported as a mismatch, never cached, and
 *   nothing is written; the operation fails as temporarily unavailable and the next one checks again.
 *
 * Nothing here prints, logs or returns a key, a credential or a ciphertext. The fingerprints are
 * short non-secret hashes, shown to Super Admins and the operator command only.
 */

export const PAYMENT_KEY_STATES = [
  "unconfigured",
  "verified",
  "mismatch",
  "check_unreadable",
  "no_check_no_data",
  "unverified_legacy",
  "unknown",
] as const;
export type PaymentKeyState = (typeof PAYMENT_KEY_STATES)[number];

export interface PaymentKeyStatus {
  state: PaymentKeyState;
  /** Fingerprint of the configured key, or null when none is configured. */
  configuredFingerprint: string | null;
  /** Fingerprint recorded in the check record, when one could be read. */
  expectedFingerprint: string | null;
}

/** States in which no payment secret may be decrypted, re-encrypted or used. */
const BLOCKING: ReadonlySet<PaymentKeyState> = new Set(["mismatch", "check_unreadable", "unknown"]);
export const isBlockingPaymentKeyState = (state: PaymentKeyState): boolean => BLOCKING.has(state);

/** How long a mismatch, an unreadable record or the legacy warning is trusted before checking again. */
export const PAYMENT_KEY_RECHECK_MS = 60_000;
const FINGERPRINT = /^[0-9a-f]{16}$/;

// Kept on globalThis so every module instance (e.g. under tsx) shares one cache, like the email outbox.
interface CacheEntry {
  status: PaymentKeyStatus;
  /** Epoch ms; Infinity for `verified`. */
  until: number;
}
const keyCheckGlobal = globalThis as unknown as { __siteforgePaymentKeyCheck?: CacheEntry | null; __siteforgePaymentKeyUnknownLoggedAt?: number };

function cacheFor(status: PaymentKeyStatus, now: number): CacheEntry | null {
  // `verified` holds for as long as the same key is configured; a different key is a different entry.
  if (status.state === "verified") return { status, until: Number.POSITIVE_INFINITY };
  if (status.state === "mismatch" || status.state === "check_unreadable" || status.state === "unverified_legacy") {
    return { status, until: now + PAYMENT_KEY_RECHECK_MS };
  }
  // `unknown` is never cached; `no_check_no_data` can change at any moment (another instance may
  // create the record); `unconfigured` costs nothing to work out.
  return null;
}

/** Test and operator use: forget the cached result (the next check reads the database again). */
export function resetPaymentKeyCheckCache(): void {
  keyCheckGlobal.__siteforgePaymentKeyCheck = null;
  keyCheckGlobal.__siteforgePaymentKeyUnknownLoggedAt = 0;
}

/** Accounts holding any encrypted secret. Counts only: no secret is selected or decrypted. */
export function countEncryptedPaymentAccounts(): Promise<number> {
  return BusinessPaymentAccount.countDocuments({
    $or: [{ keySecretEnc: { $exists: true } }, { webhookSecretEnc: { $exists: true } }],
  });
}

function logState(status: PaymentKeyStatus): void {
  // Fixed events only; never a value. Throttled by the cache (at most once a minute per state).
  if (status.state === "mismatch") console.error(JSON.stringify({ event: "payment_key_mismatch", fix: "docs/payments-architecture.md" }));
  else if (status.state === "check_unreadable") console.error(JSON.stringify({ event: "payment_key_check_unreadable", fix: "docs/payments-architecture.md" }));
  else if (status.state === "unverified_legacy") console.warn(JSON.stringify({ event: "payment_key_unverified", fix: "npm run payment-key-check" }));
}

function logUnknown(error: unknown, now: number): void {
  const last = keyCheckGlobal.__siteforgePaymentKeyUnknownLoggedAt ?? 0;
  if (now - last < PAYMENT_KEY_RECHECK_MS) return;
  keyCheckGlobal.__siteforgePaymentKeyUnknownLoggedAt = now;
  console.warn(JSON.stringify({ event: "payment_key_check_unavailable", category: error instanceof Error ? error.name : "unknown" }));
}

/**
 * The current state. Never throws: a database failure is `unknown`. `fresh` skips the cache (used
 * before writing the record, by the operator command and on the Super Admin page).
 */
export async function checkPaymentKey(options: { fresh?: boolean } = {}): Promise<PaymentKeyStatus> {
  const configuredFingerprint = paymentKeyFingerprint();
  if (!configuredFingerprint) return { state: "unconfigured", configuredFingerprint: null, expectedFingerprint: null };

  const now = Date.now();
  const cached = keyCheckGlobal.__siteforgePaymentKeyCheck;
  if (!options.fresh && cached && cached.status.configuredFingerprint === configuredFingerprint && now < cached.until) {
    return cached.status;
  }

  // Only the reads are inside this block, so only a failed read can become `unknown`.
  let record: { keyVersion?: unknown; check?: unknown; keyFingerprint?: unknown } | null;
  let encryptedAccounts = 0;
  try {
    await dbConnect();
    record = await PaymentKeyCheck.findById(PAYMENT_KEY_CHECK_ID).lean<{ keyVersion?: unknown; check?: unknown; keyFingerprint?: unknown }>();
    if (!record) encryptedAccounts = await countEncryptedPaymentAccounts();
  } catch (error) {
    logUnknown(error, now);
    return { state: "unknown", configuredFingerprint, expectedFingerprint: null };
  }

  let status: PaymentKeyStatus;
  if (record) {
    const expectedFingerprint = typeof record.keyFingerprint === "string" && FINGERPRINT.test(record.keyFingerprint) ? record.keyFingerprint : null;
    const result = record.keyVersion === 1 ? verifyKeyCheck(record.check) : "malformed";
    status = {
      state: result === "match" ? "verified" : result === "mismatch" ? "mismatch" : "check_unreadable",
      configuredFingerprint,
      expectedFingerprint,
    };
  } else {
    status = { state: encryptedAccounts === 0 ? "no_check_no_data" : "unverified_legacy", configuredFingerprint, expectedFingerprint: null };
  }

  keyCheckGlobal.__siteforgePaymentKeyCheck = cacheFor(status, now);
  // Only reached when the answer was not cached, so a warning state is logged at most once a minute.
  logState(status);
  return status;
}

/** The same answer for every blocking state, so owners and callers learn nothing about the cause. */
function keyUnavailable(): HttpError {
  return new HttpError(
    503,
    "Online payment operations are paused while the platform checks its payment settings. Please try again later.",
    "payment_key_unavailable",
    { "Retry-After": "300" },
  );
}

/**
 * Throws `503 payment_key_unavailable` unless payment secrets may be used now. Call it BEFORE any
 * side effect (a refund hold, a provider request). `unconfigured` passes: the existing
 * "no key" handling of each caller applies. `unverified_legacy` passes with its warning.
 */
export async function assertPaymentKeyUsable(): Promise<PaymentKeyStatus> {
  const status = await checkPaymentKey();
  if (isBlockingPaymentKeyState(status.state)) throw keyUnavailable();
  return status;
}

async function createCheckRecord(createdBy: PaymentKeyCheckCreator, existingEncryptedRecordsAtCreation: number, fingerprint: string): Promise<void> {
  // An insert on the fixed id: a second writer gets a duplicate-key error, never an overwrite.
  await PaymentKeyCheck.create({
    _id: PAYMENT_KEY_CHECK_ID,
    keyVersion: 1,
    check: encryptKeyCheck(),
    keyFingerprint: fingerprint,
    createdBy,
    existingEncryptedRecordsAtCreation,
  });
}

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: number }).code === 11000);

/**
 * Before encrypting a store's secrets (connecting or reconnecting an account): passes only when the
 * configured key is proven to be the one the record was made with. With no record and no encrypted
 * secrets anywhere, this key is consistent with all data by definition, so the record is created
 * now (bootstrap). If another instance created it first, its record decides. Every other state,
 * including `unverified_legacy`, refuses with 503 and writes nothing.
 */
export async function assertPaymentKeyForEncryption(): Promise<void> {
  let status = await checkPaymentKey();
  if (status.state === "verified") return;
  if (status.state === "no_check_no_data" && status.configuredFingerprint) {
    try {
      await createCheckRecord("bootstrap", 0, status.configuredFingerprint);
      console.info(JSON.stringify({ event: "payment_key_check_created", createdBy: "bootstrap" }));
    } catch (error) {
      if (!isDuplicateKey(error)) {
        logUnknown(error, Date.now());
        throw keyUnavailable();
      }
    }
    status = await checkPaymentKey({ fresh: true });
    if (status.state === "verified") return;
  }
  if (status.state === "unverified_legacy") {
    throw new HttpError(
      503,
      "Connecting a Razorpay account is paused until the platform finishes a payment settings check. Please try again later.",
      "payment_key_unavailable",
      { "Retry-After": "300" },
    );
  }
  throw keyUnavailable();
}

// ---------------------------------------------------------------------------
// Operator command (lib/payments/key-check-cli.ts)
// ---------------------------------------------------------------------------

export interface PaymentKeyReport extends PaymentKeyStatus {
  /** Accounts holding encrypted secrets, or null when the database could not be read. */
  encryptedAccounts: number | null;
}

export async function paymentKeyReport(): Promise<PaymentKeyReport> {
  const status = await checkPaymentKey({ fresh: true });
  if (status.state === "unknown" || status.state === "unconfigured") return { ...status, encryptedAccounts: null };
  try {
    return { ...status, encryptedAccounts: await countEncryptedPaymentAccounts() };
  } catch {
    return { ...status, encryptedAccounts: null };
  }
}

export type AdoptionRefusal =
  | "invalid_expected_fingerprint"
  | "unconfigured"
  | "database_unavailable"
  | "record_exists"
  | "fingerprint_mismatch";

export type AdoptionResult = { adopted: true; report: PaymentKeyReport } | { adopted: false; reason: AdoptionRefusal; report: PaymentKeyReport | null };

/**
 * Adopts the configured key as the one the stored secrets were written with, by creating the check
 * record. An approved operator action: the expected fingerprint comes from the key escrow, so a
 * person confirms independently that this is the original key. Refuses, writing nothing, when the
 * fingerprint is malformed or differs, no key is configured, the database cannot be read, or a
 * record already exists (including one created concurrently). It never decrypts a store's secrets.
 */
export async function adoptPaymentKey(expectedFingerprint: string): Promise<AdoptionResult> {
  const expected = expectedFingerprint.trim().toLowerCase();
  if (!FINGERPRINT.test(expected)) return { adopted: false, reason: "invalid_expected_fingerprint", report: null };

  const before = await paymentKeyReport();
  if (before.state === "unconfigured") return { adopted: false, reason: "unconfigured", report: before };
  if (before.state === "unknown" || before.encryptedAccounts === null) return { adopted: false, reason: "database_unavailable", report: before };
  if (before.state === "verified" || before.state === "mismatch" || before.state === "check_unreadable") {
    return { adopted: false, reason: "record_exists", report: before };
  }
  if (before.configuredFingerprint !== expected) return { adopted: false, reason: "fingerprint_mismatch", report: before };

  try {
    await createCheckRecord("adoption", before.encryptedAccounts, expected);
  } catch (error) {
    resetPaymentKeyCheckCache();
    if (isDuplicateKey(error)) return { adopted: false, reason: "record_exists", report: await paymentKeyReport() };
    return { adopted: false, reason: "database_unavailable", report: null };
  }
  resetPaymentKeyCheckCache();
  return { adopted: true, report: await paymentKeyReport() };
}
