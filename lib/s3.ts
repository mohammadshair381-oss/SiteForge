import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HttpError } from "./api";

/**
 * Server-only S3-compatible wrapper for media storage (AWS S3 or Cloudflare R2).
 *
 * Credentials are read from the environment at call time and never leave this
 * module: callers receive only a public URL. Configuration/transport failures
 * are converted into safe `HttpError`s so route handlers never leak SDK
 * internals (endpoint, request ids, key names) to the browser. Logs name
 * variables only, never their values.
 *
 * Configuration (preferred `S3_*` names, legacy `AWS_*` fallback):
 *
 * | Setting        | Preferred              | Legacy fallback          |
 * |----------------|------------------------|--------------------------|
 * | endpoint       | `S3_ENDPOINT`          | — (unset = AWS S3)       |
 * | region         | `S3_REGION`            | `AWS_REGION` *           |
 * | access key id  | `S3_ACCESS_KEY_ID`     | `AWS_ACCESS_KEY_ID` *    |
 * | secret key     | `S3_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` *|
 * | bucket         | `S3_BUCKET`            | `AWS_S3_BUCKET`          |
 * | public base URL| `S3_PUBLIC_URL`        | `AWS_S3_PUBLIC_URL`      |
 *
 * (*) Credential and region fallback is only honoured outside production and
 * never on Vercel. Vercel injects `AWS_REGION` / `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` into every function (documented as "not usable as AWS
 * credentials"), so falling back to them would hide a missing storage setup
 * behind a confusing upstream 502 instead of a clear 503. Production therefore
 * requires the `S3_*` credentials explicitly. The `VERCEL` check alone is not
 * relied on because Vercel lets projects disable system variables.
 *
 * Cloudflare R2: set `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`;
 * the region defaults to `auto` when an endpoint is configured.
 */

const CONFIG_ERROR_MESSAGE = "Media storage is not configured";
const STORAGE_ERROR_MESSAGE = "Media storage request failed";

type EnvSource = Record<string, string | undefined>;

function storageUnavailable(): HttpError {
  return new HttpError(503, CONFIG_ERROR_MESSAGE, "storage_unavailable");
}

function read(source: EnvSource, name: string): string {
  return (source[name] ?? "").trim();
}

/** Whether platform-ambiguous `AWS_*` credentials may be used as a fallback. */
function legacyAwsCredentialsAllowed(source: EnvSource): boolean {
  return source.NODE_ENV !== "production" && !read(source, "VERCEL");
}

/**
 * Validates the optional custom endpoint. Accepts only an absolute `https:`
 * origin (no credentials, path, query or fragment). Returns null when unset;
 * throws a 503 (logging the variable name only) when set but invalid.
 */
export function parseS3Endpoint(value: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    console.error("[s3] S3_ENDPOINT is not a valid URL");
    throw storageUnavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    console.error("[s3] S3_ENDPOINT must be an https origin without credentials, path or query");
    throw storageUnavailable();
  }
  return url.origin;
}

/**
 * Builds the S3 client configuration from the environment. Pure apart from
 * logging: it reads only the given `source`, so it is unit-testable without
 * touching `process.env`. Missing settings are reported by variable *name*.
 */
export function buildS3ClientConfig(source: EnvSource = process.env): S3ClientConfig {
  const endpoint = parseS3Endpoint(read(source, "S3_ENDPOINT"));
  const legacy = legacyAwsCredentialsAllowed(source);

  // Credentials come from ONE set: never pair an S3_* key id with an AWS_*
  // secret (that only produces an opaque signature error upstream).
  const useS3Credentials =
    Boolean(read(source, "S3_ACCESS_KEY_ID")) || Boolean(read(source, "S3_SECRET_ACCESS_KEY"));
  const accessKeyId = useS3Credentials
    ? read(source, "S3_ACCESS_KEY_ID")
    : legacy
      ? read(source, "AWS_ACCESS_KEY_ID")
      : "";
  const secretAccessKey = useS3Credentials
    ? read(source, "S3_SECRET_ACCESS_KEY")
    : legacy
      ? read(source, "AWS_SECRET_ACCESS_KEY")
      : "";
  const region =
    read(source, "S3_REGION") ||
    (endpoint ? "auto" : legacy ? read(source, "AWS_REGION") : "");

  const missing: string[] = [];
  if (!region) missing.push("S3_REGION");
  if (!accessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    console.error(`[s3] storage is not configured: missing ${missing.join(", ")}`);
    throw storageUnavailable();
  }

  return {
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...(endpoint ? { endpoint } : {}),
  };
}

function requireSetting(source: EnvSource, preferred: string, legacy: string): string {
  const value = read(source, preferred) || read(source, legacy);
  if (!value) {
    console.error(`[s3] storage is not configured: missing ${preferred}`);
    throw storageUnavailable();
  }
  return value;
}

/** Bucket name (`S3_BUCKET`, falling back to `AWS_S3_BUCKET`). */
export function resolveS3Bucket(source: EnvSource = process.env): string {
  return requireSetting(source, "S3_BUCKET", "AWS_S3_BUCKET");
}

function getS3Client(): S3Client {
  return new S3Client(buildS3ClientConfig());
}

function getS3Bucket(): string {
  return resolveS3Bucket();
}

export function getS3PublicBaseUrl(source: EnvSource = process.env): string {
  const value = requireSetting(source, "S3_PUBLIC_URL", "AWS_S3_PUBLIC_URL").replace(/\/+$/, "");

  // A malformed base would otherwise produce a stored image URL that can never
  // load. Treat it like missing configuration so the failure happens before an
  // upload is written instead of after the metadata record already exists.
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.error("[s3] S3_PUBLIC_URL is not a valid URL");
    throw storageUnavailable();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.search ||
    parsed.hash
  ) {
    console.error("[s3] S3_PUBLIC_URL must be an http(s) URL without query or fragment");
    throw storageUnavailable();
  }

  return value;
}

/**
 * Wraps an SDK call so an outage, bad credentials or a missing bucket becomes a
 * deterministic 502 instead of an unhandled 500. Only the error *name* is
 * logged: messages can include request details we do not want in logs.
 */
async function runStorageAction<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error(`[s3] ${action} failed (${name})`);
    throw new HttpError(502, STORAGE_ERROR_MESSAGE, "storage_error");
  }
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  await runStorageAction("putObject", () =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Immutable, unguessable keys; cache aggressively at the CDN/browser.
        CacheControl: "public, max-age=31536000, immutable",
      }),
    ),
  );
}

async function removeObject(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  // S3 DeleteObject is idempotent: deleting a missing key succeeds.
  await runStorageAction("deleteObject", () =>
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
  );
}

function publicUrl(key: string): string {
  return `${getS3PublicBaseUrl()}/${key}`;
}

/**
 * Presigned direct-to-S3 upload URL. Not wired into a route yet (the current
 * endpoint streams through the server), but kept for the larger-file flow.
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Indirection object so tests can replace individual operations with
 * `node:test`'s `mock.method` without touching real AWS. Route handlers must use
 * this object instead of the module-level functions.
 */
export const s3Storage = {
  upload: putObject,
  remove: removeObject,
  publicUrl,
};

/** Produces a safe HttpError for storage failures. */
export function storageErrorFrom(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`[s3] storage operation failed (${name})`);
  return new HttpError(502, STORAGE_ERROR_MESSAGE, "storage_error");
}