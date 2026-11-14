import crypto from "node:crypto";

/**
 * Pure media helpers shared by the upload route and the unit tests.
 *
 * Nothing in this module touches the filesystem, MongoDB, AWS or `next/server`,
 * so it can be unit-tested in isolation. Storage-provider calls live in
 * `lib/s3.ts`.
 */

/**
 * Hard upper bound for a single uploaded image (4 MiB).
 *
 * Uploads stream through a route handler as multipart form data, and Vercel
 * Functions reject request bodies over 4.5 MB (413 FUNCTION_PAYLOAD_TOO_LARGE)
 * before the app sees them. 4 MiB (4,194,304 bytes) plus the multipart envelope
 * stays below that limit even if it means 4,500,000 bytes, so oversized files
 * get the app's own clear error instead of the platform's.
 */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

/**
 * Allowance for the multipart envelope around the file (boundaries, part
 * headers, the small `alt` field). Used only for the early `Content-Length`
 * rejection; the exact file size is always checked separately.
 */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Whether this deployment serves local media addresses: the same rule as the local-media route.
 * Everywhere else such an address can only ever be a broken image.
 */
export const localMediaServable = () => process.env.LOCAL_MEDIA_ENABLED === "true" && process.env.NODE_ENV !== "production";

/**
 * The configured public base URL of the media bucket, if any. Prefers
 * `S3_PUBLIC_URL` and falls back to the legacy `AWS_S3_PUBLIC_URL`. Never
 * throws; used by ownership checks that must work in local-disk mode too.
 * (`lib/s3.ts#getS3PublicBaseUrl` is the validating variant for uploads.)
 */
export function configuredMediaPublicBaseUrl(
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = (source.S3_PUBLIC_URL ?? "").trim() || (source.AWS_S3_PUBLIC_URL ?? "").trim();
  return value || undefined;
}

/**
 * Normalises a media public base URL for comparison: an absolute http(s) URL
 * without credentials, query or fragment, with trailing slashes removed.
 * Returns null for anything else.
 */
export function normalizeMediaPublicBaseUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Optional legacy media base URL (`S3_LEGACY_PUBLIC_URL`) for a storage
 * migration, e.g. AWS S3 -> Cloudflare R2 where existing products still store
 * URLs under the old bucket's public URL. Objects must keep the SAME storage
 * keys in the new bucket.
 *
 * Only honoured when a current base URL is configured (local-disk mode is
 * unchanged), and ignored when invalid (logged by name only) or identical to
 * the current base.
 */
export function configuredLegacyMediaPublicBaseUrl(
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = (source.S3_LEGACY_PUBLIC_URL ?? "").trim();
  if (!raw) return undefined;
  const current = normalizeMediaPublicBaseUrl(configuredMediaPublicBaseUrl(source));
  if (!current) return undefined;
  const legacy = normalizeMediaPublicBaseUrl(raw);
  if (!legacy) {
    console.error("[media] S3_LEGACY_PUBLIC_URL is invalid and is ignored");
    return undefined;
  }
  return legacy === current ? undefined : legacy;
}

/** Every base URL whose media URLs are subject to tenant ownership checks. */
export function mediaPublicBaseUrls(
  source: Record<string, string | undefined> = process.env,
): string[] {
  const current = configuredMediaPublicBaseUrl(source);
  if (!current) return [];
  const legacy = configuredLegacyMediaPublicBaseUrl(source);
  return legacy ? [current, legacy] : [current];
}

/**
 * Parses a URL against each configured base (current first). A match under ANY
 * base is a platform media reference and goes through the same ownership
 * checks; only URLs under none of them are treated as external.
 */
export function parseMediaStorageUrlFromBases(
  value: string,
  bases: readonly string[],
): MediaStorageUrl | null {
  for (const base of bases) {
    const reference = parseMediaStorageUrl(value, base);
    if (reference) return reference;
  }
  return null;
}

/** The legacy-URL form of a storage key, if a legacy base is configured. */
export function legacyMediaUrlForKey(
  storageKey: string,
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  const legacy = configuredLegacyMediaPublicBaseUrl(source);
  return legacy ? `${legacy}/${storageKey}` : undefined;
}

/**
 * Allowlist of accepted image types. SVG is deliberately excluded: it can carry
 * script and is served from the same origin as the rest of the bucket/CDN, so
 * accepting it would turn an upload into stored XSS.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

const EXTENSION_BY_MIME: Record<AllowedImageMime, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const BUSINESS_ID_PATTERN = /^[0-9a-f]{24}$/i;

function startsWith(buf: Uint8Array, bytes: readonly number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Detects the real image type from the file's magic bytes.
 *
 * The client-supplied MIME type and filename are never trusted; the detected
 * value is what gets stored, what drives the generated extension, and what is
 * sent to S3 as `Content-Type`. Signatures use the full magic number (e.g. all
 * 8 PNG bytes, `GIF87a`/`GIF89a`) so a text file renamed to `.png` is rejected.
 */
export function detectImageMime(buf: Uint8Array | null | undefined): AllowedImageMime | null {
  if (!buf || buf.length < 3) return null;

  // JPEG: FF D8 FF
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // GIF: "GIF87a" or "GIF89a"
  if (
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(buf, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }

  // WebP: "RIFF" + 32-bit size + "WEBP"
  if (
    buf.length >= 12 &&
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buf.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }

  return null;
}

export function isAllowedImageMime(value: string): value is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Extension is derived from the *detected* MIME type, never the filename. */
export function extensionForMime(mime: AllowedImageMime): string {
  return EXTENSION_BY_MIME[mime];
}

/**
 * Normalises a user-supplied filename for display only.
 *
 * It is never used as a storage path. Directory separators are stripped by
 * keeping only the final path segment, any remaining unsafe character becomes
 * `_`, leading dots are neutralised, and the result is length-bounded.
 */
export function sanitizeOriginalFilename(name: unknown): string {
  const raw = typeof name === "string" ? name : "";
  const lastSegment = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[.]+/, "_")
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : "upload";
}

/**
 * Builds an unguessable, business-scoped object key.
 *
 * The key contains only the validated business id and a random UUID plus an
 * extension derived from the detected MIME type — no user-controlled text, so
 * traversal (`../`), double extensions and executable filenames are impossible.
 */
export function buildStorageKey(businessId: string, mime: AllowedImageMime): string {
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    throw new Error("Cannot build a storage key for an invalid business id");
  }
  return `media/${businessId.toLowerCase()}/${crypto.randomUUID()}${extensionForMime(mime)}`;
}

/** Trims alt text and enforces the stored maximum length. */
export function normalizeAltText(value: string): string {
  return value.trim().slice(0, 240);
}

export interface MediaRecordLike {
  _id: unknown;
  storageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  altText: string;
  createdAt: Date | string;
}

export interface MediaStorageUrl {
  /** Business id embedded in the object key (lower-cased for comparison). */
  businessId: string;
  /** Exact S3 object key named by the URL. */
  storageKey: string;
}

/**
 * Recognises a URL that points at this deployment's media bucket.
 *
 * Legacy/external image hosts return `null` and stay valid: only URLs under the
 * configured media public base URL (`S3_PUBLIC_URL` / `AWS_S3_PUBLIC_URL`) are treated as media-library references. That
 * lets the API enforce tenant ownership for platform media without breaking
 * existing product/storefront URLs from other hosts.
 */
export function parseMediaStorageUrl(
  value: string,
  publicBaseUrl: string | null | undefined,
): MediaStorageUrl | null {
  if (!value || !publicBaseUrl) return null;

  let url: URL;
  let base: URL;
  try {
    url = new URL(value);
    base = new URL(publicBaseUrl);
  } catch {
    return null;
  }

  if (url.origin !== base.origin) return null;

  // Compare pathnames, not raw strings, so a base with a trailing slash or a
  // CDN prefix (e.g. https://cdn.test/assets) is handled consistently.
  let path = url.pathname;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && basePath !== "/") {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
    path = path.slice(basePath.length);
  }
  path = path.replace(/^\/+/, "");

  const match = /^media\/([0-9a-f]{24})\/([^/]+)$/i.exec(path);
  if (!match) return null;

  return {
    businessId: match[1].toLowerCase(),
    storageKey: `media/${match[1]}/${match[2]}`,
  };
}

/**
 * Builds the public representation of a media record. The storage key is
 * intentionally omitted: clients only need the delivery URL, and the bucket
 * layout should not leak.
 */
export function toMediaDto(doc: MediaRecordLike, urlForKey: (key: string) => string) {
  return {
    id: String(doc._id),
    url: urlForKey(doc.storageKey),
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    size: doc.size,
    width: doc.width ?? null,
    height: doc.height ?? null,
    altText: doc.altText,
    createdAt: doc.createdAt,
  };
}

