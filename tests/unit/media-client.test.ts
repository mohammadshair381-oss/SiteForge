import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTED_IMAGE_TYPES,
  MEDIA_ACCEPT_ATTRIBUTE,
  MEDIA_MAX_UPLOAD_BYTES,
  filterMediaItems,
  formatBytes,
  formatMediaDate,
  mediaErrorMessage,
  mediaTypeLabel,
  mergeMediaItems,
  parseMediaItem,
  parseMediaList,
  parsePendingCleanup,
  planUploadFiles,
  validateUploadFile,
  type MediaItem,
} from "../../lib/media-client";

test("media client: accepts exactly the four raster image types", () => {
  assert.deepEqual([...ACCEPTED_IMAGE_TYPES], [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
  ]);
  assert.equal(
    MEDIA_ACCEPT_ATTRIBUTE,
    "image/jpeg,image/png,image/webp,image/gif",
  );

  for (const type of ACCEPTED_IMAGE_TYPES) {
    assert.equal(
      validateUploadFile({ name: "photo.bin", type, size: 1024 }),
      null,
      `${type} should be accepted`,
    );
  }
});

test("media client: rejects non-image and malformed selections", () => {
  assert.match(
    validateUploadFile({ name: "logo.svg", type: "image/svg+xml", size: 200 }) ?? "",
    /JPEG, PNG, WebP or GIF/,
  );
  assert.match(
    validateUploadFile({ name: "doc.pdf", type: "application/pdf", size: 200 }) ?? "",
    /JPEG, PNG, WebP or GIF/,
  );
  assert.match(
    validateUploadFile({ name: "empty.png", type: "image/png", size: 0 }) ?? "",
    /empty/i,
  );
  assert.match(
    validateUploadFile({ name: "huge.png", type: "image/png", size: MEDIA_MAX_UPLOAD_BYTES + 1 }) ?? "",
    /4 MB or smaller/,
  );
});

test("media client: the 4 MiB boundary is inclusive", () => {
  assert.equal(MEDIA_MAX_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.equal(
    validateUploadFile({
      name: "limit.png",
      type: "image/png",
      size: MEDIA_MAX_UPLOAD_BYTES,
    }),
    null,
  );
});

test("media client: falls back to the filename when the MIME type is generic", () => {
  // Windows/older browsers sometimes leave File.type empty or generic.
  assert.equal(
    validateUploadFile({ name: "Product Photo.PNG", type: "", size: 100 }),
    null,
  );
  assert.equal(
    validateUploadFile({
      name: "banner.webp",
      type: "application/octet-stream",
      size: 100,
    }),
    null,
  );
  // A specific non-image type is never rescued by a misleading extension.
  assert.match(
    validateUploadFile({
      name: "fake.png",
      type: "image/svg+xml",
      size: 100,
    }) ?? "",
    /JPEG, PNG, WebP or GIF/,
  );
  assert.match(
    validateUploadFile({ name: "script.exe", type: "", size: 100 }) ?? "",
    /JPEG, PNG, WebP or GIF/,
  );
});

test("media client: maps API error codes to actionable messages", () => {
  const fallback = "fallback message";

  for (const context of ["load", "upload", "save", "delete"] as const) {
    assert.match(
      mediaErrorMessage(context, { code: "storage_unavailable" }, fallback),
      /isn't set up yet/,
    );
    assert.match(
      mediaErrorMessage(context, { code: "storage_error" }, fallback),
      /host didn't respond|didn't confirm deletion/,
    );
  }

  assert.match(
    mediaErrorMessage("upload", { code: "storage_error" }, fallback),
    /didn't respond/,
  );
  assert.match(
    mediaErrorMessage("delete", { code: "storage_error" }, fallback),
    /Try again to finish removing it/,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "file_too_large" }, fallback),
    /larger than 4 MB/,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "invalid_type" }, fallback),
    /Only JPEG, PNG, WebP and GIF/,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "empty_file" }, fallback),
    /empty/i,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "no_file" }, fallback),
    /choose the file again/i,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "invalid_form" }, fallback),
    /choose the file again/i,
  );
  assert.match(
    mediaErrorMessage("upload", { code: "rate_limited" }, fallback),
    /Too many uploads/,
  );
  assert.match(
    mediaErrorMessage("load", { code: "unauthenticated" }, fallback),
    /session has ended/i,
  );
  assert.match(
    mediaErrorMessage("load", { code: "session_revoked" }, fallback),
    /session has ended/i,
  );
  assert.match(
    mediaErrorMessage("delete", { code: "forbidden" }, fallback),
    /don't have permission/,
  );
  assert.match(
    mediaErrorMessage("delete", { code: "not_found" }, fallback),
    /already removed/,
  );
  assert.match(
    mediaErrorMessage("load", { code: "not_found" }, fallback),
    /could not be found/,
  );
  assert.match(
    mediaErrorMessage("save", { code: "validation_error" }, fallback),
    /240 characters or fewer/,
  );
  assert.equal(
    mediaErrorMessage("upload", { code: "validation_error" }, fallback),
    fallback,
  );
});

test("media client: unknown or malformed payloads use the fallback", () => {
  assert.equal(mediaErrorMessage("load", null, "try again"), "try again");
  assert.equal(mediaErrorMessage("load", undefined, "try again"), "try again");
  assert.equal(mediaErrorMessage("load", "oops", "try again"), "try again");
  assert.equal(mediaErrorMessage("load", {}, "try again"), "try again");
  assert.equal(
    mediaErrorMessage("load", { code: "internal_error", error: "stack trace" }, "try again"),
    "try again",
  );
});

test("media client: type labels are short and human readable", () => {
  assert.equal(mediaTypeLabel("image/jpeg"), "JPEG");
  assert.equal(mediaTypeLabel("image/png"), "PNG");
  assert.equal(mediaTypeLabel("image/webp"), "WebP");
  assert.equal(mediaTypeLabel("image/gif"), "GIF");
  assert.equal(mediaTypeLabel("image/avif"), "Image");
});

test("media client: byte formatting stays compact", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(-4), "0 KB");
  assert.equal(formatBytes(Number.NaN), "0 KB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024), "10 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(15 * 1024 * 1024), "15 MB");
});

test("media client: dates are deterministic across server and browser", () => {
  assert.equal(formatMediaDate("2026-01-05T23:30:00.000Z"), "Jan 5, 2026");
  assert.equal(
    formatMediaDate(new Date("2026-12-31T00:00:00.000Z")),
    "Dec 31, 2026",
  );
  assert.equal(formatMediaDate("not-a-date"), "");
});

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "64b7f0c2a1b2c3d4e5f60712",
    url: "https://cdn.test/media/a.png",
    originalName: "a.png",
    mimeType: "image/png",
    size: 1536,
    altText: "A",
    createdAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

test("media client: parses list responses into a safe shape", () => {
  const parsed = parseMediaList({
    media: [
      {
        ...mediaItem(),
        storageKey: "media/business/secret.png",
        width: null,
        height: null,
      },
    ],
  });

  assert.ok(parsed);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], mediaItem());
  assert.equal("storageKey" in parsed[0], false);
  assert.equal("width" in parsed[0], false);
});

test("media client: drops malformed rows but keeps valid ones", () => {
  const parsed = parseMediaList({
    media: [
      mediaItem(),
      { id: "missing-fields" },
      null,
      mediaItem({ id: "second", originalName: "b.jpg", mimeType: "image/jpeg" }),
    ],
  });

  assert.ok(parsed);
  assert.deepEqual(
    parsed.map((item) => item.id),
    ["64b7f0c2a1b2c3d4e5f60712", "second"],
  );
});

test("media client: a non-list payload is rejected instead of guessed", () => {
  assert.equal(parseMediaList(null), null);
  assert.equal(parseMediaList({}), null);
  assert.equal(parseMediaList({ media: "nope" }), null);
  assert.deepEqual(parseMediaList({ media: [] }), []);
});

test("media client: parses single media responses", () => {
  assert.deepEqual(
    parseMediaItem({ media: { ...mediaItem(), storageKey: "secret" } }),
    mediaItem(),
  );
  assert.equal(parseMediaItem({ media: { id: "x" } }), null);
  assert.equal(parseMediaItem(null), null);
});

test("media client: pending cleanup rows are parsed separately and safely", () => {
  const pending = mediaItem({
    id: "pending",
    originalName: "removed.png",
  });

  assert.deepEqual(
    parsePendingCleanup({
      pendingCleanup: [
        { ...pending, storageKey: "media/business/secret.png" },
        { id: "malformed" },
      ],
    }),
    [pending],
  );
  assert.deepEqual(parsePendingCleanup({ media: [pending] }), []);
  assert.deepEqual(parsePendingCleanup(null), []);
});

test("media client: plans a multi-file upload and reports rejects", () => {
  const good = { name: "one.png", type: "image/png", size: 100 };
  const alsoGood = { name: "two.webp", type: "image/webp", size: 200 };
  const bad = { name: "notes.txt", type: "text/plain", size: 10 };

  const plan = planUploadFiles([good, bad, alsoGood]);

  assert.deepEqual(plan.accepted, [good, alsoGood]);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /^notes\.txt: /);
  assert.match(plan.problems[0], /JPEG, PNG, WebP or GIF/);
});

test("media client: merges refreshed rows without duplicates or mutation", () => {
  const older = mediaItem({
    id: "older",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const newer = mediaItem({
    id: "newer",
    createdAt: "2026-02-01T00:00:00.000Z",
    altText: "old alt",
  });
  const current = [older, newer];

  const merged = mergeMediaItems(current, [
    { ...newer, altText: "new alt" },
    mediaItem({ id: "newest", createdAt: "2026-03-01T00:00:00.000Z" }),
  ]);

  assert.deepEqual(
    merged.map((item) => item.id),
    ["newest", "newer", "older"],
  );
  assert.equal(merged.find((item) => item.id === "newer")?.altText, "new alt");
  assert.equal(newer.altText, "old alt", "the input array must not be mutated");
  assert.equal(current.length, 2);
  assert.equal(current[1], newer);
});

test("media client: picker search matches filenames and alt text", () => {
  const mug = mediaItem({
    id: "mug",
    originalName: "Blue Mug.PNG",
    altText: "Ceramic mug on a desk",
  });
  const banner = mediaItem({
    id: "banner",
    originalName: "summer-banner.jpg",
    altText: "Sale announcement",
  });
  const items = [mug, banner];

  assert.deepEqual(
    filterMediaItems(items, "").map((item) => item.id),
    ["mug", "banner"],
  );
  assert.deepEqual(
    filterMediaItems(items, "  ").map((item) => item.id),
    ["mug", "banner"],
  );
  assert.deepEqual(
    filterMediaItems(items, "mug").map((item) => item.id),
    ["mug"],
    "filename match is case-insensitive",
  );
  assert.deepEqual(
    filterMediaItems(items, "SALE").map((item) => item.id),
    ["banner"],
    "alt-text match is case-insensitive",
  );
  assert.deepEqual(filterMediaItems(items, "missing"), []);
  assert.equal(items.length, 2, "the input list is not mutated");
});
