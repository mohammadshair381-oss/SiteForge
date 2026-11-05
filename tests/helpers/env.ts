/**
 * Test environment bootstrap.
 *
 * Import this module (for its side effects) before any app module that reads
 * `lib/env.ts`, so `env()` can parse a valid configuration. It only fills in
 * safe, non-production defaults for variables that are not already set, so a
 * real `.env`/CI value always wins.
 *
 * No secrets are real: these are throwaway values used for unit tests only.
 */
const TEST_SESSION_SECRET =
  "test-session-secret-0123456789abcdef0123456789abcdef";
const TEST_MONGODB_URI = "mongodb://127.0.0.1:27017/saas_website_builder_test";

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
}
if (!process.env.MONGODB_URI) {
  process.env.MONGODB_URI = TEST_MONGODB_URI;
}

export {};
