/**
 * Integration test environment bootstrap.
 *
 * Import this module (for its side effects) BEFORE any app module that reads
 * `lib/env.ts`, so `env()` can parse a valid configuration using the isolated
 * in-memory MongoDB instance. It fills in safe, non-production defaults for
 * most variables; `MONGODB_URI` is always replaced with the generated
 * in-memory URI so a persistent CI value can never be used.
 *
 * No secrets are real: these are throwaway values used for integration tests only.
 *
 * This bootstrap deliberately never loads `.env`/`.env.local`; those files may
 * contain a persistent MONGODB_URI. The generated in-memory URI is validated by
 * `assertLocalTestMongoUri` before it is assigned to `process.env`.
 */

import { MongoMemoryReplSet } from "mongodb-memory-server";

import { assertLocalTestMongoUri } from "./mongo-safety";

let replSet: MongoMemoryReplSet | null = null;
let mongoUri: string | null = null;

/**
 * Starts a single-node MongoDB replica set for the entire test suite.
 * Call this once in a `before` hook.
 *
 * A replica set is required for multi-document transactions (used by
 * app/api/businesses/[id]/members/[memberId]/route.ts and the payments
 * webhook). A plain MongoMemoryServer runs a standalone `mongod`, where
 * transactions fail with "Transaction numbers are only allowed on a replica
 * set member or mongos".
 */
export async function startIntegrationSuite(): Promise<void> {
  if (replSet) {
    return; // Already started
  }
  replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: 1,
      name: "rs0",
      storageEngine: "wiredTiger",
    },
  });

  const uri = assertLocalTestMongoUri(
    replSet.getUri(`saas_test_${crypto.randomUUID()}`),
    { label: "Integration test MongoDB URI" },
  );

  mongoUri = uri;
  process.env.MONGODB_URI = uri;
  process.env.SESSION_SECRET ??= "test-session-secret-0123456789abcdef0123456789abcdef";
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  process.env.PAYMENT_PROVIDER = "manual";
  process.env.ALLOW_MANUAL_BILLING = "true";
  process.env.TRUSTED_IP_HEADER = "x-forwarded-for";
  process.env.ROOT_DOMAINS = "localhost:3000";
  // Email must never leave the process in tests: use the in-memory outbox.
  // `??=` so a test file can opt into a specific provider (e.g. to simulate a
  // provider outage) by setting it before the suite starts.
  process.env.EMAIL_PROVIDER ??= "memory";
  process.env.APP_URL ??= "http://localhost:3000";
}

/**
 * Stops the MongoMemoryServer instance.
 * Call this once in an `after` hook.
 */
export async function stopIntegrationSuite(): Promise<void> {
  if (replSet) {
    await replSet.stop();
    replSet = null;
    mongoUri = null;
  }
}

/**
 * Returns the current test MongoDB URI.
 * Throws if the suite hasn't been started.
 */
export function getTestMongoUri(): string {
  if (!replSet || !mongoUri) {
    throw new Error("Integration test MongoDB not started. Call startIntegrationSuite() first.");
  }
  return mongoUri;
}

/**
 * Legacy per-test setup (deprecated - use startIntegrationSuite/stopIntegrationSuite).
 * Kept for backward compatibility but creates a new server each call.
 */
export async function setupIntegrationEnv(): Promise<void> {
  await startIntegrationSuite();
}

export async function teardownIntegrationEnv(): Promise<void> {
  await stopIntegrationSuite();
}

export {};