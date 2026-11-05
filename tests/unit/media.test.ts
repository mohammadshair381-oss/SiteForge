import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_MAX_UPLOAD_BYTES } from "../../lib/media-client";

import {
  ALLOWED_IMAGE_MIME_TYPES,
  buildStorageKey,
  detectImageMime,
  extensionForMime,
  isAllowedImageMime,
  MAX_MEDIA_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  configuredMediaPublicBaseUrl,
  normalizeAltText,
  parseMediaStorageUrl,
  sanitizeOriginalFilename,
  toMediaDto,
  type AllowedImageMime,
} from "../../lib/media";
import { imageUrlSchema } from "../../lib/validation";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF87A = Buffer.from("GIF87a\x01\x00\x01\x00", "binary");
const GIF89A = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");
const WEBP = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "binary");

test("media: detects every allowed signature", () => {
  assert.equal(detectImageMime(JPEG), "image/jpeg");
  assert.equal(detectImageMime(PNG), "image/png");
  assert.equal(detectImageMime(GIF87A), "image/gif");
  assert.equal(detectImageMime(GIF89A), "image/gif");
  assert.equal(detectImageMime(WEBP), "image/webp");
});

test("media: rejects content that is not a raster image", () => {
  assert.equal(detectImageMime(Buffer.from("hello world, definitely not an image")), null);
  assert.equal(detectImageMime(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(detectImageMime(Buffer.from([0x25, 0x50, 0x44, 0x46])), null); // %PDF
  assert.equal(detectImageMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null); // MZ executable
  assert.equal(detectImageMime(Buffer.alloc(0)), null);
  assert.equal(detectImageMime(null), null);
  assert.equal(detectImageMime(undefined), null);
});

test("media: rejects truncated or look-alike signatures", () => {
  // First four PNG bytes only: the full 8-byte magic number is required.
  assert.equal(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  // "GIF8" without the version marker.
  assert.equal(detectImageMime(Buffer.from("GIF8xx", "binary")), null);
  // RIFF container that is not WebP (e.g. WAV).
  assert.equal(
    detectImageMime(Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "binary")),
    null,
  );
  // JPEG prefix with a non-image extension is still a JPEG by signature.
  assert.equal(detectImageMime(JPEG), "image/jpeg");
});

test("media: extension is derived from the detected MIME type", () => {
  assert.equal(extensionForMime("image/jpeg"), ".jpg");
  assert.equal(extensionForMime("image/png"), ".png");
  assert.equal(extensionForMime("image/webp"), ".webp");
  assert.equal(extensionForMime("image/gif"), ".gif");
});

test("media: only the four raster image types are allowed", () => {
  for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
    assert.equal(isAllowedImageMime(mime), true);
  }
  for (const mime of ["image/svg+xml", "text/html", "application/javascript", "image/bmp", ""]) {
    assert.equal(isAllowedImageMime(mime), false);
  }
});

test("media: filename sanitisation strips paths and unsafe characters", () => {
  assert.equal(sanitizeOriginalFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeOriginalFilename("..\\..\\windows\\system32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeOriginalFilename("../../evil.png"), "evil.png");
  assert.equal(sanitizeOriginalFilename("my photo (1).png"), "my_photo__1_.png");
  assert.equal(sanitizeOriginalFilename("../../"), "upload");
  assert.equal(sanitizeOriginalFilename(""), "upload");
  assert.equal(sanitizeOriginalFilename(undefined), "upload");
  // Leading dots cannot produce a hidden file name.
  assert.equal(sanitizeOriginalFilename(".env"), "_env");
  // Length is bounded.
  assert.equal(sanitizeOriginalFilename("a".repeat(500)).length, 200);
});

test("media: storage keys are business-scoped, random and extension-safe", () => {
  const businessId = "64b7f0c2a1b2c3d4e5f60712";
  const key = buildStorageKey(businessId, "image/png");

  assert.match(
    key,
    new RegExp(`^media/${businessId}/[0-9a-f-]{36}\\.png$`),
  );
  assert.equal(key.includes(".."), false);

  const other = buildStorageKey(businessId, "image/png");
  assert.notEqual(key, other, "keys must be unguessable per upload");
});

test("media: storage keys never embed user-controlled filename text", () => {
  const businessId = "64b7f0c2a1b2c3d4e5f60712";
  const key = buildStorageKey(businessId, "image/jpeg");
  assert.equal(key.endsWith(".jpg"), true);
  assert.equal(key.includes("passwd"), false);
  assert.equal(key.includes(" "), false);
});

test("media: storage keys reject malformed business ids", () => {
  for (const bad of ["../../etc", "not-an-id", "", "64b7f0c2a1b2c3d4e5f6071", "zzzzf0c2a1b2c3d4e5f60712"]) {
    assert.throws(() => buildStorageKey(bad, "image/png"), /invalid business id/i);
  }
});

test("media: alt text is trimmed and bounded", () => {
  assert.equal(normalizeAltText("  Product photo  "), "Product photo");
  assert.equal(normalizeAltText("a".repeat(400)).length, 240);
});

test("media: DTO exposes a delivery URL but not the storage key", () => {
  const dto = toMediaDto(
    {
      _id: "abc123",
      storageKey: "media/biz/secret-key.png",
      originalName: "photo.png",
      mimeType: "image/png",
      size: 1234,
      width: null,
      height: null,
      altText: "A photo",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    (key) => `https://cdn.example.com/${key}`,
  );

  assert.equal(dto.id, "abc123");
  assert.equal(dto.url, "https://cdn.example.com/media/biz/secret-key.png");
  assert.equal("storageKey" in dto, false);
  assert.equal(dto.width, null);
  assert.equal(dto.height, null);
  assert.equal(dto.altText, "A photo");
});

test("media: the upload cap is 4 MiB and stays under the 4.5 MB platform body limit", () => {
  assert.equal(MAX_MEDIA_BYTES, 4 * 1024 * 1024);
  // Even read as decimal megabytes, the largest accepted request fits.
  assert.ok(MAX_MEDIA_BYTES + MULTIPART_OVERHEAD_BYTES < 4_500_000);
});

test("media: client and server upload limits are identical", () => {
  assert.equal(MEDIA_MAX_UPLOAD_BYTES, MAX_MEDIA_BYTES);
});

test("media: public base URL prefers S3_PUBLIC_URL and falls back to AWS_S3_PUBLIC_URL", () => {
  assert.equal(
    configuredMediaPublicBaseUrl({ S3_PUBLIC_URL: "https://new.test", AWS_S3_PUBLIC_URL: "https://old.test" }),
    "https://new.test",
  );
  assert.equal(configuredMediaPublicBaseUrl({ AWS_S3_PUBLIC_URL: "https://old.test" }), "https://old.test");
  assert.equal(configuredMediaPublicBaseUrl({ S3_PUBLIC_URL: "  " }), undefined);
  assert.equal(configuredMediaPublicBaseUrl({}), undefined);
});

test("media: legacy https image URLs remain valid for products", () => {
  // Existing product/storefront data must keep validating unchanged.
  assert.equal(imageUrlSchema.safeParse("https://images.example.com/p/1.jpg").success, true);
  assert.equal(imageUrlSchema.safeParse("http://images.example.com/p/1.jpg").success, false);
  assert.equal(imageUrlSchema.safeParse("javascript:alert(1)").success, false);
});

test("media: only this deployment's bucket URLs are recognised as media references", () => {
  const base = "https://cdn.test";
  const businessId = "64b7f0c2a1b2c3d4e5f60712";
  const storageKey = `media/${businessId}/11111111-1111-1111-1111-111111111111.png`;

  assert.deepEqual(parseMediaStorageUrl(`${base}/${storageKey}`, base), {
    businessId,
    storageKey,
  });
  assert.deepEqual(parseMediaStorageUrl(`${base}/${storageKey}?v=2`, base), {
    businessId,
    storageKey,
  });

  // A CDN base with a path prefix works; a different host never does.
  assert.deepEqual(
    parseMediaStorageUrl(`https://cdn.test/assets/${storageKey}`, "https://cdn.test/assets/"),
    { businessId, storageKey },
  );
  assert.equal(
    parseMediaStorageUrl(`${base}/${storageKey}`, "https://other.test"),
    null,
  );
  assert.equal(parseMediaStorageUrl(`${base}/${storageKey}`, undefined), null);
  assert.equal(
    parseMediaStorageUrl("https://images.example.com/p/1.jpg", base),
    null,
  );
});

test("media: malformed or traversing bucket URLs are not media references", () => {
  const base = "https://cdn.test";
  const businessId = "64b7f0c2a1b2c3d4e5f60712";

  assert.equal(
    parseMediaStorageUrl(`${base}/media/not-a-business/x.png`, base),
    null,
  );
  assert.equal(
    parseMediaStorageUrl(`${base}/media/${businessId}/../secret.png`, base),
    null,
  );
  assert.equal(
    parseMediaStorageUrl(`${base}/media/${businessId}/nested/file.png`, base),
    null,
  );
  assert.equal(parseMediaStorageUrl("not a url", base), null);
  assert.equal(parseMediaStorageUrl(`${base}/media/${businessId}/x.png`, "not a url"), null);
});

test("media: type guard narrows to the allowlist", () => {
  const mime: AllowedImageMime = "image/webp";
  assert.equal(extensionForMime(mime), ".webp");
});
