import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertBusinessNotSuspended } from "@/lib/publish-gates";
import { assertObjectId } from "@/lib/ids";
import { Media } from "@/models/Media";
import { mediaUrlFor, mediaUrlForms, removeMediaObject } from "@/lib/media-storage";
import { normalizeAltText, toMediaDto } from "@/lib/media";
import type { MediaReferenceCounts } from "@/lib/media-references";
import { mediaUpdateSchema } from "@/lib/validation";
import { countMediaReferences } from "@/lib/media-references";
import { NextResponse } from "next/server";

interface RouteContext {
  params: Promise<{ id: string; mediaId: string }>;
}

const inUse = (references: MediaReferenceCounts) =>
  NextResponse.json(
    { error: "This image is still used by your storefront or order history. Remove it from those places before deleting it.", code: "media_in_use", references },
    { status: 409 },
  );

export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, mediaId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const mediaObjectId = assertObjectId(mediaId, "media id");
    await dbConnect();

    const body = mediaUpdateSchema.parse(await readJson(request));

    const media = await Media.findOne({
      _id: mediaObjectId,
      business: id,
      deletedAt: null,
      uploadState: { $ne: "pending" },
    });
    if (!media) throw new HttpError(404, "Media not found", "not_found");

    media.altText = normalizeAltText(body.altText);
    await media.save();

    return ok({ media: toMediaDto(media, (key) => mediaUrlFor(key, id)) });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, mediaId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const mediaObjectId = assertObjectId(mediaId, "media id");
    await dbConnect();
    await assertBusinessNotSuspended(id);

    // Scoped to the tenant: another business's id can never match here.
    const media = await Media.findOne({ _id: mediaObjectId, business: id });
    if (!media) throw new HttpError(404, "Media not found", "not_found");

    // Already fully removed (metadata tombstone + confirmed delete).
    if (media.deletedAt && media.storageDeletedAt) {
      throw new HttpError(404, "Media not found", "not_found");
    }

    // Every address the file could be stored under, during a storage migration too.
    const urls = mediaUrlForms(media.storageKey, id);

    // Check if this media is still referenced elsewhere before deleting.
    const references = await countMediaReferences(id, urls);
    if (references.total > 0) return inUse(references);

    // Claim the deletion first so listings hide it immediately and a retry after
    // a file removal failure is possible instead of losing the record.
    if (!media.deletedAt) {
      media.deletedAt = new Date();
      await media.save();
      // Something may have started using it just before it was hidden. Pickers no longer
      // offer it now, so a second look settles it: a file in use is never removed.
      const again = await countMediaReferences(id, urls);
      if (again.total > 0) {
        media.deletedAt = null;
        await media.save();
        return inUse(again);
      }
    }

    // Throws when storage does not confirm it. The record stays without `storageDeletedAt`,
    // so the owner can retry the same DELETE, and the cleanup job tries again too.
    await removeMediaObject(media.storageKey);

    media.storageDeletedAt = new Date();
    await media.save();

    return ok({ deleted: true, storageDeleted: true });
  });
}
