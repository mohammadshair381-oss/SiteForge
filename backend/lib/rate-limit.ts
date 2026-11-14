import crypto from "node:crypto";
import { dbConnect } from "./db";
import { HttpError } from "./api";
import { env, isProduction } from "./env";
import { RateLimit } from "@/models/RateLimit";

export interface RateLimitOptions {
  /** Logical bucket, excluding the time window (e.g. `login:ip:1.2.3.4`). */
  key: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  /** Internal bucket id (hashed key + window); pass to `releaseRateLimit`. */
  bucketKey: string;
}

/**
 * Resolves a client identifier for rate limiting.
 *
 * The repository contains no deployment manifest, so the proxy trust model
 * cannot be confirmed from source. Rather than guess a provider or blindly trust
 * the client-controllable left-most `x-forwarded-for` entry, header-based
 * extraction is OFF unless the operator explicitly opts in via
 * `TRUSTED_IP_HEADER` (the header their proxy sets, e.g. `x-real-ip`). When
 * enabled, a comma-separated forward header uses its right-most entry — the one
 * appended by the nearest trusted hop — not the spoofable left-most value.
 *
 * Outside production this returns the shared bucket `"unknown"`, which degrades
 * per-IP limiting to a global limit (safe, but coarse); local development is
 * unaffected because no such header was present before either.
 *
 * In production the trusted header is mandatory: without it every caller would
 * collapse into one bucket, so per-IP limits stop working and a single actor
 * could lock out the whole platform. Rather than silently degrade, requests
 * that cannot be attributed to a client are refused with a clear operational
 * error (`rate_limit_misconfigured`). This is fail-closed and never trusts an
 * arbitrary client-supplied forwarding header.
 */
export function getClientIp(request: Request): string {
  const trustedHeader = env().TRUSTED_IP_HEADER;
  if (!trustedHeader) {
    if (isProduction()) {
      throw new HttpError(
        503,
        "Rate limiting is not configured for this environment",
        "rate_limit_misconfigured",
      );
    }
    return "unknown";
  }

  const raw = request.headers.get(trustedHeader);
  const value =
    trustedHeader === "x-forwarded-for"
      ? raw
          ?.split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .pop()
      : raw?.trim();

  if (!value) {
    if (isProduction()) {
      throw new HttpError(
        503,
        "Client address could not be determined for rate limiting",
        "rate_limit_misconfigured",
      );
    }
    return "unknown";
  }

  return value;
}

const HASH_DOMAIN = "siteforge:rate-limit:v1";

/**
 * Derives a stable, non-reversible token for a logical bucket using the existing
 * server secret. Raw IP addresses, emails, and user ids are never stored in the
 * database. The domain string provides key separation from JWT signing.
 */
function hashIdentifier(key: string): string {
  return crypto
    .createHmac("sha256", env().SESSION_SECRET)
    .update(`${HASH_DOMAIN}:${key}`)
    .digest("hex");
}

interface LimiterCache {
  indexes?: Promise<void>;
}

const globalWithLimiter = globalThis as unknown as {
  _rateLimitIndexCache?: LimiterCache;
};

const limiterCache: LimiterCache =
  globalWithLimiter._rateLimitIndexCache ??
  (globalWithLimiter._rateLimitIndexCache = {});

const rateLimitUnavailable = () =>
  new HttpError(
    503,
    "Rate limiting is temporarily unavailable",
    "rate_limit_unavailable",
  );

/**
 * Confirms the unique index backing rate-limit counters exists before we rely on
 * it. Without it, concurrent upserts could insert duplicate counters and silently
 * under-count. It only looks: creating an index on a persistent database is an
 * approved operation (docs/database-preparation.md). The answer is memoized for
 * the process lifetime once found, mirroring the lazy, cached connection pattern
 * in `lib/db.ts`. If the index cannot be confirmed, we fail closed with 503
 * rather than pretend limiting works.
 */
async function ensureRateLimitIndexes(): Promise<void> {
  if (!limiterCache.indexes) {
    limiterCache.indexes = (async () => {
      // Waits for the automatic build where lib/db.ts allows one, and does nothing elsewhere.
      await RateLimit.init().catch(() => undefined);
      const indexes = (await RateLimit.collection.indexes().catch(() => {
        // No collection yet, or the database could not say: neither confirms the index.
        throw rateLimitUnavailable();
      })) as Array<{
        key?: Record<string, number>;
        unique?: boolean;
      }>;
      const hasUniqueKeyIndex = indexes.some(
        (index) => index.unique === true && index.key?.key === 1,
      );
      if (!hasUniqueKeyIndex) throw rateLimitUnavailable();
    })().catch((error: unknown) => {
      // Allow a later request to retry index setup.
      limiterCache.indexes = undefined;
      throw error;
    });
  }
  return limiterCache.indexes;
}

/**
 * Atomically increments a fixed-window counter and reports whether the caller
 * is still under the limit. Backed by MongoDB so limits are shared across
 * instances and serverless invocations (an in-memory map would not be). Keys are
 * bucketed per window, so counters never leak into the next window even if the
 * TTL cleaner has not run yet.
 */
export async function consumeRateLimit({
  key,
  limit,
  windowMs,
}: RateLimitOptions): Promise<RateLimitResult> {
  await dbConnect();
  await ensureRateLimitIndexes();

  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const bucketKey = `${hashIdentifier(key)}:${bucket}`;
  const expiresAt = new Date((bucket + 1) * windowMs);

  let count = 0;
  // Concurrent upserts on the same key can race to insert; retry once on E11000.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const doc = await RateLimit.findOneAndUpdate(
        { key: bucketKey },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { new: true, upsert: true },
      ).lean();
      count = doc?.count ?? 1;
      break;
    } catch (error) {
      const isDuplicateKey =
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: number }).code === 11000;
      if (!isDuplicateKey || attempt === 1) throw error;
    }
  }

  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterMs: allowed ? 0 : Math.max(0, expiresAt.getTime() - now),
    bucketKey,
  };
}

/**
 * Gives back one unit consumed by `consumeRateLimit` in the SAME window bucket
 * (used to count only failed attempts: reserve before the check, release on
 * success). Never goes below zero; a bucket that already expired is a no-op.
 */
export async function releaseRateLimit(bucketKey: string): Promise<void> {
  await dbConnect();
  await RateLimit.updateOne({ key: bucketKey, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

/** The standard 429 error (with `Retry-After`) for an exhausted bucket. */
export function rateLimitedError(retryAfterMs: number): HttpError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new HttpError(
    429,
    "Too many requests. Please try again later.",
    "rate_limited",
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/** For background work with no response to fail: whether it may go ahead. */
export async function checkRateLimit(options: RateLimitOptions): Promise<boolean> {
  return (await consumeRateLimit(options)).allowed;
}

/** Throws a 429 (with `Retry-After`) when the caller is over the limit. */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const result = await consumeRateLimit(options);
  if (result.allowed) return;
  throw rateLimitedError(result.retryAfterMs);
}
