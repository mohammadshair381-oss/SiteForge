/**
 * Client-safe helpers for the media library.
 *
 * This module must stay free of `node:*`, Mongoose and `next/server` imports so
 * it can be bundled into the browser. The server remains the authority for
 * upload validation (`lib/media.ts` + the media API); these helpers only give
 * immediate feedback and turn API error codes into plain-language messages.
 */

export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const MEDIA_ACCEPT_ATTRIBUTE = ACCEPTED_IMAGE_TYPES.join(",");

/** Kept in sync with `MAX_MEDIA_BYTES`; the server enforces the real limit. */
export const MEDIA_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ALLOWED_TYPE_SET = new Set<string>(ACCEPTED_IMAGE_TYPES);
const ALLOWED_EXTENSION = /\.(jpe?g|png|webp|gif)$/i;

export interface UploadCandidate {
  name: string;
  type: string;
  size: number;
}

/** A row from `GET /api/businesses/[id]/media`, restricted to safe fields. */
export interface MediaItem {
  id: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
  altText: string;
  createdAt: string;
}

function toMediaItem(value: unknown): MediaItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.url !== "string" ||
    typeof item.originalName !== "string" ||
    typeof item.mimeType !== "string" ||
    typeof item.size !== "number" ||
    typeof item.altText !== "string" ||
    typeof item.createdAt !== "string"
  ) {
    return null;
  }

  // Rebuild the object instead of returning the API value, so unknown fields
  // (e.g. a leaked storage key) never enter component state or the DOM.
  return {
    id: item.id,
    url: item.url,
    originalName: item.originalName,
    mimeType: item.mimeType,
    size: item.size,
    altText: item.altText,
    createdAt: item.createdAt,
  };
}

/** Parses one media DTO (used for upload and alt-text responses). */
export function parseMediaItem(payload: unknown): MediaItem | null {
  if (typeof payload !== "object" || payload === null) return null;
  return toMediaItem((payload as { media?: unknown }).media);
}

/** Parses the list response, dropping malformed rows; `null` means malformed. */
export function parseMediaList(payload: unknown): MediaItem[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const media = (payload as { media?: unknown }).media;
  if (!Array.isArray(media)) return null;
  return media.flatMap((item) => {
    const parsed = toMediaItem(item);
    return parsed ? [parsed] : [];
  });
}

/**
 * Parses the optional pending-cleanup rows. These are soft-deleted media whose
 * S3 object could not be removed yet; they must never be shown as normal
 * library items or offered in the picker.
 */
export function parsePendingCleanup(payload: unknown): MediaItem[] {
  if (typeof payload !== "object" || payload === null) return [];
  const pending = (payload as { pendingCleanup?: unknown }).pendingCleanup;
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((item) => {
    const parsed = toMediaItem(item);
    return parsed ? [parsed] : [];
  });
}

/** Splits a selection into uploadable files and user-facing problems. */
export function planUploadFiles<T extends UploadCandidate>(
  files: T[],
): { accepted: T[]; problems: string[] } {
  const accepted: T[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const problem = validateUploadFile(file);
    if (problem) problems.push(`${file.name}: ${problem}`);
    else accepted.push(file);
  }
  return { accepted, problems };
}

/** Newest-first ordering, matching the server's list order. */
export function sortMediaNewestFirst(items: MediaItem[]): MediaItem[] {
  // `.sort()` on a copy rather than `.toSorted()`: the app supports browsers
  // that predate the ES2023 array helpers.
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Deduplicates by id and keeps the newest copy of a row after a refresh. */
export function mergeMediaItems(
  current: MediaItem[],
  incoming: MediaItem[],
): MediaItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return sortMediaNewestFirst(Array.from(byId.values()));
}

/**
 * Case-insensitive media picker search. Matches the filename and the alt text
 * so owners can find an image either way; an empty query keeps the full list.
 */
export function filterMediaItems(items: MediaItem[], query: string): MediaItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) =>
      item.originalName.toLowerCase().includes(needle) ||
      item.altText.toLowerCase().includes(needle),
  );
}

/**
 * Returns a user-facing problem description, or `null` when the file is
 * acceptable. A missing MIME type falls back to the extension because some
 * browsers leave `File.type` empty; the server still verifies the signature.
 */
export function validateUploadFile(file: UploadCandidate): string | null {
  // Some browsers report an empty or generic MIME type for a valid image; fall
  // back to the extension in that case. A specific non-image type (e.g. SVG or
  // PDF) is always rejected here, and the server checks the bytes anyway.
  const hasSpecificType =
    file.type.length > 0 && file.type !== "application/octet-stream";

  if (hasSpecificType) {
    if (!ALLOWED_TYPE_SET.has(file.type)) {
      return "Choose a JPEG, PNG, WebP or GIF image.";
    }
  } else if (!ALLOWED_EXTENSION.test(file.name)) {
    return "Choose a JPEG, PNG, WebP or GIF image.";
  }

  if (file.size <= 0) return "That file is empty.";
  if (file.size > MEDIA_MAX_UPLOAD_BYTES) {
    return "Images must be 4 MB or smaller.";
  }
  return null;
}

export type MediaErrorContext = "load" | "upload" | "save" | "delete";

function errorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Maps an API error payload to a message a business owner can act on.
 * Unknown payloads use the caller's fallback rather than echoing server text,
 * so internal messages never leak into the interface.
 */
export function mediaErrorMessage(
  context: MediaErrorContext,
  payload: unknown,
  fallback: string,
): string {
  const code = errorCode(payload);

  switch (code) {
    case "storage_unavailable":
      return "Image storage isn't set up yet. Ask your platform administrator to finish the setup.";
    case "storage_error":
      return context === "delete"
        ? "The image is hidden, but the file host didn't confirm deletion. Try again to finish removing it."
        : "The image host didn't respond. Try again in a moment.";
    case "file_too_large":
      return "That image is larger than 4 MB.";
    case "transactions_unavailable":
      return "This could not be saved because of a problem with the platform's database setup. Nothing was changed.";
    case "storage_limit_reached":
      return "Your plan's media storage is full. Delete images you no longer need, or upgrade to upload more.";
    case "invalid_type":
      return "Only JPEG, PNG, WebP and GIF images are accepted.";
    case "empty_file":
      return "That file is empty.";
    case "no_file":
    case "invalid_form":
      return "The upload couldn't be read. Choose the file again.";
    case "rate_limited":
      return "Too many uploads in a short time. Wait a few minutes and try again.";
    case "unauthenticated":
    case "session_revoked":
      return "Your session has ended. Sign in again and retry.";
    case "forbidden":
      return "You don't have permission to change this business's media.";
    case "not_found":
      return context === "delete"
        ? "That image was already removed."
        : "That image could not be found.";
    case "validation_error":
      return context === "save"
        ? "Alt text must be 240 characters or fewer."
        : fallback;
    default:
      return fallback;
  }
}

export interface MediaStorage {
  usedBytes: number;
  /** null = no limit on this plan. */
  limitBytes: number | null;
}

export function parseMediaStorage(payload: unknown): MediaStorage | null {
  const storage = (payload as { storage?: { usedBytes?: unknown; limitBytes?: unknown } } | null)?.storage;
  if (!storage || typeof storage.usedBytes !== "number") return null;
  return { usedBytes: storage.usedBytes, limitBytes: typeof storage.limitBytes === "number" ? storage.limitBytes : null };
}

/** Why an image cannot be deleted, from the server's reference counts. */
export function mediaInUseMessage(payload: unknown): string {
  const references = (payload as { references?: { products?: number; pages?: number; business?: number; orders?: number; categories?: number } } | null)?.references;
  const count = (value: number | undefined, name: string) => (value ? [`${value} ${name}${value === 1 ? "" : "s"}`] : []);
  const parts = [
    ...count(references?.products, "product"),
    ...count(references?.pages, "page"),
    ...count(references?.categories, "category").map((text) => text.replace("categorys", "categories")),
    ...(references?.business ? ["your store's settings or homepage"] : []),
  ];
  const orders = references?.orders ?? 0;
  if (parts.length === 0 && orders > 0) {
    return `This image appears in the history of ${orders} order${orders === 1 ? "" : "s"}, so it is kept for those records.`;
  }
  const history = orders > 0 ? ` It also appears in the history of ${orders} order${orders === 1 ? "" : "s"}, so it is kept for those records.` : " Remove it from those places first.";
  return parts.length > 0 ? `This image is still used by ${parts.join(", ")}.${history}` : "This image is still used by your storefront. Remove it from those places first.";
}

/** Short label for the corner badge on a preview. */
export function mediaTypeLabel(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "JPEG";
    case "image/png":
      return "PNG";
    case "image/webp":
      return "WebP";
    case "image/gif":
      return "GIF";
    default:
      return "Image";
  }
}

/** Compact, locale-independent byte formatting (avoids hydration mismatches). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
}

/** Deterministic date text so server-rendered and hydrated markup agree. */
export function formatMediaDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}


export interface MediaPagination {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export function parseMediaPagination(payload: unknown): MediaPagination {
  if (typeof payload !== "object" || payload === null) {
    return { total: 0, offset: 0, limit: 0, hasMore: false };
  }
  const data = payload as Record<string, unknown>;
  return {
    total: typeof data.total === "number" ? data.total : 0,
    offset: typeof data.offset === "number" ? data.offset : 0,
    limit: typeof data.limit === "number" ? data.limit : 0,
    hasMore: typeof data.hasMore === "boolean" ? data.hasMore : false,
  };
}
