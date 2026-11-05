import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { Page } from "@/models/Page";
import { getStorefrontPageMetadata } from "@/lib/seo";

/**
 * Page SEO: draft/published separation, authorization, tenant isolation and
 * the public metadata that storefront routes emit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

function ctx(id: string, pageId: string) {
  return { params: Promise.resolve({ id, pageId }) };
}

function patch(businessId: string, pageId: string, body: unknown, headers: { cookie: string }) {
  return callHandler(
    pagePATCH,
    new Request(`http://localhost/api/businesses/${businessId}/pages/${pageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(businessId, pageId),
  ) as Promise<Response>;
}

async function setup(options: { published?: boolean } = {}) {
  const { owner, business } = await createBusinessWithOwner({ status: options.published === false ? "draft" : "published" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS),
  });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const page = await Page.create({
    business: business._id,
    title: "About us",
    slug: "about",
    isHome: false,
    status: "draft",
    sections: [{ id: "hero-1", type: "hero", order: 0, visible: true, settings: { headline: "Hi" } }],
    version: 0,
  });
  const home = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    isHome: true,
    status: "published",
    sections: [],
    publishedSections: [],
    version: 0,
  });
  const host = `${business.subdomain}.localhost:3000`;
  return { owner, business, headers, page, home, host };
}

test("saving SEO is draft-only: it never publishes and never changes the live snapshot", async () => {
  const { business, headers, page, host } = await setup();
  const res = await patch(String(business._id), String(page._id), {
    seoTitle: "Draft only",
    seoDescription: "Not live yet",
    expectedVersion: 0,
  }, headers);
  assert.equal(res.status, 200);

  const stored = await Page.findById(page._id).lean();
  assert.equal(stored?.status, "draft");
  assert.equal(stored?.seoTitle, "Draft only");
  assert.equal(stored?.publishedSeoTitle, undefined);

  // The draft page is not public, so its metadata is the generic fallback.
  const meta = await getStorefrontPageMetadata(host, "about");
  assert.notDeepEqual(meta.title, { absolute: "Draft only" });
});

test("publishing snapshots SEO; later draft edits stay hidden from visitors", async () => {
  const { business, headers, page, host } = await setup();
  const id = String(business._id);

  assert.equal((await patch(id, String(page._id), { seoTitle: "Our story", seoDescription: "How we began.", expectedVersion: 0 }, headers)).status, 200);
  assert.equal((await patch(id, String(page._id), { status: "published", expectedVersion: 1 }, headers)).status, 200);

  const live = await getStorefrontPageMetadata(host, "about");
  assert.deepEqual(live.title, { absolute: "Our story" });
  assert.equal(live.description, "How we began.");

  assert.equal((await patch(id, String(page._id), { seoTitle: "Newer draft title", expectedVersion: 2 }, headers)).status, 200);
  const stillLive = await getStorefrontPageMetadata(host, "about");
  assert.deepEqual(stillLive.title, { absolute: "Our story" }, "unpublished SEO edits are not visible");

  const stored = await Page.findById(page._id).lean();
  assert.equal(stored?.seoTitle, "Newer draft title");
  assert.equal(stored?.publishedSeoTitle, "Our story");
});

test("a legacy published page without a snapshot falls back to its SEO fields; no SEO uses business fallbacks", async () => {
  const { business, page, host } = await setup();
  await Page.collection.updateOne(
    { _id: page._id },
    { $set: { status: "published", seoTitle: "Legacy title", seoDescription: "Legacy desc" } },
  );
  const legacy = await getStorefrontPageMetadata(host, "about");
  assert.deepEqual(legacy.title, { absolute: "Legacy title" });

  await Page.collection.updateOne({ _id: page._id }, { $set: { seoTitle: "", seoDescription: "" } });
  const fallback = await getStorefrontPageMetadata(host, "about");
  assert.deepEqual(fallback.title, { absolute: `About us | ${business.name}` });

  const homeMeta = await getStorefrontPageMetadata(host, null);
  assert.deepEqual(homeMeta.title, { absolute: business.name });
});

test("metadata is withheld for an unpublished business", async () => {
  const { business, page, host } = await setup({ published: false });
  await Page.updateOne({ _id: page._id }, { $set: { status: "published", publishedSeoTitle: "Secret" } });
  assert.ok(business);
  assert.deepEqual(await getStorefrontPageMetadata(host, "about"), {});
});

test("SEO input is validated server-side", async () => {
  const { business, headers, page } = await setup();
  const tooLong = await patch(String(business._id), String(page._id), { seoTitle: "x".repeat(161) }, headers);
  assert.equal(tooLong.status, 422);
  const tooLongDesc = await patch(String(business._id), String(page._id), { seoDescription: "x".repeat(321) }, headers);
  assert.equal(tooLongDesc.status, 422);
  assert.equal((await Page.findById(page._id).lean())?.seoTitle, "");
});

test("stale SEO saves are rejected with a version conflict", async () => {
  const { business, headers, page } = await setup();
  assert.equal((await patch(String(business._id), String(page._id), { seoTitle: "A", expectedVersion: 0 }, headers)).status, 200);
  const stale = await patch(String(business._id), String(page._id), { seoTitle: "B", expectedVersion: 0 }, headers);
  assert.equal(stale.status, 409);
  assert.equal((await Page.findById(page._id).lean())?.seoTitle, "A");
});

test("staff cannot edit SEO and another tenant cannot touch the page", async () => {
  const { business, page } = await setup();

  const staff = await createUser({ email: "seo-staff@example.com", name: "Staff" });
  await createMembership(business._id, staff._id, "staff");
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  assert.equal((await patch(String(business._id), String(page._id), { seoTitle: "Nope" }, staffHeaders)).status, 403);

  const other = await createBusinessWithOwner({});
  const otherHeaders = await createAuthHeadersForUser(String(other.owner._id), "user", other.owner.tokenVersion);
  // Own business id with the victim's page id: the page is not found in that tenant.
  const crossPage = await patch(String(other.business._id), String(page._id), { seoTitle: "Hijack" }, otherHeaders);
  assert.equal(crossPage.status, 404);
  // Victim business id: not a member.
  const crossBiz = await patch(String(business._id), String(page._id), { seoTitle: "Hijack" }, otherHeaders);
  assert.ok([403, 404].includes(crossBiz.status));
  assert.equal((await Page.findById(page._id).lean())?.seoTitle, "");
});
