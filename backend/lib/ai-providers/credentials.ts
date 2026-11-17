import crypto from "node:crypto";
import { env } from "@/lib/env";
import { dbConnect } from "@/lib/db";
import { AiProviderCredential } from "@/models/AiProviderCredential";

/**
 * AI provider API keys set in the Super Admin panel (owner decision, 2026-11-17), server-only.
 *
 * - Stored only encrypted: AES-256-GCM with a random IV, under a key derived from SESSION_SECRET
 *   with HKDF-SHA256 and its own purpose, so it is never the session signing key. Changing
 *   SESSION_SECRET makes stored keys unreadable: they count as missing and must be entered again.
 * - A stored key wins over the server environment's (`GEMINI_API_KEY` and so on), which stays as
 *   the fallback. A key never turns AI on: `AI_PROVIDER_ENABLED` stays in the environment only.
 * - Never returned, logged, serialised or put in an audit entry. Only `last4` leaves this module.
 * - Adapters read keys synchronously (`aiProviderKey`), so every path that decides availability or
 *   calls a provider runs `loadAiCredentials()` first; the cache lasts 30 seconds, like routing.
 */
const KEY_INFO = "siteforge/ai-provider-credentials/v1";
const VERSION = 1;
const CACHE_MS = 30 * 1000;

export const AI_API_KEY_MIN = 20;
export const AI_API_KEY_MAX = 300;

function encryptionKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(env().SESSION_SECRET, "utf8"), Buffer.alloc(0), Buffer.from(KEY_INFO, "utf8"), 32));
}

export interface EncryptedAiKey {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

export function encryptAiKey(plain: string): EncryptedAiKey {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { v: VERSION, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** Null when it cannot be read (another SESSION_SECRET, or damaged). Never throws. */
export function decryptAiKey(value: EncryptedAiKey): string | null {
  try {
    if (value.v !== VERSION) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A key's last four characters, the only part ever shown. */
export const lastFour = (plain: string) => plain.slice(-4);

interface StoredKey {
  value: string | null;
  last4: string;
  updatedAt: Date | null;
}

let cache: { keys: Map<string, StoredKey>; at: number } | null = null;
/** A failed read is reported once until a read works again, so an outage does not log on every request. */
let readFailureLogged = false;

/** Reads the stored keys (at most every 30 seconds). A read that fails keeps what was known before. */
export async function loadAiCredentials(options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && cache && Date.now() - cache.at < CACHE_MS) return;
  try {
    await dbConnect();
    const docs = await AiProviderCredential.find({}).lean();
    const keys = new Map<string, StoredKey>();
    for (const doc of docs) {
      const value = decryptAiKey(doc);
      if (value === null) console.error(`[ai-credentials] a stored key cannot be read provider=${doc._id}`);
      keys.set(doc._id, { value, last4: doc.last4, updatedAt: doc.updatedAt ?? null });
    }
    cache = { keys, at: Date.now() };
    readFailureLogged = false;
  } catch {
    if (!readFailureLogged) console.error("[ai-credentials] stored keys could not be read");
    readFailureLogged = true;
    cache = { keys: cache?.keys ?? new Map(), at: Date.now() };
  }
}

export function clearAiCredentialCache(): void {
  cache = null;
}

/** The key an adapter uses: the stored one, else the server environment's. Empty when neither exists. */
export function aiProviderKey(providerId: string, envName: string): string {
  return cache?.keys.get(providerId)?.value || process.env[envName] || "";
}

export type AiKeySource = "admin" | "environment" | "unreadable" | "none";

/** Where an adapter's key comes from, for the Super Admin panel. Never the key itself. */
export function aiKeyStatus(providerId: string, envName: string): { source: AiKeySource; last4: string | null; updatedAt: string | null } {
  const stored = cache?.keys.get(providerId);
  if (stored?.value) return { source: "admin", last4: stored.last4, updatedAt: stored.updatedAt?.toISOString() ?? null };
  if (process.env[envName]) return { source: "environment", last4: null, updatedAt: null };
  if (stored) return { source: "unreadable", last4: stored.last4, updatedAt: stored.updatedAt?.toISOString() ?? null };
  return { source: "none", last4: null, updatedAt: null };
}
