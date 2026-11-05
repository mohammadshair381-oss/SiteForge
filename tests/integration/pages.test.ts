import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { signSession } from "@/lib/auth/tokens";
import { createAuthHeadersForUser } from "./helpers/auth";
import { callHandler } from "./helpers/auth";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { User } from "@/models/User";
import { GET as pagesGET, POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { GET as pageGET, PATCH as pagePATCH, DELETE as pageDELETE } from "@/app/api/businesses/[id]/pages/[pageId]/route";

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
  const user = await createUser({ email: "owner@example.com", name: "Owner" });
  const business = await Business.create({
    name: "Biz",
    slug: "biz",
    subdomain: "biz",
    category: "retail",
    owner: user._id,
    description: "desc",
  });
  await Membership.create({ business: business._id, user: user._id, role: "owner", status: "active" });
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  return { user, business, headers };
}

function ctx(id: string, pageId?: string): any {
  if (pageId) return { params: Promise.resolve({ id, pageId }) };
  return { params: Promise.resolve({ id }) };
}

function req(method: string, url: string, body?: unknown, headers?: any) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test("pages: unauthenticated list returns 401", async () => {
  const { business } = await setupOwner();
  const r = new Request(`${BASE}/api/businesses/${business._id}/pages`, { method: "GET" });
  const res = await callHandler(pagesGET, r, ctx(String(business._id)));
  assert.equal(res.status, 401);
});

test("pages: owner can create and list page", async () => {
  const { business, headers } = await setupOwner();
  const createRes = await callHandler(pagesPOST, req("POST", `${BASE}/api/businesses/${business._id}/pages`, { title: "About", slug: "about" }, headers), ctx(String(business._id)));
  assert.equal(createRes.status, 201);
  const createData = await createRes.json();
  assert.equal(createData.page.title, "About");
  assert.equal(createData.page.slug, "about");
  assert.equal(createData.page.isHome, true);

  const listRes = await callHandler(pagesGET, new Request(`${BASE}/api/businesses/${business._id}/pages`, { method: "GET", headers: headers as any }), ctx(String(business._id)));
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  assert.equal(listData.pages.length, 1);
});

test("pages: duplicate slug rejected", async () => {
  const { business, headers } = await setupOwner();
  await Page.create({ business: business._id, title: "About", slug: "about", status: "draft", isHome: true, sections: [] });
  const res = await callHandler(pagesPOST, req("POST", `${BASE}/api/businesses/${business._id}/pages`, { title: "About 2", slug: "about" }, headers), ctx(String(business._id)));
  assert.ok(res.status >= 400, `expected failure got ${res.status}`);
});

test("pages: slug normalized on create", async () => {
  const { business, headers } = await setupOwner();
  const res = await callHandler(pagesPOST, req("POST", `${BASE}/api/businesses/${business._id}/pages`, { title: "Contact Us", slug: "  Contact Us  " }, headers), ctx(String(business._id)));
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.page.slug, "contact-us");
});

test("pages: cross-tenant access blocked", async () => {
  const { business } = await setupOwner();
  const other = await createUser({ email: "other@example.com", name: "Other" });
  const otherBiz = await Business.create({ name: "OtherBiz", slug: "otherbiz", subdomain: "otherbiz", category: "retail", owner: other._id, description: "d" });
  await Membership.create({ business: otherBiz._id, user: other._id, role: "owner", status: "active" });
  const otherHeaders = await createAuthHeadersForUser(String(other._id), "user", other.tokenVersion);

  const r = new Request(`${BASE}/api/businesses/${business._id}/pages`, { method: "GET", headers: otherHeaders as any });
  const res = await callHandler(pagesGET, r, ctx(String(business._id)));
  assert.equal(res.status, 403);
});

test("pages: update validation rejects bad slug", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({ business: business._id, title: "About", slug: "about", status: "draft", isHome: true, sections: [] });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { slug: "product" }, headers), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 422);
});

test("pages: delete non-homepage succeeds", async () => {
  const { business, headers } = await setupOwner();
  await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [] });
  const about = await Page.create({ business: business._id, title: "About", slug: "about", status: "draft", isHome: false, sections: [] });
  const res = await callHandler(pageDELETE, new Request(`${BASE}/api/businesses/${business._id}/pages/${about._id}`, { method: "DELETE", headers: headers as any }), ctx(String(business._id), String(about._id)));
  assert.equal(res.status, 200);
  const remaining = await Page.countDocuments({ business: business._id });
  assert.equal(remaining, 1);
});

test("pages: cannot delete only homepage", async () => {
  const { business, headers } = await setupOwner();
  const home = await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [] });
  const res = await callHandler(pageDELETE, new Request(`${BASE}/api/businesses/${business._id}/pages/${home._id}`, { method: "DELETE", headers: headers as any }), ctx(String(business._id), String(home._id)));
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "last_homepage");
});

test("pages: set homepage reassigns", async () => {
  const { business, headers } = await setupOwner();
  const home = await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [] });
  const about = await Page.create({ business: business._id, title: "About", slug: "about", status: "draft", isHome: false, sections: [] });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${about._id}`, { isHome: true }, headers), ctx(String(business._id), String(about._id)));
  assert.equal(res.status, 200);
  const newHome = await Page.findOne({ business: business._id, isHome: true }).lean();
  assert.equal(String(newHome?._id), String(about._id));
  const oldHome = await Page.findById(home._id).lean();
  assert.equal(oldHome?.isHome, false);
});

test("pages: sections persist per page", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [] });
  const sections = [{ id: "h-1", type: "hero", order: 0, visible: true, settings: { headline: "Hi" } }];
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections }, headers), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 200);
  const updated = await Page.findById(page._id).lean();
  assert.equal((updated?.sections as any[]).length, 1);
  assert.equal((updated?.sections as any[])[0].settings.headline, "Hi");
});

test("pages: business themeSettings not overwritten by page save", async () => {
  const { business, headers } = await setupOwner();
  await Business.findByIdAndUpdate(business._id, { themeSettings: { primaryColor: "#ff0000", sections: [] } });
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [] });
  await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections: [{ id: "a", type: "hero", order: 0, visible: true, settings: {} }] }, headers), ctx(String(business._id), String(page._id)));
  const biz = await Business.findById(business._id).lean();
  assert.equal((biz?.themeSettings as any)?.primaryColor, "#ff0000");
});

test("pages: stale expectedVersion returns 409", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "draft", isHome: true, sections: [], version: 5 });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections: [{ id: "a", type: "hero", order: 0, visible: true, settings: {} }], expectedVersion: 3 }, headers), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "version_conflict");
  // publishedSections unchanged
  const updated = await Page.findById(page._id).lean();
  assert.equal((updated?.sections as any[]).length, 0);
});

test("pages: valid version succeeds and increments", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "draft", isHome: true, sections: [], version: 2 });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections: [{ id: "a", type: "hero", order: 0, visible: true, settings: {} }], expectedVersion: 2 }, headers), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.page.version, 3);
  const updated = await Page.findById(page._id).lean();
  assert.equal(updated?.version, 3);
  assert.equal((updated?.sections as any[]).length, 1);
});

test("pages: publish saves the submitted section styles as the public snapshot", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    isHome: true,
    sections: [],
    version: 0,
  });
  const sections = [{
    id: "hero-1",
    type: "hero",
    order: 0,
    visible: true,
    settings: { headline: "Latest preview" },
    style: {
      elementStyles: {
        headline: { desktop: { color: "#123456", fontSize: "48px" } },
      },
    },
  }];
  const res = await callHandler(
    pagePATCH,
    req(
      "PATCH",
      `${BASE}/api/businesses/${business._id}/pages/${page._id}`,
      { sections, status: "published", expectedVersion: 0 },
      headers,
    ),
    ctx(String(business._id), String(page._id)),
  );
  assert.equal(res.status, 200);
  const updated = await Page.findById(page._id).lean();
  assert.equal(updated?.status, "published");
  assert.deepEqual(updated?.sections, updated?.publishedSections);
  assert.equal(
    (updated?.publishedSections as any[])[0].style.elementStyles.headline.desktop.color,
    "#123456",
  );
});

test("pages: unverified owner cannot publish a page", async () => {
  const { user, business, headers } = await setupOwner();
  await User.findByIdAndUpdate(user._id, { emailVerifiedAt: null });
  const page = await Page.create({
    business: business._id,
    title: "Home",
    slug: "home",
    status: "draft",
    isHome: true,
    sections: [],
  });
  const res = await callHandler(
    pagePATCH,
    req(
      "PATCH",
      `${BASE}/api/businesses/${business._id}/pages/${page._id}`,
      { status: "published" },
      headers,
    ),
    ctx(String(business._id), String(page._id)),
  );
  assert.equal(res.status, 403);
  const updated = await Page.findById(page._id).lean();
  assert.equal(updated?.status, "draft");
});

test("pages: autosave does not modify publishedSections", async () => {
  const { business, headers } = await setupOwner();
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "published", isHome: true, sections: [{ id: "old", type: "hero", order: 0, visible: true, settings: {} }], publishedSections: [{ id: "old", type: "hero", order: 0, visible: true, settings: {} }], version: 1 });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections: [{ id: "new", type: "hero", order: 0, visible: true, settings: {} }], expectedVersion: 1 }, headers), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 200);
  const updated = await Page.findById(page._id).lean();
  assert.equal((updated?.sections as any[])[0].id, "new");
  assert.equal((updated?.publishedSections as any[])[0].id, "old");
});

test("pages: advanced sections autosave, publish as a snapshot, and preserve later drafts", async () => {
  const { business, headers } = await setupOwner();
  const sections = [
    { id: "faq-1", type: "faq", order: 0, visible: true, settings: { title: "Questions", items: [{ question: "When are you open?", answer: "Check our contact page." }] } },
    { id: "testimonials-1", type: "testimonials", order: 1, visible: true, settings: { title: "Testimonials", items: [{ quote: "Customer-provided quote.", name: "A. Customer", role: "Customer" }] } },
    { id: "gallery-1", type: "gallery", order: 2, visible: true, settings: { title: "Gallery", images: [{ url: "https://images.example.com/shop.jpg", alt: "The storefront at sunset" }] } },
    { id: "pricing-1", type: "pricing", order: 3, visible: true, settings: { title: "Pricing", plans: [{ title: "Custom", price: "Contact for details", features: ["Discuss your requirements"] }] } },
    { id: "contact-1", type: "contact", order: 4, visible: true, settings: { title: "Contact", email: "hello@example.com", ctaText: "Find us", ctaHref: "/contact" } },
    { id: "newsletter-1", type: "newsletter", order: 5, visible: true, settings: { headline: "Updates", buttonText: "Visit signup page", ctaHref: "https://example.com/signup" } },
    { id: "stats-1", type: "stats", order: 6, visible: true, settings: { title: "Highlights", items: [{ value: "12", label: "Years in operation" }] } },
  ];
  const createRes = await callHandler(
    pagesPOST,
    req("POST", `${BASE}/api/businesses/${business._id}/pages`, { title: "Services", sections }, headers),
    ctx(String(business._id)),
  );
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  const pageId = String(created.page._id);

  const draftSections = sections.map((section, index) =>
    index === 0
      ? { ...section, settings: { ...section.settings, items: [{ question: "Saved draft question", answer: "Check our contact page." }] } }
      : section,
  );
  const saveRes = await callHandler(
    pagePATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${pageId}`, { sections: draftSections, expectedVersion: 0 }, headers),
    ctx(String(business._id), pageId),
  );
  assert.equal(saveRes.status, 200);

  const publishRes = await callHandler(
    pagePATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${pageId}`, { status: "published", expectedVersion: 1 }, headers),
    ctx(String(business._id), pageId),
  );
  assert.equal(publishRes.status, 200);

  const published = await Page.findById(pageId).lean();
  assert.deepEqual(
    (published?.publishedSections as { type: string }[]).map((section) => section.type),
    ["faq", "testimonials", "gallery", "pricing", "contact", "newsletter", "stats"],
  );
  assert.equal(
    ((published?.publishedSections as { settings?: { items?: { question?: string }[] } }[])[0]?.settings?.items?.[0]?.question),
    "Saved draft question",
  );

  const laterDrafts = draftSections.map((section, index) =>
    index === 0
      ? { ...section, settings: { ...section.settings, items: [{ question: "Newer draft question", answer: "Check our contact page." }] } }
      : section,
  );
  const laterSave = await callHandler(
    pagePATCH,
    req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${pageId}`, { sections: laterDrafts, expectedVersion: 2 }, headers),
    ctx(String(business._id), pageId),
  );
  assert.equal(laterSave.status, 200);
  const afterDraft = await Page.findById(pageId).lean();
  assert.equal(
    ((afterDraft?.publishedSections as { settings?: { items?: { question?: string }[] } }[])[0]?.settings?.items?.[0]?.question),
    "Saved draft question",
  );
  assert.equal(
    ((afterDraft?.sections as { settings?: { items?: { question?: string }[] } }[])[0]?.settings?.items?.[0]?.question),
    "Newer draft question",
  );
});

test("pages: staff cannot update page", async () => {
  const { business } = await setupOwner();
  const staff = await createUser({ email: "staff2@example.com", name: "Staff" });
  await Membership.create({ business: business._id, user: staff._id, role: "staff", status: "active" });
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  const page = await Page.create({ business: business._id, title: "Home", slug: "home", status: "draft", isHome: true, sections: [], version: 0 });
  const res = await callHandler(pagePATCH, req("PATCH", `${BASE}/api/businesses/${business._id}/pages/${page._id}`, { sections: [] }, staffHeaders), ctx(String(business._id), String(page._id)));
  assert.equal(res.status, 403);
});

test("pages: staff cannot create page", async () => {
  const { business } = await setupOwner();
  const staff = await createUser({ email: "staff@example.com", name: "Staff" });
  await Membership.create({ business: business._id, user: staff._id, role: "staff", status: "active" });
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  const res = await callHandler(pagesPOST, req("POST", `${BASE}/api/businesses/${business._id}/pages`, { title: "X" }, staffHeaders), ctx(String(business._id)));
  assert.equal(res.status, 403);
});