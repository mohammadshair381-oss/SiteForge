import { localMediaUrl, localRemove, localUpload } from "@/lib/local-storage";
import { legacyMediaUrlForKey, localMediaServable } from "@/lib/media";
import { s3Storage, storageErrorFrom } from "@/lib/s3";

/**
 * Where a media file lives (server-only). S3-compatible storage, or local files when
 * LOCAL_MEDIA_ENABLED is set outside production. Production always uses S3 and fails closed.
 */
export const LOCAL_MEDIA_ENABLED = localMediaServable();

export const mediaUrlFor = (storageKey: string, businessId: string) => (LOCAL_MEDIA_ENABLED ? localMediaUrl(storageKey, businessId) : s3Storage.publicUrl(storageKey));

/** Every address a stored reference could use for this file, during a storage migration too. */
export function mediaUrlForms(storageKey: string, businessId: string): string[] {
  const legacy = LOCAL_MEDIA_ENABLED ? undefined : legacyMediaUrlForKey(storageKey);
  return legacy ? [mediaUrlFor(storageKey, businessId), legacy] : [mediaUrlFor(storageKey, businessId)];
}

export async function uploadMediaObject(storageKey: string, body: Buffer, mimeType: string): Promise<void> {
  if (LOCAL_MEDIA_ENABLED) await localUpload(storageKey, body, mimeType);
  else await s3Storage.upload(storageKey, body, mimeType);
}

/** Idempotent: removing a file that is not there succeeds. Throws if storage did not confirm it. */
export async function removeMediaObject(storageKey: string): Promise<void> {
  try {
    if (LOCAL_MEDIA_ENABLED) await localRemove(storageKey);
    else await s3Storage.remove(storageKey);
  } catch (error) {
    throw storageErrorFrom(error);
  }
}
