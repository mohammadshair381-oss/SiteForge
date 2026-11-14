import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  configuredLegacyMediaPublicBaseUrl,
  legacyMediaUrlForKey,
  mediaPublicBaseUrls,
  normalizeMediaPublicBaseUrl,
  parseMediaStorageUrlFromBases,
} from "../../backend/lib/media";

/** Optional legacy media base URL for an AWS S3 -> R2 migration (pure). */

const BIZ_A = "0123456789abcdef01234567";
const BIZ_B = "fedcba9876543210fedcba98";
const CURRENT = "https://pub-123.r2.dev";
const LEGACY = "https://old-bucket.s3.us-east-1.amazonaws.com";

function silenced<T>(fn: () => T): { value: T; logs: string } {
  const lines: string[] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    return { value: fn(), logs: lines.join("\n") };
  } finally {
    spy.mock.restore();
  }
}

test("base URLs are normalised and validated consistently", () => {
  assert.equal(normalizeMediaPublicBaseUrl("https://cdn.test/"), "https://cdn.test");
  assert.equal(normalizeMediaPublicBaseUrl("  https://CDN.test/assets//  "), "https://cdn.test/assets");
  for (const bad of [
    "",
    "not a url",
    "ftp://cdn.test",
    "https://user:pw@cdn.test",
    "https://cdn.test/?q=1",
    "https://cdn.test/#x",
  ]) {
    assert.equal(normalizeMediaPublicBaseUrl(bad), null, bad);
  }
});

test("the legacy base is honoured only alongside a current base and when distinct", () => {
  assert.equal(
    configuredLegacyMediaPublicBaseUrl({ S3_PUBLIC_URL: CURRENT, S3_LEGACY_PUBLIC_URL: `${LEGACY}/` }),
    LEGACY,
  );
  // Local-disk mode (no current base): legacy is ignored, local parsing stays.
  assert.equal(configuredLegacyMediaPublicBaseUrl({ S3_LEGACY_PUBLIC_URL: LEGACY }), undefined);
  // Identical to the current base: nothing extra to check.
  assert.equal(
    configuredLegacyMediaPublicBaseUrl({ S3_PUBLIC_URL: `${CURRENT}/`, S3_LEGACY_PUBLIC_URL: CURRENT }),
    undefined,
  );
  assert.deepEqual(mediaPublicBaseUrls({ S3_PUBLIC_URL: CURRENT, S3_LEGACY_PUBLIC_URL: LEGACY }), [CURRENT, LEGACY]);
  assert.deepEqual(mediaPublicBaseUrls({ S3_PUBLIC_URL: CURRENT }), [CURRENT]);
  assert.deepEqual(mediaPublicBaseUrls({}), []);
});

test("an invalid legacy base is ignored and logged by variable name only", () => {
  const secretish = "https://user:hunter2@old.example.com";
  const { value, logs } = silenced(() =>
    configuredLegacyMediaPublicBaseUrl({ S3_PUBLIC_URL: CURRENT, S3_LEGACY_PUBLIC_URL: secretish }),
  );
  assert.equal(value, undefined);
  assert.match(logs, /S3_LEGACY_PUBLIC_URL/);
  assert.equal(logs.includes("hunter2"), false);
});

test("current and legacy URLs both parse to the same tenant-scoped storage key", () => {
  const bases = [CURRENT, LEGACY];
  const key = `media/${BIZ_A}/photo.png`;
  assert.deepEqual(parseMediaStorageUrlFromBases(`${CURRENT}/${key}`, bases), {
    businessId: BIZ_A,
    storageKey: key,
  });
  assert.deepEqual(parseMediaStorageUrlFromBases(`${LEGACY}/${key}`, bases), {
    businessId: BIZ_A,
    storageKey: key,
  });
  // Another tenant's key keeps its own business id, so the ownership check
  // (business id + Media record) rejects it for tenant A.
  assert.equal(
    parseMediaStorageUrlFromBases(`${LEGACY}/media/${BIZ_B}/x.png`, bases)?.businessId,
    BIZ_B,
  );
});

test("external URLs are not platform media (unchanged behaviour)", () => {
  const bases = [CURRENT, LEGACY];
  assert.equal(parseMediaStorageUrlFromBases(`https://images.example.com/media/${BIZ_A}/x.png`, bases), null);
  // Look-alike hosts and path tricks do not match the configured origins.
  assert.equal(parseMediaStorageUrlFromBases(`https://old-bucket.s3.us-east-1.amazonaws.com.evil.test/media/${BIZ_A}/x.png`, bases), null);
  assert.equal(parseMediaStorageUrlFromBases(`${LEGACY}/media/${BIZ_A}/nested/x.png`, bases), null);
  assert.equal(parseMediaStorageUrlFromBases("not a url", bases), null);
});

test("the legacy URL form of a key is built only when a legacy base is configured", () => {
  const key = `media/${BIZ_A}/photo.png`;
  assert.equal(
    legacyMediaUrlForKey(key, { S3_PUBLIC_URL: CURRENT, S3_LEGACY_PUBLIC_URL: LEGACY }),
    `${LEGACY}/${key}`,
  );
  assert.equal(legacyMediaUrlForKey(key, { S3_PUBLIC_URL: CURRENT }), undefined);
});
