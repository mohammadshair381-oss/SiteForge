import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { applyApprovedEditingProposal } from "@/lib/ai-planning/apply-approved-proposal";
import { prepareEditingProposal } from "@/lib/ai-planning/proposal";
import { createDefaultSection } from "@/lib/sections";
import { Business } from "@/models/Business";
import { Media } from "@/models/Media";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { User } from "@/models/User";
import { createUser } from "./helpers/fixtures";
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
  const suffix = email.split("@")[0].replace(/[^a-z0-9-]/gi, "-");
  const business = await Business.create({
    name: "Planning Studio",
    slug: `planning-${suffix}`,
    subdomain: `planning-${suffix}`,
    category: "creative",
    owner: user._id,
    description: "A locally owned creative studio.",
    themeId: "studio",
    themeSettings: {
      primaryColor: "#123456",
      navigation: { header: [], footer: [] },
    },
  });
  await Membership.create({
    business: business._id,
    user: user._id,
    role,
    status: "active",
  });
  return { user, business };
}

test("unauthorized users and cross-tenant page references are rejected", async () => {
  const owner = await setupBusiness("owner-a@example.com");
  const other = await setupBusiness("owner-b@example.com");

  // Create a page in other business
  const foreignPage = await Page.create({
    business: other.business._id,
    title: "Other",
    slug: "other",
    status: "draft",
    version: 1,
    sections: [createDefaultSection("hero", 0)],
  });

  // Try to apply proposal affecting foreign page - but our service loads by businessId
  // and checks ownership; also need proposal structure. Build a proposal that targets foreign page id
  const context = {
    pages: [{
      id: String(foreignPage._id),
      title: foreignPage.title,
      slug: foreignPage.slug,
      status: "draft" as const,
      version: foreignPage.version,
      sections: foreignPage.sections as any[],
    }],
    allowedMediaUrls: [],
  };
  const proposal = prepareEditingProposal(context, {
    proposalId: "prop1",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "update-section" as const,
      pageId: String(foreignPage._id),
      expectedVersion: foreignPage.version,
      section: { ...(foreignPage.sections[0] as Record<string, unknown>), settings: { headline: "hi", subheadline: "there" } },
    }],
  });
  // Approve it
  const approved = {
    ...proposal,
    status: "approved" as const,
    review: { decision: "approved" as const, reviewerId: String(owner.user._id), reviewedAt: new Date().toISOString() } as const,
  } as const;

  // Try to apply as owner of different business
  await assert.rejects(
    applyApprovedEditingProposal(String(owner.business._id), approved, { actorUserId: String(owner.user._id) }),
    (err: any) => {
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("missing or invalid approval state is rejected", async () => {
  const { business, user } = await setupBusiness("owner-c@example.com");
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    version: 1,
    sections: [createDefaultSection("hero", 0)],
  });
  const context = {
    pages: [{
      id: String(page._id),
      title: page.title,
      slug: page.slug,
      status: "draft" as const,
      version: page.version,
      sections: page.sections as any[],
    }],
    allowedMediaUrls: [],
  };
  const proposal = prepareEditingProposal(context, {
    proposalId: "prop2",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "update-section" as const,
      pageId: String(page._id),
      expectedVersion: page.version,
      section: { ...(page.sections[0] as Record<string, unknown>), settings: { headline: "x", subheadline: "y" } },
    }],
  });

  // Pending
  await assert.rejects(
    applyApprovedEditingProposal(String(business._id), proposal, { actorUserId: String(user._id) }),
  );
  // Rejected
  await assert.rejects(
    applyApprovedEditingProposal(String(business._id), { ...(proposal as any), status: "rejected", review: { decision: "rejected", reviewerId: String(user._id), reviewedAt: new Date().toISOString() } } as any, { actorUserId: String(user._id) }),
  );
});

test("stale page versions are rejected", async () => {
  const { business, user } = await setupBusiness("owner-d@example.com");
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    version: 5,
    sections: [createDefaultSection("hero", 0)],
  });
  const context = {
    pages: [{
      id: String(page._id),
      title: page.title,
      slug: page.slug,
      status: "draft" as const,
      version: page.version,
      sections: page.sections as any[],
    }],
    allowedMediaUrls: [],
  };
  const proposal = prepareEditingProposal(context, {
    proposalId: "prop3",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "update-section" as const,
      pageId: String(page._id),
      expectedVersion: page.version,
      section: { ...(page.sections[0] as Record<string, unknown>), settings: { headline: "x", subheadline: "y" } },
    }],
  });
  const approved = { ...proposal, status: "approved" as const, review: { decision: "approved" as const, reviewerId: String(user._id), reviewedAt: new Date().toISOString() } };
  // Change version in DB
  await Page.updateOne({ _id: page._id }, { $inc: { version: 1 } });
  await assert.rejects(
    applyApprovedEditingProposal(String(business._id), approved, { actorUserId: String(user._id) }),
  );
});

test("published-page rejection", async () => {
  const { business, user } = await setupBusiness("owner-e@example.com");
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "published",
    version: 1,
    sections: [createDefaultSection("hero", 0)],
    publishedSections: [createDefaultSection("hero", 0)],
  });
  const context = {
    pages: [{
      id: String(page._id),
      title: page.title,
      slug: page.slug,
      status: "draft" as const, // but in reality it's published; but we pass context as-is for proposal preparation? prepareEditingProposal uses context
      version: page.version,
      sections: page.sections as any[],
    }],
    allowedMediaUrls: [],
  };
  // But easier to just make proposal directly via prepare with draft context then try to apply to published page
  const proposal = prepareEditingProposal(context, {
    proposalId: "prop4",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "update-section" as const,
      pageId: String(page._id),
      expectedVersion: page.version,
      section: { ...(page.sections[0] as Record<string, unknown>), settings: { headline: "x", subheadline: "y" } },
    }],
  });
  const approved = { ...proposal, status: "approved" as const, review: { decision: "approved" as const, reviewerId: String(user._id), reviewedAt: new Date().toISOString() } };
  await assert.rejects(
    applyApprovedEditingProposal(String(business._id), approved, { actorUserId: String(user._id) }),
    /Published pages cannot be modified/,
  );
});

test("invalid section or media references are rejected", async () => {
  const { business, user } = await setupBusiness("owner-f@example.com");
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    version: 1,
    sections: [createDefaultSection("hero", 0)],
  });
  const hero = createDefaultSection("hero", 1);
  hero.settings = { headline: "h", subheadline: "s", imageUrl: `${PUBLIC_BASE}/media/${String(business._id)}/key.png` };
  // Build a minimal approved proposal structure manually
  const approved = {
    proposalId: "prop5",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "add-section" as const,
      pageId: String(page._id),
      expectedVersion: page.version,
      index: 1,
      section: hero as any,
    }],
    pageVersions: [{ pageId: String(page._id), expectedVersion: page.version }],
    diff: { changes: [{ actionId: "a1", kind: "add-section", pageId: String(page._id), sectionId: hero.id }], summary: { actionsApplied: 1, pagesCreated: 0, sectionsAdded: 1, sectionsUpdated: 0, sectionsRemoved: 0, sectionsReordered: 0 } },
    preview: {
      pages: [{
        id: String(page._id),
        title: page.title,
        slug: page.slug,
        status: "draft" as const,
        version: page.version,
        sections: [...page.sections, hero] as any[],
      }],
      allowedMediaUrls: [`${PUBLIC_BASE}/media/${String(business._id)}/key.png`],
    },
    status: "approved" as const,
    review: { decision: "approved" as const, reviewerId: String(user._id), reviewedAt: new Date().toISOString() },
  } as any;
  // Our service will revalidate media ownership via assertSectionMediaOwned - if media not in DB, it should fail
  await assert.rejects(
    applyApprovedEditingProposal(String(business._id), approved, { actorUserId: String(user._id) }),
  );
});

test("successful draft-only application and never publishes", async () => {
  const { business, user } = await setupBusiness("owner-g@example.com");
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    version: 1,
    sections: [createDefaultSection("hero", 0)],
  });
  const context = {
    pages: [{
      id: String(page._id),
      title: page.title,
      slug: page.slug,
      status: "draft" as const,
      version: page.version,
      sections: page.sections as any[],
    }],
    allowedMediaUrls: [],
  };
  const proposal = prepareEditingProposal(context, {
    proposalId: "prop6",
    summary: "test",
    actions: [{
      actionId: "a1",
      kind: "update-section" as const,
      pageId: String(page._id),
      expectedVersion: page.version,
      section: { ...(page.sections[0] as Record<string, unknown>), settings: { headline: "New", subheadline: "Text" } },
    }],
  });
  const approved = { ...proposal, status: "approved" as const, review: { decision: "approved" as const, reviewerId: String(user._id), reviewedAt: new Date().toISOString() } };
  const result = await applyApprovedEditingProposal(String(business._id), approved, { actorUserId: String(user._id) });
  assert.equal(result.applied, true);
  const updated = await Page.findById(page._id).lean();
  assert.equal(updated?.status, "draft");
  assert.deepEqual(updated?.publishedSections, []);
});
