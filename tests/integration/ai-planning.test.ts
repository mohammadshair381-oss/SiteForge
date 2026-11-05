import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { POST as validatePlan } from "@/app/api/businesses/[id]/planning/validate/route";
import { createDefaultSection } from "@/lib/sections";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Media } from "@/models/Media";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
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

const BASE = "http://localhost";
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

async function setupBusiness(email: string, role: "owner" | "manager" | "staff" = "owner") {
  const user = await createUser({ email, name: "Planner" });
  const business = await Business.create({
    name: "Planning Studio",
    slug: `planning-${role}-${email.split("@")[0]}`,
    subdomain: `planning-${role}-${email.split("@")[0]}`,
    category: "creative",
    owner: user._id,
    description: "A local creative studio.",
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

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function request(body: unknown, headers?: { cookie: string }) {
  return new Request(`${BASE}/api/businesses/planning/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    businessSummary: "A locally owned design studio.",
    targetAudience: "Small businesses seeking brand design.",
    recommendedTheme: "studio",
    requestedPageCount: 1,
    designPreferences: { notes: "Editorial and calm." },
    specialRequirements: "",
    productIds: [],
    pages: [
      {
        title: "Home",
        slug: "home",
        purpose: "Introduce the studio and its work.",
        proposedContent: "Services and contact details.",
        isHome: true,
        sections: [createDefaultSection("hero", 0)],
      },
    ],
    navigation: [{ pageSlug: "home", label: "Home" }],
    assumptions: [],
    unansweredQuestions: [],
    summary: "One-page review draft.",
    ...overrides,
  };
}

test("planning validation: requires an authenticated business member", async () => {
  const { business } = await setupBusiness("unauth@example.com");
  const response = await callHandler(
    validatePlan,
    request(plan()),
    context(String(business._id)),
  );
  assert.equal(response.status, 401);
});

test("planning validation: blocks cross-tenant and staff access", async () => {
  const { business } = await setupBusiness("owner-one@example.com");
  const other = await setupBusiness("owner-two@example.com");
  const crossTenant = await callHandler(
    validatePlan,
    request(plan(), other.headers),
    context(String(business._id)),
  );
  assert.equal(crossTenant.status, 403);

  const staff = await setupBusiness("staff@example.com", "staff");
  const staffResponse = await callHandler(
    validatePlan,
    request(plan(), staff.headers),
    context(String(staff.business._id)),
  );
  assert.equal(staffResponse.status, 403);
});

test("planning validation: manager review does not mutate draft or published content", async () => {
  const { business, headers } = await setupBusiness("manager@example.com", "manager");
  const originalSections = [createDefaultSection("about", 0)];
  const originalPublished = [createDefaultSection("hero", 0)];
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    sections: originalSections,
    publishedSections: originalPublished,
    status: "draft",
    isHome: true,
    seoTitle: "Existing SEO title",
  });
  const originalBusiness = await Business.findById(business._id).lean();

  const response = await callHandler(
    validatePlan,
    request(
      plan({
        pages: [
          {
            ...plan().pages[0],
            existingPageId: String(page._id),
            expectedVersion: page.version,
          },
        ],
      }),
      headers,
    ),
    context(String(business._id)),
  );
  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.equal(responseBody.ai.available, false);
  assert.equal(responseBody.review.validated, true);
  assert.equal(responseBody.review.saved, false);
  assert.equal(responseBody.review.applied, false);

  const unchangedPage = await Page.findById(page._id).lean();
  const unchangedBusiness = await Business.findById(business._id).lean();
  assert.deepEqual(unchangedPage?.sections, originalSections);
  assert.deepEqual(unchangedPage?.publishedSections, originalPublished);
  assert.equal(unchangedPage?.seoTitle, "Existing SEO title");
  assert.equal(unchangedPage?.version, 0);
  assert.equal(unchangedBusiness?.themeId, originalBusiness?.themeId);
  assert.deepEqual(unchangedBusiness?.themeSettings, originalBusiness?.themeSettings);
});

test("planning validation: refuses cross-tenant product references and slug conflicts", async () => {
  const { business, headers } = await setupBusiness("business-a@example.com");
  const other = await setupBusiness("business-b@example.com");
  const product = await Product.create({
    business: other.business._id,
    name: "Other business item",
    slug: "other-item",
    price: 12,
    status: "active",
  });

  const invalidProduct = await callHandler(
    validatePlan,
    request(plan({ productIds: [String(product._id)] }), headers),
    context(String(business._id)),
  );
  assert.equal(invalidProduct.status, 400);

  await Page.create({
    business: business._id,
    title: "Existing Home",
    slug: "home",
    status: "draft",
    isHome: true,
  });
  const duplicateSlug = await callHandler(
    validatePlan,
    request(plan(), headers),
    context(String(business._id)),
  );
  assert.equal(duplicateSlug.status, 409);
});

test("planning validation: rejects media-library images owned by another business", async () => {
  const { business, headers } = await setupBusiness("media-owner@example.com");
  const other = await setupBusiness("media-other@example.com");
  const storageKey = `media/${String(other.business._id)}/planning-image`;
  await Media.create({
    business: other.business._id,
    storageKey,
    originalName: "planning-image.png",
    mimeType: "image/png",
    size: 128,
    altText: "Sample image",
  });
  const body = plan({
    pages: [
      {
        ...plan().pages[0],
        sections: [
          {
            ...createDefaultSection("hero", 0),
            settings: {
              imageUrl: `${PUBLIC_BASE}/${storageKey}`,
              imageAlt: "Sample image",
            },
          },
        ],
      },
    ],
  });

  const response = await callHandler(
    validatePlan,
    request(body, headers),
    context(String(business._id)),
  );
  assert.equal(response.status, 400);
  const responseBody = await response.json();
  assert.equal(responseBody.code, "invalid_media_reference");
});
