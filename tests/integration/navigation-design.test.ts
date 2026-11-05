import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser } from "./helpers/auth";
import { callHandler } from "./helpers/auth";
import {
  createBusinessWithOwner,
  createPlan,
  createSubscription,
} from "./helpers/tenant";
import { Membership } from "@/models/Membership";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import { THEME_IDS } from "@/lib/constants";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";

const BASE = "http://localhost";

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
});

async function setupOwner() {
  const { owner, business } = await createBusinessWithOwner();
  // All nine themes included (plan-based theme access: theme-entitlements.test.ts).
  const plan = await createPlan({ price: 0, themes: [...THEME_IDS] });
  await createSubscription(business._id, plan._id, { status: "active" });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { user: owner, business, headers };
}

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) };
}

function req(method: string, url: string, body?: unknown, headers?: any) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("navigation: cross-business page reference rejected on save", async () => {
  const { business, headers } = await setupOwner();
  // Create a page in another business
  const otherUser = await createUser({ email: "other@example.com", name: "Other" });
  const otherBusiness = await Business.create({
    name: "OtherBiz",
    slug: "otherbiz",
    subdomain: "otherbiz",
    category: "retail",
    owner: otherUser._id,
    description: "desc",
  });
  await Membership.create({ business: otherBusiness._id, user: otherUser._id, role: "owner", status: "active" });
  const otherPage = await Page.create({
    business: otherBusiness._id,
    title: "Other Page",
    slug: "other-page",
    status: "published",
    isHome: true,
    sections: [],
  });

  const res = await callHandler(
    businessPATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}`, {
      themeSettings: {
        navigation: {
          header: [{ pageId: String(otherPage._id), label: "Cross-ref", order: 0 }],
          footer: [],
        },
      },
    }, headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_navigation_reference");
});

test("navigation: malformed page ID rejected on save", async () => {
  const { business, headers } = await setupOwner();
  const res = await callHandler(
    businessPATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}`, {
      themeSettings: {
        navigation: {
          header: [{ pageId: "not-a-valid-id", label: "Bad", order: 0 }],
          footer: [],
        },
      },
    }, headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_id");
});

test("navigation: duplicate page reference rejected by schema", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({
    business: business._id,
    title: "About",
    slug: "about",
    status: "published",
    isHome: true,
    sections: [],
  });

  const res = await callHandler(
    businessPATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}`, {
      themeSettings: {
        navigation: {
          header: [
            { pageId: String(page._id), label: "About", order: 0 },
            { pageId: String(page._id), label: "About Again", order: 1 },
          ],
          footer: [],
        },
      },
    }, headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 422);
});

test("navigation: valid navigation saved successfully", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({
    business: business._id,
    title: "About",
    slug: "about",
    status: "published",
    isHome: true,
    sections: [],
  });

  const res = await callHandler(
    businessPATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}`, {
      themeSettings: {
        navigation: {
          header: [{ pageId: String(page._id), label: "About Us", order: 0 }],
          footer: [],
        },
      },
    }, headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.business.themeSettings.navigation.header.length, 1);
  assert.equal(data.business.themeSettings.navigation.header[0].label, "About Us");
});

test("theme switching preserves page snapshots, business content, navigation, and products", async () => {
  const { business, headers } = await setupOwner();
  const pageSections = [
    { id: "draft-hero", type: "hero", order: 0, visible: true, settings: { headline: "Draft" } },
  ];
  const publishedSections = [
    { id: "published-hero", type: "hero", order: 0, visible: true, settings: { headline: "Published" } },
  ];
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "published",
    isHome: true,
    sections: pageSections,
    publishedSections,
  });
  const product = await Product.create({
    business: business._id,
    name: "Widget",
    slug: "widget",
    description: "Product description",
    price: 25,
    imageUrl: "https://example.com/widget.jpg",
    images: ["https://example.com/widget.jpg"],
    status: "active",
  });

  const originalSettings = {
    sections: [{ id: "legacy-section", type: "about", order: 0, visible: true, settings: { body: "Legacy" } }],
    navigation: {
      header: [{ pageId: String(page._id), label: "Home", order: 0 }],
      footer: [{ pageId: String(page._id), label: "Visit", order: 0 }],
    },
    publishedNavigation: {
      header: [{ pageId: String(page._id), label: "Published Home", order: 0 }],
      footer: [],
    },
  };
  const editableThemeSettings = {
    primaryColor: "#123456",
    accentColor: "#abcdef",
    heroHeadline: "Welcome",
    heroSubheadline: "A short introduction",
    showProducts: true,
  };
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      description: "Business description",
      logoUrl: "https://example.com/logo.jpg",
      contactEmail: "owner@example.com",
      phone: "555-0100",
      address: "123 Main St",
      "themeSettings.sections": originalSettings.sections,
      "themeSettings.navigation": originalSettings.navigation,
      "themeSettings.publishedNavigation": originalSettings.publishedNavigation,
    },
  });

  for (const themeId of THEME_IDS) {
    const res = await callHandler(
      businessPATCH,
      req(
        "PATCH",
        `${BASE}/api/businesses/${business._id}`,
        { themeId, themeSettings: editableThemeSettings },
        headers,
      ),
      ctx(String(business._id)),
    );
    assert.equal(res.status, 200);

    const updatedBusiness = await Business.findById(business._id).lean();
    const updatedPage = await Page.findById(page._id).lean();
    const updatedProduct = await Product.findById(product._id).lean();
    assert.equal(updatedBusiness?.themeId, themeId);
    assert.equal(updatedBusiness?.description, "Business description");
    assert.equal(updatedBusiness?.logoUrl, "https://example.com/logo.jpg");
    assert.equal(updatedBusiness?.contactEmail, "owner@example.com");
    assert.equal(updatedBusiness?.phone, "555-0100");
    assert.equal(updatedBusiness?.address, "123 Main St");
    assert.equal(updatedBusiness?.themeSettings.primaryColor, editableThemeSettings.primaryColor);
    assert.equal(updatedBusiness?.themeSettings.accentColor, editableThemeSettings.accentColor);
    assert.deepEqual(updatedBusiness?.themeSettings.sections, originalSettings.sections);
    assert.deepEqual(updatedBusiness?.themeSettings.navigation, originalSettings.navigation);
    assert.deepEqual(updatedBusiness?.themeSettings.publishedNavigation, originalSettings.publishedNavigation);
    assert.deepEqual(updatedPage?.sections, pageSections);
    assert.deepEqual(updatedPage?.publishedSections, publishedSections);
    assert.equal(updatedProduct?.name, "Widget");
    assert.equal(updatedProduct?.price, 25);
    assert.deepEqual(updatedProduct?.images, ["https://example.com/widget.jpg"]);
  }
});

test("navigation: invalid reference rejected before publication", async () => {
  const { business, headers } = await setupOwner();
  // Set invalid navigation (page doesn't exist)
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.navigation": {
        header: [{ pageId: "000000000000000000000001", label: "Ghost", order: 0 }],
        footer: [],
      },
    },
  });

  // Try to publish - should fail
  const res = await callHandler(
    publishPOST,
    req("POST", `${BASE}/api/businesses/${business._id}/publish`, { publish: true }, headers),
    ctx(String(business._id)),
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_navigation_reference");
});

test("navigation: published storefront uses publishedNavigation not draft", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({
    business: business._id,
    title: "About",
    slug: "about",
    status: "published",
    isHome: true,
    sections: [],
  });

  // Set draft navigation
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.navigation": {
        header: [{ pageId: String(page._id), label: "Draft Label", order: 0 }],
        footer: [],
      },
    },
  });

  // Publish (snapshots draft → published)
  const publishRes = await callHandler(
    publishPOST,
    req("POST", `${BASE}/api/businesses/${business._id}/publish`, { publish: true }, headers),
    ctx(String(business._id)),
  );
  assert.equal(publishRes.status, 200);

  // Now change draft navigation
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.navigation": {
        header: [{ pageId: String(page._id), label: "Changed Draft Label", order: 0 }],
        footer: [],
      },
    },
  });

  // Verify published snapshot still has original label
  const updatedBusiness = await Business.findById(business._id).lean();
  assert.equal(
    (updatedBusiness?.themeSettings as any)?.publishedNavigation?.header?.[0]?.label,
    "Draft Label",
  );
  assert.equal(
    (updatedBusiness?.themeSettings as any)?.navigation?.header?.[0]?.label,
    "Changed Draft Label",
  );
});

test("design: published design tokens used publicly", async () => {
  const { business, headers } = await setupOwner();

  // Set draft design tokens
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.designTokens": { fontScale: "1.25", contentWidth: "1024px" },
    },
  });

  // Publish (snapshots draft → published)
  const publishRes = await callHandler(
    publishPOST,
    req("POST", `${BASE}/api/businesses/${business._id}/publish`, { publish: true }, headers),
    ctx(String(business._id)),
  );
  assert.equal(publishRes.status, 200);

  // Verify published snapshot exists
  const publishedBusiness = await Business.findById(business._id).lean();
  assert.deepEqual(
    (publishedBusiness?.themeSettings as any)?.publishedDesignTokens,
    { fontScale: "1.25", contentWidth: "1024px" },
  );
});

test("design: draft design tokens preserved after publish", async () => {
  const { business, headers } = await setupOwner();

  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.designTokens": { fontScale: "1.5", contentWidth: "768px" },
    },
  });

  const publishRes = await callHandler(
    publishPOST,
    req("POST", `${BASE}/api/businesses/${business._id}/publish`, { publish: true }, headers),
    ctx(String(business._id)),
  );
  assert.equal(publishRes.status, 200);

  // Change draft tokens after publish
  await Business.findByIdAndUpdate(business._id, {
    $set: {
      "themeSettings.designTokens": { fontScale: "0.875", contentWidth: "640px" },
    },
  });

  const updatedBusiness = await Business.findById(business._id).lean();
  // Published snapshot should retain original values
  assert.equal(
    (updatedBusiness?.themeSettings as any)?.publishedDesignTokens?.fontScale,
    "1.5",
  );
  // Draft should have new values
  assert.equal(
    (updatedBusiness?.themeSettings as any)?.designTokens?.fontScale,
    "0.875",
  );
});