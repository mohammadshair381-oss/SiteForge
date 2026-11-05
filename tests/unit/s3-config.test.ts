import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { HttpError } from "../../lib/api";
import {
  buildS3ClientConfig,
  getS3PublicBaseUrl,
  parseS3Endpoint,
  resolveS3Bucket,
} from "../../lib/s3";

/**
 * Storage configuration (Phase 5): S3_* names with legacy AWS_* fallback,
 * optional Cloudflare R2 endpoint, and fail-closed behaviour that platform-
 * injected AWS_* values cannot mask. Pure: never touches process.env or AWS.
 */

const SECRET = "very-secret-value-1234567890";
const KEY_ID = "key-id-abcdefghij";

function expectUnavailable(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "storage_unavailable");
    return true;
  });
}

/** Captures console.error output for the duration of `fn`. */
function captureErrors(fn: () => void): string {
  const lines: string[] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } catch {
    // assertions about the thrown error are made by the caller
  } finally {
    spy.mock.restore();
  }
  return lines.join("\n");
}

test("S3_* configuration builds an AWS S3 client config without an endpoint", () => {
  const config = buildS3ClientConfig({
    NODE_ENV: "production",
    S3_REGION: "eu-west-1",
    S3_ACCESS_KEY_ID: KEY_ID,
    S3_SECRET_ACCESS_KEY: SECRET,
  });
  assert.equal(config.region, "eu-west-1");
  assert.deepEqual(config.credentials, { accessKeyId: KEY_ID, secretAccessKey: SECRET });
  assert.equal("endpoint" in config, false);
});

test("Cloudflare R2: an endpoint is used as an origin and the region defaults to auto", () => {
  const config = buildS3ClientConfig({
    NODE_ENV: "production",
    S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com/",
    S3_ACCESS_KEY_ID: KEY_ID,
    S3_SECRET_ACCESS_KEY: SECRET,
  });
  assert.equal(config.endpoint, "https://0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(config.region, "auto");

  const explicit = buildS3ClientConfig({
    S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
    S3_REGION: "weur",
    S3_ACCESS_KEY_ID: KEY_ID,
    S3_SECRET_ACCESS_KEY: SECRET,
  });
  assert.equal(explicit.region, "weur", "an explicit region wins over the R2 default");
});

test("invalid endpoints are rejected without echoing their value", () => {
  const invalid = [
    "not a url",
    "http://acc.r2.cloudflarestorage.com",
    `https://user:${SECRET}@acc.r2.cloudflarestorage.com`,
    "https://acc.r2.cloudflarestorage.com/bucket",
    "https://acc.r2.cloudflarestorage.com/?x=1",
    "https://acc.r2.cloudflarestorage.com/#frag",
    "ftp://acc.example.com",
  ];
  for (const value of invalid) {
    const logs = captureErrors(() => expectUnavailable(() => parseS3Endpoint(value)));
    assert.match(logs, /S3_ENDPOINT/);
    assert.equal(logs.includes(value), false, `the endpoint value must not be logged: ${value}`);
    assert.equal(logs.includes(SECRET), false);
  }
  assert.equal(parseS3Endpoint(""), null);
});

test("legacy AWS_* credentials still work outside production (existing local setups)", () => {
  const config = buildS3ClientConfig({
    NODE_ENV: "development",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: KEY_ID,
    AWS_SECRET_ACCESS_KEY: SECRET,
  });
  assert.equal(config.region, "us-east-1");
  assert.deepEqual(config.credentials, { accessKeyId: KEY_ID, secretAccessKey: SECRET });
});

test("S3_* values take priority over legacy AWS_* values", () => {
  const config = buildS3ClientConfig({
    NODE_ENV: "development",
    S3_REGION: "eu-central-1",
    S3_ACCESS_KEY_ID: "new-key",
    S3_SECRET_ACCESS_KEY: "new-secret",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "old-key",
    AWS_SECRET_ACCESS_KEY: "old-secret",
  });
  assert.equal(config.region, "eu-central-1");
  assert.deepEqual(config.credentials, { accessKeyId: "new-key", secretAccessKey: "new-secret" });
});

test("platform-injected AWS_* values cannot mask missing storage credentials in production", () => {
  // Vercel injects AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY into
  // every function even when the project never set them.
  const injected = {
    AWS_REGION: "iad1-region",
    AWS_ACCESS_KEY_ID: KEY_ID,
    AWS_SECRET_ACCESS_KEY: SECRET,
  };
  for (const source of [
    { ...injected, NODE_ENV: "production" },
    { ...injected, NODE_ENV: "development", VERCEL: "1" },
  ]) {
    const logs = captureErrors(() => expectUnavailable(() => buildS3ClientConfig(source)));
    assert.match(logs, /missing S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
    assert.equal(logs.includes(SECRET), false);
    assert.equal(logs.includes(KEY_ID), false);
  }
});

test("partially configured S3_* credentials report only the missing names", () => {
  const logs = captureErrors(() =>
    expectUnavailable(() =>
      buildS3ClientConfig({
        NODE_ENV: "production",
        S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
        S3_ACCESS_KEY_ID: KEY_ID,
      }),
    ),
  );
  assert.match(logs, /missing S3_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(logs, /S3_REGION/, "region defaults to auto when an endpoint is set");
  assert.equal(logs.includes(KEY_ID), false);
});

test("credentials are never mixed across S3_* and AWS_* sets", () => {
  const logs = captureErrors(() =>
    expectUnavailable(() =>
      buildS3ClientConfig({
        NODE_ENV: "development",
        AWS_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: "new-key",
        AWS_ACCESS_KEY_ID: "old-key",
        AWS_SECRET_ACCESS_KEY: SECRET,
      }),
    ),
  );
  assert.match(logs, /missing S3_SECRET_ACCESS_KEY/);
  assert.equal(logs.includes(SECRET), false);
});

test("a malformed public URL is logged by variable name only", () => {
  const logs = captureErrors(() =>
    expectUnavailable(() => getS3PublicBaseUrl({ S3_PUBLIC_URL: `ftp://user:${SECRET}@cdn.example.com` })),
  );
  assert.match(logs, /S3_PUBLIC_URL/);
  assert.equal(logs.includes(SECRET), false);
});

test("bucket and public URL prefer S3_* and fall back to AWS_S3_* everywhere", () => {
  assert.equal(resolveS3Bucket({ S3_BUCKET: "new", AWS_S3_BUCKET: "old" }), "new");
  assert.equal(resolveS3Bucket({ NODE_ENV: "production", VERCEL: "1", AWS_S3_BUCKET: "old" }), "old");
  expectUnavailable(() => resolveS3Bucket({}));

  assert.equal(
    getS3PublicBaseUrl({ S3_PUBLIC_URL: "https://media.example.com/", AWS_S3_PUBLIC_URL: "https://old.example.com" }),
    "https://media.example.com",
  );
  assert.equal(getS3PublicBaseUrl({ AWS_S3_PUBLIC_URL: "https://old.example.com" }), "https://old.example.com");
  expectUnavailable(() => getS3PublicBaseUrl({}));
  expectUnavailable(() => getS3PublicBaseUrl({ S3_PUBLIC_URL: "not-a-url" }));
});
