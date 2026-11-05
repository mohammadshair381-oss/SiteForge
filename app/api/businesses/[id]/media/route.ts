import { runAfterResponse } from "@/lib/after-response";
import { dbConnect } from "@/lib/db";
import { handle, ok, created, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { Media } from "@/models/Media";
import { abandonUpload, cleanupMediaStorage } from "@/lib/media-cleanup";
import { LOCAL_MEDIA_ENABLED, mediaUrlFor, removeMediaObject, uploadMediaObject } from "@/lib/media-storage";
import { getS3PublicBaseUrl, storageErrorFrom } from "@/lib/s3";
import {
  buildStorageKey,
  detectImageMime,
  MAX_MEDIA_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  sanitizeOriginalFilename,
  toMediaDto,
} from "@/lib/media";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertStorageAvailable, getStorageUsage, withStorageCapacity } from "@/lib/usage-limits";

const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_MAX_PER_IP = 30;
const MEDIA_LIST_LIMIT = 500;
const PENDING_CLEANUP_LIMIT = 50;
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

/** How many interrupted uploads or unconfirmed removals opening a store's library tidies up at a time. */
const LISTING_CLEANUP_LIMIT = 5;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();

    const [items, total, pendingCleanup, storage] = await Promise.all([
      // A file still being uploaded is not in the library yet.
      Media.find({ business: id, deletedAt: null, uploadState: { $ne: "pending" } })
        .sort({ createdAt: -1, _id: -1 })
        .lean(),
      Media.countDocuments({ business: id, deletedAt: null, uploadState: { $ne: "pending" } }),
      Media.find({
        business: id,
        deletedAt: { $ne: null },
        storageDeletedAt: null,
      })
        .sort({ deletedAt: 1 })
        .limit(PENDING_CLEANUP_LIMIT)
        .lean(),
      getStorageUsage(id),
    ]);

    // Works without a scheduler: this store's interrupted uploads get finished off here.
    runAfterResponse(async () => void (await cleanupMediaStorage({ businessId: id, limit: LISTING_CLEANUP_LIMIT })), {
      operation: "media_cleanup",
      onError: () => console.error("[media] cleanup could not run"),
    });

    const urlForKey = (key: string) => mediaUrlFor(key, id);

    return ok({
      media: items.map((item) => toMediaDto(item, urlForKey)),
      pendingCleanup: pendingCleanup.map((item) => toMediaDto(item, urlForKey)),
      total,
      offset: 0,
      limit: DEFAULT_PAGE_SIZE,
      hasMore: items.length < total,
      storage,
    });
  });
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);

    // When local mode is enabled, skip the S3 public URL requirement;
    // otherwise validate as before so production remains fail-closed.
    if (!LOCAL_MEDIA_ENABLED) {
      getS3PublicBaseUrl();
    }

    await dbConnect();

    const ip = getClientIp(request);
    await enforceRateLimit({
      key: `media:upload:${id}:${ip ?? "shared"}`,
      windowMs: UPLOAD_WINDOW_MS,
      limit: UPLOAD_MAX_PER_IP,
    });

    // Cheap rejection before buffering a large multipart body into memory.
    const declaredLength = Number(request.headers.get("content-length") ?? "");
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_MEDIA_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
      throw new HttpError(
        413,
        `File too large (max ${MAX_MEDIA_BYTES} bytes)`,
        "file_too_large",
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "Invalid upload payload", "invalid_form");
    }

    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "No file uploaded", "no_file");

    if (file.size > MAX_MEDIA_BYTES) {
      throw new HttpError(
        413,
        `File too large (max ${MAX_MEDIA_BYTES} bytes)`,
        "file_too_large",
      );
    }
    if (file.size === 0) throw new HttpError(400, "Empty file", "empty_file");

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) {
      throw new HttpError(
        413,
        `File too large (max ${MAX_MEDIA_BYTES} bytes)`,
        "file_too_large",
      );
    }

    // The declared MIME type/filename are ignored: only the signature decides.
    const mimeType = detectImageMime(buf);
    if (!mimeType) {
      throw new HttpError(415, "Unsupported or invalid image type", "invalid_type");
    }

    await assertStorageAvailable(id, buf.length);

    const storageKey = buildStorageKey(id, mimeType);
    const originalName = sanitizeOriginalFilename(file.name);

    // The record first, in one step with the plan's check: its size is reserved before anything
    // is stored, so two uploads at once cannot both fit, and no file can exist without a record.
    const [record] = await withStorageCapacity(id, buf.length, (session) =>
      Media.create([{ business: id, storageKey, originalName, mimeType, size: buf.length, altText: "", uploadState: "pending" }], { session }),
    );

    try {
      await uploadMediaObject(storageKey, buf, mimeType);
    } catch (error) {
      await abandonUpload(record, error);
      throw storageErrorFrom(error);
    }

    let media;
    try {
      media = await Media.findOneAndUpdate({ _id: record._id, business: id, uploadState: "pending", deletedAt: null }, { $set: { uploadState: "ready" } }, { new: true });
    } catch (error) {
      // The record stays pending, so the cleanup finishes this if removing it here fails too.
      await removeMediaObject(storageKey).catch(() => console.error("[media] an uploaded file could not be removed yet"));
      throw error;
    }
    // Cleanup decided this upload had died. It removes the file, so this one reports the failure.
    if (!media) throw new HttpError(409, "That upload took too long and was cancelled. Please try again.", "upload_expired");

    return created({ media: toMediaDto(media, () => mediaUrlFor(storageKey, id)) });
  });
}