/**
 * Safety checks for the local integration-test MongoDB harness.
 *
 * Integration tests must never point at Atlas, a shared development database,
 * or any other persistent MongoDB. The harness generates its own URI from
 * MongoMemoryReplSet, but we still validate it before assigning
 * `process.env.MONGODB_URI` so a future change cannot silently open a
 * persistent connection.
 *
 * This module is deliberately dependency-free and safe to import before the
 * application (and therefore before `lib/env.ts` caches its configuration).
 */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const TEST_DATABASE_PATTERN = /^saas_test_[A-Za-z0-9_-]+$/;

export interface LocalTestMongoUriOptions {
  /** Label used in error messages. Never includes the URI or credentials. */
  label?: string;
}

/**
 * Assert that `uri` is a plain `mongodb://` URI for a throwaway test database
 * on localhost/127.0.0.1. Returns the URI unchanged so it can be assigned
 * inline.
 *
 * Rejected inputs include:
 * - `mongodb+srv://` and non-MongoDB schemes
 * - remote hosts, including lookalikes such as `localhost.example.com`
 * - IPv6/loopback aliases (only the two explicit hosts are accepted)
 * - URIs with credentials
 * - database names that do not use the `saas_test_` prefix
 */
export function assertLocalTestMongoUri(
  uri: string,
  options: LocalTestMongoUriOptions = {},
): string {
  const label = options.label ?? "MongoDB test URI";

  if (typeof uri !== "string" || uri.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${label} is not a valid MongoDB URI`);
  }

  if (parsed.protocol !== "mongodb:") {
    throw new Error(
      `${label} must use the mongodb:// scheme (received ${parsed.protocol.replace(/:$/, "")})`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(`${label} must target localhost or 127.0.0.1`);
  }

  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error(`${label} has an invalid database name`);
  }

  if (!TEST_DATABASE_PATTERN.test(database)) {
    throw new Error(`${label} must target a throwaway saas_test_* database`);
  }

  return uri;
}
