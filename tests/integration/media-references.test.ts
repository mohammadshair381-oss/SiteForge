import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import {
  startIntegrationSuite,
  stopIntegrationSuite,
  getTestMongoUri,
} from "./helpers/env";
import {
  connectTestDB,
  clearAllCollections,
  disconnectTestDB,
} from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Media } from "@/models/Media";
import { Page } from "@/models/Page";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import { POST as productPOST } from "@/app/api/businesses/[id]/products/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";

const BASE = "http://localhost";
const PUBLIC_BASE = "https://cdn.test";
process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (
    !uri.startsWith("mongodb://127.0.0.1:") &&
    !uri.startsWith("mongodb://localhost:")
  ) {
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
  process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;
});

async function setupBusiness(slug: string) {
  const user = await createUser({ email: `${slug}@example.com`, name: slug });
  const business = await Business.create({
    name: slug,
    slug,
    subdomain: slug,
    category: "retail",
    owner: user._id,
    description: "desc",
  });
  await Membership.create({
    business: business._id,
    user: user._id,
    role: "owner",
    status: "active",
  });
  const headers = await createAuthHeadersForUser(
    String(user._id),
    "user",
    user.tokenVersion,
  );
  return { user, business, headers };
}

async function giveActivePlan(businessId: unknown) {
  const plan = await Plan.create({
    key: `plan-${String(businessId)}`,
    name: "Test plan",
    price: 0,
    features: {
      productLimit: 50,
      staffLimit: 5,
      customDomain: false,
      removeBranding: false,
    },
    active: true,
  });
  await Subscription.create({
    business: businessId,
    plan: plan._id,
    status: "active",
    provider: "manual",
  });
}

async function createMedia(businessId: string, suffix: string, deleted = false) {
  const storageKey = `media/${businessId}/${suffix}`;
  const media = await Media.create({
    business: businessId,
    storageKey,
    originalName: "photo.png",
    mimeType: "image/png",
    size: 128,
    altText: "A photo",
    deletedAt: deleted ? new Date() : null,
  });
  return { media, storageKey, url: `${PUBLIC_BASE}/${storageKey}` };
}

function request(
  method: string,
  path: string,
  body: unknown,
  headers?: { cookie: string },
) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function businessCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function productCtx(id: string, productId: string) {
  return { params: Promise.resolve({ id, productId }) };
}

function pageCtx(id: string, pageId: string) {
  return { params: Promise.resolve({ id, pageId }) };
}

function section(type: "hero" | "about", imageUrl: string, id = "section-1") {
  return {
    id,
    type,
    order: 0,
    visible: true,
    settings: { imageUrl, imageAlt: "Section image" },
  };
}

async function createProduct(
  businessId: string,
  headers: { cookie: string },
  imageUrl: string,
  images: string[] = [],
) {
  return callHandler(
    productPOST,
    request(
      "POST",
      `/api/businesses/${businessId}/products`,
      { name: `Product ${Math.random()}`, price: 10, imageUrl, images },
      headers,
    ),
    businessCtx(businessId),
  );
}

test("media references: product create accepts own media and legacy HTTPS URLs", async () => {
  const { business, headers } = await setupBusiness("media-own-product");
  await giveActivePlan(business._id);

  const own = await createMedia(String(business._id), "own.png");
  const ownRes = await createProduct(String(business._id), headers, own.url);
  assert.equal(ownRes.status, 201);
  const ownBody = (await ownRes.json()) as { product?: { imageUrl?: string } };
  assert.equal(ownBody.product?.imageUrl, own.url);

  const legacy = "https://images.example.com/products/legacy.jpg";
  const legacyRes = await createProduct(String(business._id), headers, legacy);
  assert.equal(legacyRes.status, 201);
  const legacyBody = (await legacyRes.json()) as {
    product?: { imageUrl?: string };
  };
  assert.equal(legacyBody.product?.imageUrl, legacy);
});

test("media references: product create rejects another business's media URL", async () => {
  const { business: businessA, headers } = await setupBusiness("media-tenant-a");
  const { business: businessB } = await setupBusiness("media-tenant-b");
  await giveActivePlan(businessA._id);

  const foreign = await createMedia(String(businessB._id), "foreign.png");

  const res = await createProduct(String(businessA._id), headers, foreign.url);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code?: string; error?: string };
  assert.equal(body.code, "invalid_media_reference");
  assert.match(body.error ?? "", /not available/);
  assert.equal(
    await Product.countDocuments({ business: businessA._id }),
    0,
    "the rejected product must not be created",
  );

  // Even a URL that claims A's business id but names B's object is rejected,
  // because the Media record must exist for A.
  const forged = `${PUBLIC_BASE}/media/${String(businessA._id)}/missing.png`;
  const forgedRes = await createProduct(
    String(businessA._id),
    headers,
    "https://images.example.com/ok.jpg",
    [forged],
  );
  assert.equal(forgedRes.status, 400);
  assert.equal(
    ((await forgedRes.json()) as { code?: string }).code,
    "invalid_media_reference",
  );
});

test("media references: product update rejects cross-tenant media and keeps the stored image", async () => {
  const { business: businessA, headers } = await setupBusiness("media-update-a");
  const { business: businessB } = await setupBusiness("media-update-b");
  await giveActivePlan(businessA._id);

  const product = await Product.create({
    business: businessA._id,
    name: "Existing product",
    slug: "existing-product",
    price: 10,
    imageUrl: "https://images.example.com/existing.jpg",
  });
  const foreign = await createMedia(String(businessB._id), "update-foreign.png");

  const res = await callHandler(
    productPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}/products/${String(product._id)}`,
      { imageUrl: foreign.url },
      headers,
    ),
    productCtx(String(businessA._id), String(product._id)),
  );
  assert.equal(res.status, 400);
  assert.equal(
    ((await res.json()) as { code?: string }).code,
    "invalid_media_reference",
  );

  const stored = await Product.findById(product._id).lean();
  assert.equal(stored?.imageUrl, "https://images.example.com/existing.jpg");
});

test("media references: soft-deleted own media keeps existing references editable", async () => {
  const { business, headers } = await setupBusiness("media-deleted");
  await giveActivePlan(business._id);

  const media = await createMedia(String(business._id), "deleted.png");
  const product = await Product.create({
    business: business._id,
    name: "Legacy deleted image",
    slug: "legacy-deleted-image",
    price: 10,
    imageUrl: media.url,
  });
  await Media.updateOne(
    { _id: media.media._id },
    { $set: { deletedAt: new Date() } },
  );

  // The product edit form sends the existing imageUrl back. Deleting the media
  // must not make an otherwise valid product edit fail.
  const res = await callHandler(
    productPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(business._id)}/products/${String(product._id)}`,
      { name: "Renamed product", imageUrl: media.url },
      headers,
    ),
    productCtx(String(business._id), String(product._id)),
  );
  assert.equal(res.status, 200);

  const stored = await Product.findById(product._id).lean();
  assert.equal(stored?.name, "Renamed product");
  assert.equal(stored?.imageUrl, media.url);
});

test("media references: homepage sections accept own media and reject cross-tenant without overwriting settings", async () => {
  const { business: businessA, headers } = await setupBusiness("media-sections-a");
  const { business: businessB } = await setupBusiness("media-sections-b");

  const own = await createMedia(String(businessA._id), "hero-own.png");
  const foreign = await createMedia(String(businessB._id), "hero-foreign.png");

  const ownRes = await callHandler(
    businessPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}`,
      {
        themeSettings: {
          primaryColor: "#123456",
          heroHeadline: "Legacy headline",
          sections: [section("hero", own.url)],
        },
      },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(ownRes.status, 200);

  const afterOwn = await Business.findById(businessA._id).lean();
  assert.equal(afterOwn?.themeSettings.primaryColor, "#123456");
  assert.equal(
    (afterOwn?.themeSettings.sections as { settings?: { imageUrl?: string } }[])[0]
      ?.settings?.imageUrl,
    own.url,
  );

  const foreignRes = await callHandler(
    businessPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}`,
      {
        themeSettings: {
          heroHeadline: "Should not be saved",
          sections: [section("about", foreign.url, "section-2")],
        },
      },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(foreignRes.status, 400);
  assert.equal(
    ((await foreignRes.json()) as { code?: string }).code,
    "invalid_media_reference",
  );

  const afterForeign = await Business.findById(businessA._id).lean();
  assert.equal(
    afterForeign?.themeSettings.heroHeadline,
    "Legacy headline",
    "a rejected update must not partially apply",
  );
  assert.equal(
    (afterForeign?.themeSettings.sections as { settings?: { imageUrl?: string } }[])[0]
      ?.settings?.imageUrl,
    own.url,
  );

  const foreignLogoRes = await callHandler(
    businessPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}`,
      { logoUrl: foreign.url },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(foreignLogoRes.status, 400);
  assert.equal(
    ((await foreignLogoRes.json()) as { code?: string }).code,
    "invalid_media_reference",
  );
  assert.equal(
    (await Business.findById(businessA._id).lean())?.logoUrl,
    "",
    "the logo must not be updated to another tenant's media",
  );
});

test("media references: gallery and testimonial images enforce tenant ownership", async () => {
  const { business: businessA, headers } = await setupBusiness("media-advanced-a");
  const { business: businessB } = await setupBusiness("media-advanced-b");
  const ownGallery = await createMedia(String(businessA._id), "gallery-own.png");
  const ownPortrait = await createMedia(String(businessA._id), "portrait-own.png");
  const foreignGallery = await createMedia(String(businessB._id), "gallery-foreign.png");
  const foreignPortrait = await createMedia(String(businessB._id), "portrait-foreign.png");

  const ownSections = [
    {
      id: "gallery-1",
      type: "gallery",
      order: 0,
      visible: true,
      settings: { images: [{ url: ownGallery.url, alt: "The studio window" }] },
    },
    {
      id: "testimonials-1",
      type: "testimonials",
      order: 1,
      visible: true,
      settings: {
        items: [{
          quote: "A customer-provided quote.",
          name: "A. Customer",
          imageUrl: ownPortrait.url,
          imageAlt: "A. Customer",
        }],
      },
    },
  ];
  const ownRes = await callHandler(
    businessPATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}`,
      { themeSettings: { sections: ownSections } },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(ownRes.status, 200);

  for (const [type, settings] of [
    ["gallery", { images: [{ url: foreignGallery.url, alt: "Foreign gallery image" }] }],
    ["testimonials", { items: [{ quote: "Quote", name: "Person", imageUrl: foreignPortrait.url, imageAlt: "Person" }] }],
  ] as const) {
    const foreignRes = await callHandler(
      businessPATCH,
      request(
        "PATCH",
        `/api/businesses/${String(businessA._id)}`,
        {
          themeSettings: {
            sections: [{ id: `${type}-foreign`, type, order: 0, visible: true, settings }],
          },
        },
        headers,
      ),
      businessCtx(String(businessA._id)),
    );
    assert.equal(foreignRes.status, 400, `${type} image should be rejected`);
    assert.equal(
      ((await foreignRes.json()) as { code?: string }).code,
      "invalid_media_reference",
    );
  }
});

test("media references: page sections validate on create/update and publishing keeps the old snapshot", async () => {
  const { business: businessA, headers } = await setupBusiness("media-pages-a");
  const { business: businessB } = await setupBusiness("media-pages-b");

  const own = await createMedia(String(businessA._id), "page-own.png");
  const foreign = await createMedia(String(businessB._id), "page-foreign.png");

  const ownRes = await callHandler(
    pagesPOST,
    request(
      "POST",
      `/api/businesses/${String(businessA._id)}/pages`,
      {
        title: "Home",
        slug: "home",
        isHome: true,
        sections: [section("hero", own.url)],
      },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(ownRes.status, 201);
  const created = (await ownRes.json()) as { page?: { _id: string } };
  const pageId = created.page?._id;
  assert.ok(pageId, "page id returned");

  const foreignCreate = await callHandler(
    pagesPOST,
    request(
      "POST",
      `/api/businesses/${String(businessA._id)}/pages`,
      { title: "Bad page", sections: [section("about", foreign.url)] },
      headers,
    ),
    businessCtx(String(businessA._id)),
  );
  assert.equal(foreignCreate.status, 400);

  // Create a published page with a legacy snapshot, then try to publish a
  // draft whose section was tampered with directly in the database.
  const page = await Page.create({
    business: businessA._id,
    title: "Published",
    slug: "published",
    status: "published",
    isHome: false,
    sections: [section("hero", foreign.url)],
    publishedSections: [
      { id: "old", type: "hero", order: 0, visible: true, settings: { headline: "Old" } },
    ],
    version: 1,
  });

  const publishRes = await callHandler(
    pagePATCH,
    request(
      "PATCH",
      `/api/businesses/${String(businessA._id)}/pages/${String(page._id)}`,
      { status: "published", expectedVersion: 1 },
      headers,
    ),
    pageCtx(String(businessA._id), String(page._id)),
  );
  assert.equal(publishRes.status, 400);
  assert.equal(
    ((await publishRes.json()) as { code?: string }).code,
    "invalid_media_reference",
  );

  const unchanged = await Page.findById(page._id).lean();
  assert.equal(unchanged?.status, "published");
  assert.equal(
    (unchanged?.publishedSections as { id?: string }[])[0]?.id,
    "old",
    "the public snapshot must not change when validation fails",
  );
});

test("media references: ownership is still enforced when only S3_PUBLIC_URL is configured", async () => {
  const previousLegacy = process.env.AWS_S3_PUBLIC_URL;
  const previousNew = process.env.S3_PUBLIC_URL;
  try {
    // Production configuration uses the new name only. The ownership check
    // must not silently treat platform media as "external" in that case.
    delete process.env.AWS_S3_PUBLIC_URL;
    process.env.S3_PUBLIC_URL = PUBLIC_BASE;

    const { business: businessA, headers } = await setupBusiness("s3only-tenant-a");
    const { business: businessB } = await setupBusiness("s3only-tenant-b");
    await giveActivePlan(businessA._id);
    const foreign = await createMedia(String(businessB._id), "foreign.png");

    const res = await createProduct(String(businessA._id), headers, foreign.url);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code?: string }).code, "invalid_media_reference");
    assert.equal(await Product.countDocuments({ business: businessA._id }), 0);

    // And the business's own media is still accepted (the check is not just
    // rejecting every platform URL).
    const own = await createMedia(String(businessA._id), "own.png");
    const ok = await createProduct(String(businessA._id), headers, own.url);
    assert.equal(ok.status, 201);
    assert.equal(await Product.countDocuments({ business: businessA._id }), 1);
  } finally {
    if (previousLegacy === undefined) delete process.env.AWS_S3_PUBLIC_URL;
    else process.env.AWS_S3_PUBLIC_URL = previousLegacy;
    if (previousNew === undefined) delete process.env.S3_PUBLIC_URL;
    else process.env.S3_PUBLIC_URL = previousNew;
  }
});

// ---------------------------------------------------------------------------
// Phase 5: storage migration (S3_LEGACY_PUBLIC_URL)
// ---------------------------------------------------------------------------

const LEGACY_BASE = "https://old-bucket.s3.us-east-1.amazonaws.com";

async function withLegacyBase(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.S3_LEGACY_PUBLIC_URL;
  process.env.S3_LEGACY_PUBLIC_URL = `${LEGACY_BASE}/`;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.S3_LEGACY_PUBLIC_URL;
    else process.env.S3_LEGACY_PUBLIC_URL = previous;
  }
}

test("media references (migration): own media is accepted under both the current and the legacy URL", async () => {
  await withLegacyBase(async () => {
    const { business, headers } = await setupBusiness("legacy-own");
    await giveActivePlan(business._id);
    const own = await createMedia(String(business._id), "own.png");

    const current = await createProduct(String(business._id), headers, own.url);
    assert.equal(current.status, 201);
    const legacy = await createProduct(String(business._id), headers, `${LEGACY_BASE}/${own.storageKey}`);
    assert.equal(legacy.status, 201);
  });
});

test("media references (migration): legacy URLs get the same tenant checks as current URLs", async () => {
  await withLegacyBase(async () => {
    const { business: a, headers } = await setupBusiness("legacy-tenant-a");
    const { business: b } = await setupBusiness("legacy-tenant-b");
    await giveActivePlan(a._id);
    const foreign = await createMedia(String(b._id), "foreign.png");

    // Another tenant's object under the legacy base.
    const cross = await createProduct(String(a._id), headers, `${LEGACY_BASE}/${foreign.storageKey}`);
    assert.equal(cross.status, 400);
    assert.equal(((await cross.json()) as { code?: string }).code, "invalid_media_reference");

    // A legacy URL that claims A's id but names an object A does not own.
    const forged = await createProduct(String(a._id), headers, `${LEGACY_BASE}/media/${String(a._id)}/missing.png`);
    assert.equal(forged.status, 400);

    assert.equal(await Product.countDocuments({ business: a._id }), 0);
  });
});

test("media references (migration): arbitrary external URLs stay valid", async () => {
  await withLegacyBase(async () => {
    const { business, headers } = await setupBusiness("legacy-external");
    await giveActivePlan(business._id);
    const res = await createProduct(
      String(business._id),
      headers,
      "https://images.example.com/products/mug.jpg",
      // Same path shape as platform media but a different origin: external.
      [`https://another-cdn.example.com/media/${String(business._id)}/x.png`],
    );
    assert.equal(res.status, 201);
  });
});

test("media references (migration): without S3_LEGACY_PUBLIC_URL, old-bucket URLs are external (unchanged behaviour)", async () => {
  const { business: a, headers } = await setupBusiness("nolegacy-a");
  const { business: b } = await setupBusiness("nolegacy-b");
  await giveActivePlan(a._id);
  const foreign = await createMedia(String(b._id), "foreign.png");
  const res = await createProduct(String(a._id), headers, `${LEGACY_BASE}/${foreign.storageKey}`);
  assert.equal(res.status, 201, "documented limitation: configure S3_LEGACY_PUBLIC_URL during a migration");
});

test("media references (migration): references stored under the legacy URL block deletion counts", async () => {
  await withLegacyBase(async () => {
    const { business } = await setupBusiness("legacy-count");
    const own = await createMedia(String(business._id), "counted.png");
    const legacyUrl = `${LEGACY_BASE}/${own.storageKey}`;
    await Product.create({
      business: business._id,
      name: "Legacy product",
      slug: "legacy-product",
      price: 1,
      currency: "USD",
      status: "active",
      imageUrl: legacyUrl,
    });
    await Business.updateOne({ _id: business._id }, { $set: { logoUrl: legacyUrl } });

    const { countMediaReferences } = await import("@/lib/media-references");
    const currentOnly = await countMediaReferences(String(business._id), own.url);
    assert.equal(currentOnly.total, 0, "the current URL alone misses legacy references");
    const both = await countMediaReferences(String(business._id), [own.url, legacyUrl]);
    assert.equal(both.products, 1);
    assert.equal(both.business, 1);
    assert.equal(both.total, 2);
  });
});
