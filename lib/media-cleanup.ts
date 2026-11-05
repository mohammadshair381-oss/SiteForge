import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { countMediaReferences } from "@/lib/media-references";
import { mediaUrlForms, removeMediaObject } from "@/lib/media-storage";
import type { ScheduledRunCounts } from "@/lib/scheduled-jobs";
import { Media } from "@/models/Media";

/**
 * Finishing what an upload or a deletion left undone (server-only).
 *
 * Every file gets its Media record BEFORE it is uploaded, so no file can exist without one, and
 * its size is reserved against the plan from that moment. A record still `pending` an hour later
 * means the upload never finished; a deleted one with no `storageDeletedAt` means storage did not
 * confirm the removal. Both are retried here. A file anything still refers to is never removed.
 */
const STALE_MS = 60 * 60 * 1000;

/** After an upload failed: removes whatever may have been written, and says if that failed too. */
export async function abandonUpload(record: { _id: unknown; storageKey: string }, error: unknown, now: Date = new Date()): Promise<void> {
  // A failed upload is ambiguous: the object may have been written before the response was lost.
  const neverStored = error instanceof HttpError && error.code === "storage_unavailable";
  try {
    if (!neverStored) await removeMediaObject(record.storageKey);
    await Media.updateOne({ _id: record._id }, { $set: { uploadState: "failed", deletedAt: now, storageDeletedAt: now } });
  } catch {
    // Left in the owner's "needs removing" list, and retried by the cleanup below.
    console.error("[media] a failed upload could not be cleaned up yet");
    await Media.updateOne({ _id: record._id }, { $set: { uploadState: "failed", deletedAt: now } }).catch(() => undefined);
  }
}

export async function cleanupMediaStorage(input: { limit: number; businessId?: string; timeBudgetMs?: number; now?: Date }): Promise<ScheduledRunCounts> {
  await dbConnect();
  const now = input.now ?? new Date();
  const started = Date.now();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const rows = await Media.find({
    ...(input.businessId ? { business: input.businessId } : {}),
    storageDeletedAt: null,
    $or: [
      { deletedAt: null, uploadState: "pending", createdAt: { $lte: staleBefore } },
      { deletedAt: { $ne: null, $lte: staleBefore } },
    ],
  })
    // Ones not tried yet come first, so a few that keep failing cannot block the rest.
    .sort({ cleanupAttemptedAt: 1, createdAt: 1 })
    .limit(input.limit)
    .select("business storageKey deletedAt uploadState")
    .lean();

  const counts: ScheduledRunCounts = { checked: 0, changed: 0, failed: 0, skipped: 0, stoppedEarly: false };
  for (const row of rows) {
    if (input.timeBudgetMs && Date.now() - started > input.timeBudgetMs) {
      counts.stoppedEarly = true;
      break;
    }
    counts.checked += 1;
    const businessId = String(row.business);
    try {
      const references = await countMediaReferences(businessId, mediaUrlForms(row.storageKey, businessId));
      if (references.total > 0) {
        counts.skipped += 1;
        await Media.updateOne({ _id: row._id }, { $set: { cleanupAttemptedAt: now } });
        continue;
      }
      if (!row.deletedAt) {
        // Conditional, so an upload that finishes at this moment keeps its file or loses cleanly.
        const claimed = await Media.updateOne({ _id: row._id, uploadState: "pending", deletedAt: null }, { $set: { uploadState: "failed", deletedAt: now } });
        if (claimed.modifiedCount !== 1) {
          counts.skipped += 1;
          continue;
        }
      }
      await removeMediaObject(row.storageKey);
      await Media.updateOne({ _id: row._id }, { $set: { storageDeletedAt: now, cleanupAttemptedAt: now } });
      counts.changed += 1;
    } catch {
      counts.failed += 1;
      console.error("[media] a file could not be cleaned up yet");
      await Media.updateOne({ _id: row._id }, { $set: { cleanupAttemptedAt: now } }).catch(() => undefined);
    }
  }
  return counts;
}
