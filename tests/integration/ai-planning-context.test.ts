import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { createDefaultSection } from "@/lib/sections";
import { loadWebsiteEditingContext } from "@/lib/ai-planning/context";
import { Business } from "@/models/Business";
import { Media } from "@/models/Media";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser } from "./helpers/auth";
import {
  clearAllCollections,
  connectTestDB,
  disconnectTestDB,
} from "./helpers/db";
import {
  getTestMongoUri,
  startIntegrationSuite,
  stopIntegrationSuite,
} from "./helpers/env";
import { setRequestCookiesFromHeader } from "./helpers/mock-next-headers-setup";

const PUBLIC_BASE = "https://cdn.test";
process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;

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
  process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;
});

async function setupBusiness(
  email: string,
  role: "owner" | "manager" | "staff" = "owner",
) {
  const user = await createUser({ email, name: "Context tester" });
  const business = await Business.create({
    name: "Context Studio",
    slug: `context-${email.split("@")[0]}`,
    subdomain: `context-${email.split("@")[0]}`,
    category: "creative",
    owner: user._id,
    description: "A business description relevant to its website.",
    contactEmail: "private@example.test",
    phone: "555-0100",
    address: "Private test address",
  });
  await Membership.create({
    business: business._id,
    user: user._id,
    role,
    status: "active",
  });
  const headers = await createAuthHeadersForUser(
    String(user._id),
    "user",
    user.tokenVersion,
  );
  return { user, business, headers };
}

async function withAuth<T>(cookie: string, callback: () => Promise<T>): Promise<T> {
  setRequestCookiesFromHeader(cookie);
  try {
    return await callback();
  } finally {
    setRequestCookiesFromHeader(null);
  }
}

function sectionsWithImage(url: string) {
  return [
    {
      ...createDefaultSection("hero", 0),
      id: "hero-image",
      settings: {
        headline: "Welcome",
        imageUrl: url,
        imageAlt: "Studio entrance",
      },
    },
  ];
}

test("context loader: requires an authenticated user and owner or manager membership", async () => {
  const owner = await setupBusiness("context-auth@example.test");
  await assert.rejects(
    loadWebsiteEditingContext(String(owner.business._id)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 401,
  );

  const staff = await setupBusiness("context-staff@example.test", "staff");
  await assert.rejects(
    withAuth(staff.headers.cookie, () =>
      loadWebsiteEditingContext(String(staff.business._id)),
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 403,
  );
});

test("context loader: permits manager and selected owner drafts only", async () => {
  const manager = await setupBusiness("context-manager@example.test", "manager");
  const page = await Page.create({
    business: manager.business._id,
    title: "Home",
    slug: "home",
    sections: [createDefaultSection("hero", 0)],
    status: "draft",
    version: 7,
    isHome: true,
  });

  const result = await withAuth(manager.headers.cookie, () =>
    loadWebsiteEditingContext(String(manager.business._id), [String(page._id)]),
  );

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].editable, true);
  assert.equal(result.pages[0].version, 7);
  assert.equal(result.pages[0].isHome, true);
  assert.deepEqual(
    result.editingContext.pages.map((item) => item.id),
    [String(page._id)],
  );
});

test("context loader: rejects a cross-tenant or missing selected page without revealing which", async () => {
  const owner = await setupBusiness("context-tenant-a@example.test");
  const other = await setupBusiness("context-tenant-b@example.test");
  const foreignPage = await Page.create({
    business: other.business._id,
    title: "Foreign page",
    slug: "foreign-page",
    sections: [createDefaultSection("about", 0)],
    status: "draft",
  });
  const missingId = "abcdefabcdefabcdefabcdef";

  for (const pageId of [String(foreignPage._id), missingId]) {
    await assert.rejects(
      withAuth(owner.headers.cookie, () =>
        loadWebsiteEditingContext(String(owner.business._id), [pageId]),
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "page_not_found" &&
        "message" in error &&
        error.message === "One or more selected pages were not found.",
    );
  }
});

test("context loader: published pages are read-only and use their published sections", async () => {
  const owner = await setupBusiness("context-published@example.test");
  const draft = await Page.create({
    business: owner.business._id,
    title: "Home",
    slug: "home",
    sections: [createDefaultSection("hero", 0)],
    status: "draft",
    isHome: true,
    version: 3,
  });
  const publishedSnapshot = [
    {
      ...createDefaultSection("about", 0),
      id: "public-about",
      settings: { title: "Public", body: "Published copy" },
    },
  ];
  const published = await Page.create({
    business: owner.business._id,
    title: "About",
    slug: "about",
    sections: [
      {
        ...createDefaultSection("about", 0),
        settings: { title: "Draft", body: "Unpublished edit" },
      },
    ],
    publishedSections: publishedSnapshot,
    status: "published",
    isHome: false,
    version: 9,
  });

  const result = await withAuth(owner.headers.cookie, () =>
    loadWebsiteEditingContext(String(owner.business._id), [
      String(draft._id),
      String(published._id),
    ]),
  );

  assert.equal(result.pages.find((page) => page.id === String(draft._id))?.editable, true);
  const readonlyPage = result.pages.find((page) => page.id === String(published._id));
  assert.equal(readonlyPage?.status, "published");
  assert.equal(readonlyPage?.editable, false);
  assert.deepEqual(readonlyPage?.sections, publishedSnapshot);
  assert.deepEqual(
    result.editingContext.pages.map((page) => page.id),
    [String(draft._id)],
  );
});

test("context loader: rejects malformed stored sections with a safe error", async () => {
  const owner = await setupBusiness("context-malformed@example.test");
  const page = await Page.create({
    business: owner.business._id,
    title: "Broken",
    slug: "broken",
    sections: [{ id: "unsafe", type: "unknown", settings: {} }],
    status: "draft",
  });

  await assert.rejects(
    withAuth(owner.headers.cookie, () =>
      loadWebsiteEditingContext(String(owner.business._id), [String(page._id)]),
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "invalid_stored_page_content" &&
      "message" in error &&
      error.message ===
        "A page contains content that cannot be used for website editing. Review it in the page editor first.",
  );
});

test("context loader: allowlists only active tenant media records referenced by selected drafts", async () => {
  const owner = await setupBusiness("context-media-owner@example.test");
  const other = await setupBusiness("context-media-other@example.test");
  const ownedKey = `media/${String(owner.business._id)}/owned.webp`;
  const deletedKey = `media/${String(owner.business._id)}/deleted.webp`;
  const foreignKey = `media/${String(other.business._id)}/foreign.webp`;
  await Media.create([
    {
      business: owner.business._id,
      storageKey: ownedKey,
      originalName: "owned.webp",
      mimeType: "image/webp",
      size: 128,
    },
    {
      business: owner.business._id,
      storageKey: deletedKey,
      originalName: "deleted.webp",
      mimeType: "image/webp",
      size: 128,
      deletedAt: new Date(),
    },
    {
      business: other.business._id,
      storageKey: foreignKey,
      originalName: "foreign.webp",
      mimeType: "image/webp",
      size: 128,
    },
  ]);
  const ownedUrl = `${PUBLIC_BASE}/${ownedKey}`;
  const deletedUrl = `${PUBLIC_BASE}/${deletedKey}`;
  const page = await Page.create({
    business: owner.business._id,
    title: "Home",
    slug: "home",
    sections: [
      ...sectionsWithImage(ownedUrl),
      {
        ...createDefaultSection("gallery", 1),
        id: "gallery",
        settings: {
          images: [{ url: deletedUrl, alt: "Old photo" }],
        },
      },
      {
        ...createDefaultSection("about", 2),
        id: "about-external",
        settings: {
          title: "About",
          body: "",
          imageUrl: "https://external.example.test/photo.webp",
        },
      },
    ],
    status: "draft",
  });

  const result = await withAuth(owner.headers.cookie, () =>
    loadWebsiteEditingContext(String(owner.business._id), [String(page._id)]),
  );

  assert.deepEqual(result.editingContext.allowedMediaUrls, [ownedUrl]);
});

test("context loader: returns only minimum selected business and page fields and performs no writes", async () => {
  const owner = await setupBusiness("context-minimum@example.test");
  const selected = await Page.create({
    business: owner.business._id,
    title: "Home",
    slug: "home",
    sections: [createDefaultSection("hero", 0)],
    publishedSections: [createDefaultSection("about", 0)],
    status: "draft",
    isHome: true,
    version: 12,
    seoTitle: "Private SEO field",
    seoDescription: "Private SEO description",
  });
  await Page.create({
    business: owner.business._id,
    title: "Other",
    slug: "other",
    sections: [createDefaultSection("about", 0)],
    status: "draft",
  });

  const result = await withAuth(owner.headers.cookie, () =>
    loadWebsiteEditingContext(String(owner.business._id), [String(selected._id)]),
  );

  assert.deepEqual(Object.keys(result.business).sort(), ["category", "description", "name"]);
  assert.deepEqual(
    Object.keys(result.pages[0]).sort(),
    ["editable", "id", "isHome", "sections", "slug", "status", "title", "version"],
  );
  assert.deepEqual(Object.keys(result.editingContext.pages[0]).sort(), [
    "id",
    "sections",
    "slug",
    "status",
    "title",
    "version",
  ]);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].title, "Home");
  assert.equal(result.pages[0].version, 12);

  const unchanged = await Page.findById(selected._id).lean();
  assert.equal(unchanged?.version, 12);
  assert.equal(unchanged?.seoTitle, "Private SEO field");
  assert.equal(unchanged?.seoDescription, "Private SEO description");
});

test("context loader: handles empty page selection and reports selected missing pages", async () => {
  const owner = await setupBusiness("context-empty@example.test");
  const empty = await withAuth(owner.headers.cookie, () =>
    loadWebsiteEditingContext(String(owner.business._id)),
  );
  assert.deepEqual(empty.pages, []);
  assert.deepEqual(empty.editingContext.pages, []);
  assert.deepEqual(empty.editingContext.allowedMediaUrls, []);

  await assert.rejects(
    withAuth(owner.headers.cookie, () =>
      loadWebsiteEditingContext(String(owner.business._id), [
        "0123456789abcdef01234567",
      ]),
    ),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "page_not_found",
  );
});
