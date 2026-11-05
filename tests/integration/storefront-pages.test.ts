import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner } from "./helpers/tenant";
import { POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { getSitemapForHost, getStorefrontPageMetadata } from "@/lib/seo";
import { createPlan, createSubscription } from "./helpers/tenant";
import { Page } from "@/models/Page";

/**
 * What the public storefront renders for a page, end to end: pages are created
 * and published through the real API routes, then resolved exactly as
 * `app/store/[[...slug]]/page.tsx` does. Draft content must never be public.
 */

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

const BASE = "http://localhost";

function section(id: string, headline: string, visible = true) {
  return { id, type: "hero", order: 0, visible, settings: { headline } };
}

async function setup() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const id = String(business._id);
  return { business, id, headers, host: `${business.subdomain}.localhost:3000` };
}

function json(method: string, url: string, body: unknown, headers: { cookie: string }) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createPage(id: string, headers: { cookie: string }, body: Record<string, unknown>) {
  const res = (await callHandler(
    pagesPOST,
    json("POST", `${BASE}/api/businesses/${id}/pages`, body, headers),
    { params: Promise.resolve({ id }) },
  )) as Response;
  assert.equal(res.status, 201);
  return String((await res.json()).page._id);
}

async function patchPage(id: string, pageId: string, headers: { cookie: string }, body: Record<string, unknown>) {
  const res = (await callHandler(
    pagePATCH,
    json("PATCH", `${BASE}/api/businesses/${id}/pages/${pageId}`, body, headers),
    { params: Promise.resolve({ id, pageId }) },
  )) as Response;
  assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(await res.clone().json())}`);
}

const headlines = (resolution: Awaited<ReturnType<typeof resolveStorefrontPage>>) =>
  resolution.kind === "page"
    ? resolution.sections.map((s) => (s.settings as { headline?: string }).headline)
    : resolution.kind;

test("1. a page published with an empty snapshot and then draft-edited renders the theme default, not the draft", async () => {
  const { business, id, headers, host } = await setup();
  await createPage(id, headers, { title: "Home", isHome: true });
  const aboutId = await createPage(id, headers, { title: "About", slug: "about" });

  // Publish with no sections, then edit the draft without republishing.
  await patchPage(id, aboutId, headers, { status: "published" });
  await patchPage(id, aboutId, headers, { sections: [section("d1", "SECRET DRAFT")] });

  const stored = await Page.findById(aboutId).lean();
  assert.deepEqual(stored?.publishedSections, []);
  assert.equal((stored?.sections as unknown[]).length, 1);

  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, "about")), []);
  // The sitemap does not advertise it either.
  const urls = (await getSitemapForHost(host)).map((entry) => entry.url);
  assert.equal(urls.some((url) => url.endsWith("/about")), false);
});

test("2. published content is rendered, not a newer draft", async () => {
  const { business, id, headers } = await setup();
  const homeId = await createPage(id, headers, {
    title: "Home",
    isHome: true,
    sections: [section("h1", "Published headline")],
  });
  await patchPage(id, homeId, headers, { status: "published" });
  await patchPage(id, homeId, headers, { sections: [section("h2", "Unpublished edit")] });

  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, null)), ["Published headline"]);
});

test("3. a legacy page without a snapshot field still renders its stored sections", async () => {
  const { business, id, headers } = await setup();
  const pageId = await createPage(id, headers, {
    title: "Legacy",
    slug: "legacy",
    sections: [section("l1", "Legacy live content")],
  });
  // Simulate a record written before snapshots existed: published, no field.
  await Page.collection.updateOne(
    { _id: (await Page.findById(pageId))!._id },
    { $set: { status: "published" }, $unset: { publishedSections: "" } },
  );

  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, "legacy")), ["Legacy live content"]);
});

test("4. a snapshot with only hidden sections renders the theme default, never the visible draft", async () => {
  const { business, id, headers } = await setup();
  const pageId = await createPage(id, headers, {
    title: "Hidden",
    slug: "hidden",
    sections: [section("x1", "Hidden published", false)],
  });
  await patchPage(id, pageId, headers, { status: "published" });
  await patchPage(id, pageId, headers, { sections: [section("x2", "Visible draft")] });

  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, "hidden")), []);
});

test("5. drafts, missing pages, and other tenants' pages are not found; legacy businesses keep legacy mode", async () => {
  const a = await setup();
  const b = await setup();
  await createPage(a.id, a.headers, { title: "Draft only", slug: "draft-only", sections: [section("s", "Draft")] });
  const bPage = await createPage(b.id, b.headers, { title: "B page", slug: "b-page", sections: [section("b", "B")] });
  await patchPage(b.id, bPage, b.headers, { status: "published" });

  assert.equal(headlines(await resolveStorefrontPage(a.business._id, "draft-only")), "not-found");
  assert.equal(headlines(await resolveStorefrontPage(a.business._id, "missing")), "not-found");
  assert.equal(headlines(await resolveStorefrontPage(a.business._id, "b-page")), "not-found");
  assert.deepEqual(headlines(await resolveStorefrontPage(b.business._id, "b-page")), ["B"]);

  const legacy = await setup();
  assert.equal(headlines(await resolveStorefrontPage(legacy.business._id, null)), "legacy-business");
  assert.equal(headlines(await resolveStorefrontPage(legacy.business._id, "anything")), "not-found");
});

test("6. republishing replaces the empty snapshot with the current draft", async () => {
  const { business, id, headers } = await setup();
  const pageId = await createPage(id, headers, { title: "Later", slug: "later" });
  await patchPage(id, pageId, headers, { status: "published" });
  await patchPage(id, pageId, headers, { sections: [section("n1", "Now published")] });
  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, "later")), []);

  await patchPage(id, pageId, headers, { status: "published" });
  assert.deepEqual(headlines(await resolveStorefrontPage(business._id, "later")), ["Now published"]);
});

test("the commerce homepage stays available until a published Home page exists", async () => {
  const { business, id, headers, host } = await setup();
  const homepage = () => resolveStorefrontPage(business._id, null);
  assert.equal((await homepage()).kind, "legacy-business");

  // A store's first page is a draft Home (also what the planner creates).
  const homeId = await createPage(id, headers, { title: "Home", sections: [section("h1", "DRAFT HOME")] });
  assert.equal((await Page.findById(homeId).lean())?.isHome, true);
  assert.equal((await homepage()).kind, "legacy-business", "`/` keeps rendering and shows no draft");
  assert.equal(headlines(await resolveStorefrontPage(business._id, "home")), "not-found", "the draft is not public");
  const origin = `http://${host}`;
  assert.deepEqual((await getStorefrontPageMetadata(host, null)).alternates, { canonical: `${origin}/` });
  assert.ok((await getSitemapForHost(host)).some((entry) => entry.url === `${origin}/`));

  await patchPage(id, homeId, headers, { status: "published" });
  assert.deepEqual(headlines(await homepage()), ["DRAFT HOME"], "the published Home page takes over");
});

test("a store with only non-home draft pages keeps its homepage; other paths still 404", async () => {
  const { business } = await setup();
  await Page.create({ business: business._id, title: "About", slug: "about", isHome: false, status: "draft", sections: [section("a1", "SECRET")] });
  assert.equal((await resolveStorefrontPage(business._id, null)).kind, "legacy-business");
  assert.equal(headlines(await resolveStorefrontPage(business._id, "about")), "not-found");
  assert.equal(headlines(await resolveStorefrontPage(business._id, "missing")), "not-found");
});
