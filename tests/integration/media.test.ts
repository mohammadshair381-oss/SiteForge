import assert from "node:assert/strict";
import test, { before, after, beforeEach, afterEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { Membership } from "@/models/Membership";
import { Media } from "@/models/Media";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import { s3Storage } from "@/lib/s3";
import { GET as mediaGET, POST as mediaPOST } from "@/app/api/businesses/[id]/media/route";
import {
  PATCH as mediaPATCH,
  DELETE as mediaDELETE,
} from "@/app/api/businesses/[id]/media/[mediaId]/route";

const BASE = "http://localhost";
const PUBLIC_BASE = "https://cdn.test";
process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "binary");
const WEBP_BYTES = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "binary");

let uploadMock: ReturnType<typeof mock.method>;
let removeMock: ReturnType<typeof mock.method>;

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});

after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
  // Real AWS is never contacted in tests.
  uploadMock = mock.method(s3Storage, "upload", async () => undefined);
  removeMock = mock.method(s3Storage, "remove", async () => undefined);
});

afterEach(() => {
  mock.restoreAll();
});

async function setupBusiness(options: {
  email: string;
  slug: string;
  role?: "owner" | "staff";
  ownerId?: unknown;
}) {
  const user = await createUser({ email: options.email, name: options.slug });

  const business = await Business.create({
    name: options.slug,
    slug: options.slug,
    subdomain: options.slug,
    category: "retail",
    owner: options.ownerId ?? user._id,
    description: "desc",
  });

  await Membership.create({
    business: business._id,
    user: user._id,
    role: options.role ?? "owner",
    status: "active",
  });

  const headers = await createAuthHeadersForUser(
    String(user._id),
    "user",
    user.tokenVersion,
  );

  return { user, business, headers };
}

function ctx(id: string, mediaId = ""): { params: Promise<{ id: string; mediaId: string }> } {
  return { params: Promise.resolve({ id, mediaId }) };
}

/**
 * Builds a multipart upload request. Content-Type (with boundary) is generated
 * by the runtime from the FormData body; only auth headers are supplied.
 */
function uploadRequest(
  businessId: string,
  bytes: Buffer,
  filename: string,
  declaredType: string,
  headers?: { cookie: string },
  extraHeaders: Record<string, string> = {},
) {
  const form = new FormData();
  const body = bytes as unknown as BlobPart;
  form.append("file", new File([body], filename, { type: declaredType }));
  return new Request(`${BASE}/api/businesses/${businessId}/media`, {
    method: "POST",
    headers: { ...(headers ?? {}), ...extraHeaders },
    body: form,
  });
}

function jsonRequest(
  method: string,
  url: string,
  body: unknown,
  headers?: { cookie: string },
) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("media: unauthenticated list and upload are rejected", async () => {
  const { business } = await setupBusiness({ email: "anon@example.com", slug: "anon-biz" });

  const listRes = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${business._id}/media`, { method: "GET" }),
    ctx(String(business._id)),
  );
  assert.equal(listRes.status, 401);

  const uploadRes = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png"),
    ctx(String(business._id)),
  );
  assert.equal(uploadRes.status, 401);
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: owner upload persists metadata and calls storage with the detected type", async () => {
  const { business, headers } = await setupBusiness({
    email: "owner@example.com",
    slug: "owner-biz",
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "my photo.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 201);

  const data = await res.json();
  assert.equal(data.media.mimeType, "image/png");
  assert.equal(data.media.size, PNG_BYTES.length);
  assert.equal(data.media.originalName, "my_photo.png");
  assert.equal("storageKey" in data.media, false);
  assert.match(
    data.media.url,
    new RegExp(`^${PUBLIC_BASE}/media/${business._id}/[0-9a-f-]{36}\\.png$`),
  );

  const stored = await Media.findOne({ business: business._id }).lean();
  assert.ok(stored);
  assert.equal(stored?.storageKey, data.media.url.replace(`${PUBLIC_BASE}/`, ""));
  assert.equal(stored?.mimeType, "image/png");
  assert.equal(stored?.size, PNG_BYTES.length);
  assert.equal(stored?.deletedAt, null);

  assert.equal(uploadMock.mock.callCount(), 1);
  const [key, body, contentType] = uploadMock.mock.calls[0].arguments as [
    string,
    Buffer,
    string,
  ];
  assert.equal(key, stored?.storageKey);
  assert.equal(contentType, "image/png");
  assert.equal(Buffer.isBuffer(body), true);
  assert.equal(body.length, PNG_BYTES.length);
});

test("media: signature decides type, not the filename or declared MIME", async () => {
  const { business, headers } = await setupBusiness({
    email: "mask@example.com",
    slug: "mask-biz",
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(
      String(business._id),
      JPEG_BYTES,
      "totally-not-an-image.exe",
      "text/plain",
      headers,
    ),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 201);

  const data = await res.json();
  assert.equal(data.media.mimeType, "image/jpeg");
  assert.match(data.media.url, /\.jpg$/);
  const stored = await Media.findOne({ business: business._id }).lean();
  assert.equal(stored?.mimeType, "image/jpeg");
  assert.match(String(stored?.storageKey), /\.jpg$/);
});

test("media: staff members can upload", async () => {
  const owner = await createUser({ email: "owner2@example.com", name: "Owner" });
  const { business, headers } = await setupBusiness({
    email: "staff@example.com",
    slug: "staff-biz",
    role: "staff",
    ownerId: owner._id,
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), GIF_BYTES, "anim.gif", "image/gif", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.media.mimeType, "image/gif");
});

test("media: non-image content is rejected even when labelled as an image", async () => {
  const { business, headers } = await setupBusiness({
    email: "fake@example.com",
    slug: "fake-biz",
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(
      String(business._id),
      Buffer.from("#!/bin/sh\necho pwned\n"),
      "photo.png",
      "image/png",
      headers,
    ),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 415);
  const data = await res.json();
  assert.equal(data.code, "invalid_type");
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: SVG uploads are rejected", async () => {
  const { business, headers } = await setupBusiness({
    email: "svg@example.com",
    slug: "svg-biz",
  });

  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), svg, "logo.svg", "image/svg+xml", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 415);
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: empty uploads are rejected", async () => {
  const { business, headers } = await setupBusiness({
    email: "empty@example.com",
    slug: "empty-biz",
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), Buffer.alloc(0), "empty.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "empty_file");
  assert.equal(uploadMock.mock.callCount(), 0);
});

test("media: oversized uploads are rejected before storage", async () => {
  const { business, headers } = await setupBusiness({
    email: "big@example.com",
    slug: "big-biz",
  });

  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x89);
  oversized[0] = 0x89;
  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), oversized, "big.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.code, "file_too_large");
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: a large declared Content-Length is rejected before buffering", async () => {
  const { business, headers } = await setupBusiness({
    email: "length@example.com",
    slug: "length-biz",
  });

  const req = new Request(`${BASE}/api/businesses/${business._id}/media`, {
    method: "POST",
    headers: {
      ...headers,
      "content-length": String(10 * 1024 * 1024),
      "content-type": "multipart/form-data; boundary=x",
    },
    body: "--x--\r\n",
  });

  const res = await callHandler(mediaPOST, req, ctx(String(business._id)));
  assert.equal(res.status, 413);
  assert.equal(uploadMock.mock.callCount(), 0);
});

test("media: storage failure returns 502, leaves no visible media and records the failed upload", async () => {
  const { business, headers } = await setupBusiness({
    email: "s3down@example.com",
    slug: "s3down-biz",
  });

  uploadMock.mock.mockImplementation(async () => {
    throw new Error("simulated S3 outage");
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.code, "storage_error");

  // The record is written first, as `pending`, so no file can exist without one
  // (docs/platform-management.md, "Media uploads"). After the failure it stays only
  // as a closed record: failed, deleted, and with its storage confirmed removed.
  assert.equal(await Media.countDocuments({ business: business._id, deletedAt: null }), 0, "no visible media");
  const records = await Media.find({ business: business._id }).lean();
  assert.equal(records.length, 1);
  const [failed] = records;
  assert.equal(failed.uploadState, "failed");
  assert.ok(failed.deletedAt instanceof Date, "marked deleted");
  assert.ok(failed.storageDeletedAt instanceof Date, "its storage counts as removed");
  assert.equal(failed.deletedAt.getTime(), failed.storageDeletedAt.getTime(), "both in the same cleanup step");

  // The upload may have written the object before failing, so an idempotent
  // cleanup is attempted for the fresh key.
  assert.equal(removeMock.mock.callCount(), 1);
  assert.equal(removeMock.mock.calls[0].arguments[0], failed.storageKey, "the cleanup removes this upload's own key");

  // The library neither lists it, nor asks for it to be removed, nor counts its size.
  const listRes = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${business._id}/media`, { method: "GET", headers: { ...headers } }),
    ctx(String(business._id)),
  );
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.deepEqual(list.media, []);
  assert.equal(list.total, 0);
  assert.deepEqual(list.pendingCleanup, []);
  assert.equal(list.storage.usedBytes, 0);
});

test("media: missing or malformed public delivery URL fails before uploading", async () => {
  const { business, headers } = await setupBusiness({
    email: "nopublic@example.com",
    slug: "nopublic-biz",
  });

  const previous = process.env.AWS_S3_PUBLIC_URL;
  try {
    delete process.env.AWS_S3_PUBLIC_URL;
    const missing = await callHandler(
      mediaPOST,
      uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
      ctx(String(business._id)),
    );
    assert.equal(missing.status, 503);
    assert.equal(((await missing.json()) as { code?: string }).code, "storage_unavailable");

    process.env.AWS_S3_PUBLIC_URL = "not-a-url";
    const malformed = await callHandler(
      mediaPOST,
      uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
      ctx(String(business._id)),
    );
    assert.equal(malformed.status, 503);
    assert.equal(((await malformed.json()) as { code?: string }).code, "storage_unavailable");

    assert.equal(uploadMock.mock.callCount(), 0);
    assert.equal(removeMock.mock.callCount(), 0);
    assert.equal(await Media.countDocuments({}), 0);
  } finally {
    if (previous === undefined) delete process.env.AWS_S3_PUBLIC_URL;
    else process.env.AWS_S3_PUBLIC_URL = previous;
  }
});

test("media: cross-tenant uploads are forbidden", async () => {
  const { business: target } = await setupBusiness({
    email: "target@example.com",
    slug: "target-biz",
  });
  const { headers: attackerHeaders } = await setupBusiness({
    email: "attacker@example.com",
    slug: "attacker-biz",
  });

  const res = await callHandler(
    mediaPOST,
    uploadRequest(
      String(target._id),
      PNG_BYTES,
      "photo.png",
      "image/png",
      attackerHeaders,
    ),
    ctx(String(target._id)),
  );
  assert.equal(res.status, 403);
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: listing is tenant-scoped, excludes soft-deleted and hides keys", async () => {
  const { business: a, headers: headersA } = await setupBusiness({
    email: "a@example.com",
    slug: "a-biz",
  });
  const { business: b } = await setupBusiness({
    email: "b@example.com",
    slug: "b-biz",
  });

  await Media.create({
    business: a._id,
    storageKey: `media/${a._id}/kept.png`,
    originalName: "kept.png",
    mimeType: "image/png",
    size: 10,
    altText: "",
  });
  await Media.create({
    business: a._id,
    storageKey: `media/${a._id}/deleted.png`,
    originalName: "deleted.png",
    mimeType: "image/png",
    size: 10,
    altText: "",
    deletedAt: new Date(),
  });
  await Media.create({
    business: b._id,
    storageKey: `media/${b._id}/other.png`,
    originalName: "other.png",
    mimeType: "image/png",
    size: 10,
    altText: "",
  });

  const res = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${a._id}/media`, {
      method: "GET",
      headers: { ...headersA },
    }),
    ctx(String(a._id)),
  );
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.media.length, 1);
  assert.equal(data.media[0].originalName, "kept.png");
  assert.equal("storageKey" in data.media[0], false);
  assert.equal(data.media[0].url, `${PUBLIC_BASE}/media/${a._id}/kept.png`);
});

test("media: alt text can be updated by the owner", async () => {
  const { business, headers } = await setupBusiness({
    email: "alt@example.com",
    slug: "alt-biz",
  });

  const media = await Media.create({
    business: business._id,
    storageKey: `media/${business._id}/alt.webp`,
    originalName: "alt.webp",
    mimeType: "image/webp",
    size: 42,
    altText: "",
  });

  const res = await callHandler(
    mediaPATCH,
    jsonRequest(
      "PATCH",
      `${BASE}/api/businesses/${business._id}/media/${media._id}`,
      { altText: "  A product photo  " },
      headers,
    ),
    ctx(String(business._id), String(media._id)),
  );
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.media.altText, "A product photo");
  const stored = await Media.findById(media._id).lean();
  assert.equal(stored?.altText, "A product photo");
});

test("media: alt text longer than the limit is rejected", async () => {
  const { business, headers } = await setupBusiness({
    email: "long-alt@example.com",
    slug: "long-alt-biz",
  });

  const media = await Media.create({
    business: business._id,
    storageKey: `media/${business._id}/long.webp`,
    originalName: "long.webp",
    mimeType: "image/webp",
    size: 42,
    altText: "before",
  });

  const res = await callHandler(
    mediaPATCH,
    jsonRequest(
      "PATCH",
      `${BASE}/api/businesses/${business._id}/media/${media._id}`,
      { altText: "x".repeat(241) },
      headers,
    ),
    ctx(String(business._id), String(media._id)),
  );
  assert.equal(res.status, 422);
  const stored = await Media.findById(media._id).lean();
  assert.equal(stored?.altText, "before");
});

test("media: cross-tenant metadata writes are forbidden", async () => {
  const { business: a } = await setupBusiness({
    email: "own-a@example.com",
    slug: "own-a-biz",
  });
  const { headers: headersB } = await setupBusiness({
    email: "own-b@example.com",
    slug: "own-b-biz",
  });

  const media = await Media.create({
    business: a._id,
    storageKey: `media/${a._id}/private.png`,
    originalName: "private.png",
    mimeType: "image/png",
    size: 5,
    altText: "original",
  });

  const res = await callHandler(
    mediaPATCH,
    jsonRequest(
      "PATCH",
      `${BASE}/api/businesses/${a._id}/media/${media._id}`,
      { altText: "hijacked" },
      headersB,
    ),
    ctx(String(a._id), String(media._id)),
  );
  assert.equal(res.status, 403);
  const stored = await Media.findById(media._id).lean();
  assert.equal(stored?.altText, "original");
});

test("media: delete soft-deletes, removes the object and hides the record", async () => {
  const { business, headers } = await setupBusiness({
    email: "delete@example.com",
    slug: "delete-biz",
  });

  const uploadRes = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), WEBP_BYTES, "pic.webp", "image/webp", headers),
    ctx(String(business._id)),
  );
  assert.equal(uploadRes.status, 201);
  const { media } = await uploadRes.json();

  const res = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.deleted, true);
  assert.equal(data.storageDeleted, true);

  assert.equal(removeMock.mock.callCount(), 1);
  const stored = await Media.findById(media.id).lean();
  assert.ok(stored?.deletedAt instanceof Date);
  assert.ok(stored?.storageDeletedAt instanceof Date);

  const listRes = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${business._id}/media`, {
      method: "GET",
      headers: { ...headers },
    }),
    ctx(String(business._id)),
  );
  const listData = await listRes.json();
  assert.equal(listData.media.length, 0);

  // Repeated delete is a 404 and does not call storage again.
  const againRes = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(againRes.status, 404);
  assert.equal(removeMock.mock.callCount(), 1);
});

test("media: delete retries storage cleanup after a failure", async () => {
  const { business, headers } = await setupBusiness({
    email: "retry@example.com",
    slug: "retry-biz",
  });

  const media = await Media.create({
    business: business._id,
    storageKey: `media/${business._id}/retry.png`,
    originalName: "retry.png",
    mimeType: "image/png",
    size: 5,
    altText: "",
  });

  removeMock.mock.mockImplementation(async () => {
    throw new Error("simulated S3 outage");
  });

  const first = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media._id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), String(media._id)),
  );
  assert.equal(first.status, 502);
  const firstData = await first.json();
  assert.equal(firstData.code, "storage_error");

  const pending = await Media.findById(media._id).lean();
  assert.ok(pending?.deletedAt instanceof Date);
  assert.equal(pending?.storageDeletedAt, null);

  const pendingListRes = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${business._id}/media`, {
      method: "GET",
      headers: { ...headers },
    }),
    ctx(String(business._id)),
  );
  assert.equal(pendingListRes.status, 200);
  const pendingList = await pendingListRes.json();
  assert.equal(pendingList.pendingCleanup.length, 1);
  assert.equal(pendingList.pendingCleanup[0].id, String(media._id));
  assert.equal(pendingList.media.length, 0);

  removeMock.mock.mockImplementation(async () => undefined);

  const second = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media._id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), String(media._id)),
  );
  assert.equal(second.status, 200);
  const done = await Media.findById(media._id).lean();
  assert.ok(done?.storageDeletedAt instanceof Date);

  const clearedListRes = await callHandler(
    mediaGET,
    new Request(`${BASE}/api/businesses/${business._id}/media`, {
      method: "GET",
      headers: { ...headers },
    }),
    ctx(String(business._id)),
  );
  const clearedList = await clearedListRes.json();
  assert.equal(clearedList.pendingCleanup.length, 0);
});

test("media: cross-tenant delete is forbidden and leaves the record intact", async () => {
  const { business: a } = await setupBusiness({
    email: "del-a@example.com",
    slug: "del-a-biz",
  });
  const { headers: headersB } = await setupBusiness({
    email: "del-b@example.com",
    slug: "del-b-biz",
  });

  const media = await Media.create({
    business: a._id,
    storageKey: `media/${a._id}/safe.png`,
    originalName: "safe.png",
    mimeType: "image/png",
    size: 5,
    altText: "",
  });

  const res = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${a._id}/media/${media._id}`, {
      method: "DELETE",
      headers: { ...headersB },
    }),
    ctx(String(a._id), String(media._id)),
  );
  assert.equal(res.status, 403);
  assert.equal(removeMock.mock.callCount(), 0);
  const stored = await Media.findById(media._id).lean();
  assert.equal(stored?.deletedAt, null);
});

test("media: deleting media referenced by a product is blocked", async () => {
  const { business, headers } = await setupBusiness({
    email: "ref-product@example.com",
    slug: "ref-product-biz",
  });

  const uploadRes = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(uploadRes.status, 201);
  const { media } = await uploadRes.json();

  await Product.create({
    business: business._id,
    name: "Product with image",
    slug: "product-with-image",
    price: 10,
    imageUrl: media.url,
    status: "active",
  });

  const blocked = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, "media_in_use");
  assert.equal(blockedBody.references.products, 1);
  assert.equal(removeMock.mock.callCount(), 0);

  const stored = await Media.findById(media.id).lean();
  assert.equal(stored?.deletedAt, null);

  await Product.updateOne(
    { business: business._id },
    { $set: { imageUrl: "" } },
  );

  const deleted = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(deleted.status, 200);
  assert.equal(removeMock.mock.callCount(), 1);
});

test("media: deleting media referenced by business settings or pages is blocked", async () => {
  const { business, headers } = await setupBusiness({
    email: "ref-settings@example.com",
    slug: "ref-settings-biz",
  });

  const uploadRes = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "banner.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(uploadRes.status, 201);
  const { media } = await uploadRes.json();

  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        logoUrl: media.url,
        "themeSettings.sections": [
          {
            id: "hero-1",
            type: "hero",
            order: 0,
            visible: true,
            settings: { imageUrl: media.url, imageAlt: "Hero" },
          },
        ],
      },
    },
  );

  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    isHome: true,
    status: "draft",
    sections: [
      {
        id: "about-1",
        type: "about",
        order: 0,
        visible: true,
        settings: { imageUrl: media.url, imageAlt: "About" },
      },
    ],
    publishedSections: [
      {
        id: "hero-old",
        type: "hero",
        order: 0,
        visible: true,
        settings: { imageUrl: media.url, imageAlt: "Old hero" },
      },
    ],
    version: 1,
  });

  const blocked = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.code, "media_in_use");
  assert.ok(blockedBody.references.business >= 2);
  assert.ok(blockedBody.references.pages >= 1);
  assert.equal(removeMock.mock.callCount(), 0);

  await Business.updateOne(
    { _id: business._id },
    { $set: { logoUrl: "", "themeSettings.sections": [] } },
  );
  await Page.updateOne(
    { _id: page._id },
    { $set: { sections: [], publishedSections: [] } },
  );

  const deleted = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(deleted.status, 200);
  assert.equal(removeMock.mock.callCount(), 1);
});

test("media: pending cleanup retry is blocked while the image is still referenced", async () => {
  const { business, headers } = await setupBusiness({
    email: "ref-pending@example.com",
    slug: "ref-pending-biz",
  });

  const uploadRes = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), PNG_BYTES, "pending.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(uploadRes.status, 201);
  const { media } = await uploadRes.json();

  removeMock.mock.mockImplementation(async () => {
    throw new Error("simulated S3 outage");
  });
  const first = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(first.status, 502);

  removeMock.mock.mockImplementation(async () => undefined);

  await Product.create({
    business: business._id,
    name: "Late reference",
    slug: "late-reference",
    price: 10,
    imageUrl: media.url,
    status: "active",
  });

  const retry = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), media.id),
  );
  assert.equal(retry.status, 409);
  const retryBody = await retry.json();
  assert.equal(retryBody.code, "media_in_use");
  assert.equal(removeMock.mock.callCount(), 1);

  const pending = await Media.findById(media.id).lean();
  assert.ok(pending?.deletedAt instanceof Date);
  assert.equal(pending?.storageDeletedAt, null);
});
test("media: unknown or malformed media ids are rejected safely", async () => {
  const { business, headers } = await setupBusiness({
    email: "ids@example.com",
    slug: "ids-biz",
  });

  const malformed = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/not-an-id`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), "not-an-id"),
  );
  assert.equal(malformed.status, 400);

  const missingId = "64b7f0c2a1b2c3d4e5f60999";
  const missing = await callHandler(
    mediaDELETE,
    new Request(`${BASE}/api/businesses/${business._id}/media/${missingId}`, {
      method: "DELETE",
      headers: { ...headers },
    }),
    ctx(String(business._id), missingId),
  );
  assert.equal(missing.status, 404);
});



// ---------------------------------------------------------------------------
// Phase 5: 4 MiB pilot limit boundaries
// ---------------------------------------------------------------------------

function pngOfSize(size: number): Buffer {
  const buf = Buffer.alloc(size, 0);
  PNG_BYTES.copy(buf, 0);
  return buf;
}

test("media: a file of exactly 4 MiB is accepted and stored once", async () => {
  const { business, headers } = await setupBusiness({
    email: "exact4@example.com",
    slug: "exact4-biz",
  });
  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), pngOfSize(4 * 1024 * 1024), "exact.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 201);
  assert.equal(uploadMock.mock.callCount(), 1);
  const [, body] = uploadMock.mock.calls[0].arguments as [string, Buffer, string];
  assert.equal(body.length, 4 * 1024 * 1024);
});

test("media: 4 MiB + 1 byte is rejected with 413 and storage is never called", async () => {
  const { business, headers } = await setupBusiness({
    email: "over4@example.com",
    slug: "over4-biz",
  });
  const res = await callHandler(
    mediaPOST,
    uploadRequest(String(business._id), pngOfSize(4 * 1024 * 1024 + 1), "over.png", "image/png", headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 413);
  assert.equal(((await res.json()) as { code?: string }).code, "file_too_large");
  assert.equal(uploadMock.mock.callCount(), 0);
  assert.equal(removeMock.mock.callCount(), 0);
  assert.equal(await Media.countDocuments({}), 0);
});

test("media: the early Content-Length guard rejects a body just over 4 MiB + envelope", async () => {
  const { business, headers } = await setupBusiness({
    email: "envelope@example.com",
    slug: "envelope-biz",
  });
  const req = new Request(`${BASE}/api/businesses/${business._id}/media`, {
    method: "POST",
    headers: {
      ...headers,
      "content-length": String(4 * 1024 * 1024 + 64 * 1024 + 1),
      "content-type": "multipart/form-data; boundary=x",
    },
    body: "--x--\r\n",
  });
  const res = await callHandler(mediaPOST, req, ctx(String(business._id)));
  assert.equal(res.status, 413);
  assert.equal(uploadMock.mock.callCount(), 0);
});

test("media: S3_PUBLIC_URL alone is enough for uploads (no AWS_S3_PUBLIC_URL)", async () => {
  const { business, headers } = await setupBusiness({
    email: "s3only@example.com",
    slug: "s3only-biz",
  });
  const previousLegacy = process.env.AWS_S3_PUBLIC_URL;
  const previousNew = process.env.S3_PUBLIC_URL;
  try {
    delete process.env.AWS_S3_PUBLIC_URL;
    process.env.S3_PUBLIC_URL = PUBLIC_BASE;
    const res = await callHandler(
      mediaPOST,
      uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
      ctx(String(business._id)),
    );
    assert.equal(res.status, 201);
    const data = (await res.json()) as { media?: { url?: string } };
    assert.ok(data.media?.url?.startsWith(`${PUBLIC_BASE}/media/`));
  } finally {
    if (previousLegacy === undefined) delete process.env.AWS_S3_PUBLIC_URL;
    else process.env.AWS_S3_PUBLIC_URL = previousLegacy;
    if (previousNew === undefined) delete process.env.S3_PUBLIC_URL;
    else process.env.S3_PUBLIC_URL = previousNew;
  }
});

test("media: a 4 MiB file with a real Content-Length passes the early envelope guard", async () => {
  const { business, headers } = await setupBusiness({
    email: "withlength@example.com",
    slug: "withlength-biz",
  });
  // Serialise the multipart body exactly as a browser would send it so the
  // request carries a genuine Content-Length (FormData bodies otherwise omit it).
  const form = new FormData();
  form.append("file", new File([pngOfSize(4 * 1024 * 1024) as unknown as BlobPart], "real.png", { type: "image/png" }));
  form.append("alt", "A storefront photo");
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const body = Buffer.from(await encoded.arrayBuffer());
  assert.ok(body.length > 4 * 1024 * 1024 && body.length <= 4 * 1024 * 1024 + 64 * 1024);

  const req = new Request(`${BASE}/api/businesses/${business._id}/media`, {
    method: "POST",
    headers: { ...headers, "content-type": contentType, "content-length": String(body.length) },
    body,
  });
  const res = await callHandler(mediaPOST, req, ctx(String(business._id)));
  assert.equal(res.status, 201);
  assert.equal(uploadMock.mock.callCount(), 1);
});

test("media: deletion is blocked when a product references the object by its legacy URL", async () => {
  const { business, headers } = await setupBusiness({
    email: "legacy-ref@example.com",
    slug: "legacy-ref-biz",
  });
  const previous = process.env.S3_LEGACY_PUBLIC_URL;
  process.env.S3_LEGACY_PUBLIC_URL = "https://old-bucket.example.com";
  try {
    const uploadRes = await callHandler(
      mediaPOST,
      uploadRequest(String(business._id), PNG_BYTES, "photo.png", "image/png", headers),
      ctx(String(business._id)),
    );
    assert.equal(uploadRes.status, 201);
    const { media } = await uploadRes.json();
    const stored = await Media.findById(media.id).lean();

    await Product.create({
      business: business._id,
      name: "Product with legacy image",
      slug: "product-with-legacy-image",
      price: 10,
      imageUrl: `https://old-bucket.example.com/${stored!.storageKey}`,
      status: "active",
    });

    const blocked = await callHandler(
      mediaDELETE,
      new Request(`${BASE}/api/businesses/${business._id}/media/${media.id}`, {
        method: "DELETE",
        headers: { ...headers },
      }),
      ctx(String(business._id), media.id),
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "media_in_use");
    assert.equal(removeMock.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.S3_LEGACY_PUBLIC_URL;
    else process.env.S3_LEGACY_PUBLIC_URL = previous;
  }
});
