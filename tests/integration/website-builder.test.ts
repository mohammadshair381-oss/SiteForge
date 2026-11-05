import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import { THEME_IDS } from "@/lib/constants";
import { toStorefrontView } from "@/lib/storefront";
import { findPageRedirect } from "@/lib/storefront-pages";
import { getDesignState, publishDesignDraft, saveDesignDraft } from "@/lib/design-service";
import { websiteStatus, publishWebsiteItems } from "@/lib/website-publish";
import { recordRevision, listRevisions } from "@/lib/website-revisions";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { WebsiteRevision } from "@/models/WebsiteRevision";
import { GET as revisionsGET } from "@/app/api/businesses/[id]/revisions/route";
import { POST as restorePOST } from "@/app/api/businesses/[id]/revisions/[revisionId]/restore/route";
import { POST as duplicatePOST } from "@/app/api/businesses/[id]/pages/[pageId]/duplicate/route";
import { POST as revertPOST } from "@/app/api/businesses/[id]/pages/[pageId]/revert/route";
import { PATCH as pagePATCH, DELETE as pageDELETE } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { PUT as designPUT } from "@/app/api/businesses/[id]/design/route";
import { POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";

const BASE = "http://localhost";
const section = (text: string) => ({ id: "s1", type: "richText", order: 0, visible: true, settings: { title: text, body: text } });

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

async function setup(themes: readonly string[] = THEME_IDS) {
  const { owner, business } = await createBusinessWithOwner();
  const plan = await createPlan({ price: 0, themes: [...themes] as never });
  await createSubscription(business._id, plan._id, { status: "active" });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { owner, business, headers, id: String(business._id) };
}

function req(method: string, path: string, body: unknown, headers: unknown) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;

async function livePage(businessId: unknown, slug = "about", text = "Live words") {
  return Page.create({ business: businessId, title: "About", slug, status: "published", isHome: false, sections: [section(text)], publishedSections: [section(text)] });
}

test("duplicate: a new draft with its own address; the original is untouched", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  const res = await callHandler(duplicatePOST, req("POST", `/x`, {}, headers), ctx({ id, pageId: String(page._id) }));
  assert.equal(res.status, 201);
  const copy = await Page.findOne({ business: id, slug: "about-copy" }).lean();
  assert.ok(copy);
  assert.equal(copy.status, "draft");
  assert.equal(copy.isHome, false);
  assert.equal((await Page.findById(page._id).lean())?.status, "published");
});

test("a store's first page from a template does not replace the store homepage", async () => {
  const { id, headers } = await setup();
  const res = await callHandler(pagesPOST, req("POST", "/x", { title: "About", template: "about" }, headers), ctx({ id }));
  assert.equal(res.status, 201);
  const page = await Page.findOne({ business: id }).lean();
  assert.equal(page?.isHome, false);
  assert.equal(page?.status, "draft");
});

test("saving a first menu draft leaves what visitors see unchanged", async () => {
  const { id, headers } = await setup();
  const header = [{ href: "/products", label: "Shop", order: 0 }];
  const res = await callHandler(businessPATCH, req("PATCH", "/x", { themeSettings: { navigation: { header, footer: [] } } }, headers), ctx({ id }));
  assert.equal(res.status, 200);
  const stored = await Business.findById(id).lean();
  assert.deepEqual(stored?.themeSettings?.publishedNavigation, { header: [], footer: [] });
  assert.equal(toStorefrontView(stored!, [], false, [], { useDraft: false }).navigation?.header.length ?? 0, 0);
  assert.equal(toStorefrontView(stored!, [], false, [], { useDraft: true }).navigation?.header.length, 1);
});

test("another business's page or revision cannot be reached", async () => {
  const mine = await setup();
  const { business: other } = await createBusinessWithOwner();
  const theirs = await livePage(other._id, "theirs");
  await recordRevision({ businessId: String(other._id), target: "page", targetId: String(theirs._id), reason: "published", label: "Theirs", snapshot: { title: "Theirs", slug: "theirs", sections: [] } });
  const revision = await WebsiteRevision.findOne({ business: other._id }).lean();

  const dup = await callHandler(duplicatePOST, req("POST", "/x", {}, mine.headers), ctx({ id: mine.id, pageId: String(theirs._id) }));
  assert.equal(dup.status, 404);
  const restore = await callHandler(restorePOST, req("POST", "/x", {}, mine.headers), ctx({ id: mine.id, revisionId: String(revision!._id) }));
  assert.equal(restore.status, 404);
  const list = await callHandler(revisionsGET, req("GET", `/x?target=page&targetId=${theirs._id}`, undefined, mine.headers), ctx({ id: mine.id }));
  assert.deepEqual(((await list.json()) as { revisions: unknown[] }).revisions, []);
  // Reaching someone else's business itself is refused outright.
  const foreign = await callHandler(revisionsGET, req("GET", "/x", undefined, mine.headers), ctx({ id: String(other._id) }));
  assert.equal(foreign.status, 403);
});

test("going back to published replaces the draft only and keeps the draft in history", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  await Page.updateOne({ _id: page._id }, { $set: { sections: [section("Draft words")] } });
  const res = await callHandler(revertPOST, req("POST", "/x", {}, headers), ctx({ id, pageId: String(page._id) }));
  assert.equal(res.status, 200);
  const after = await Page.findById(page._id).lean();
  assert.equal((after!.sections as Array<{ settings: { title: string } }>)[0].settings.title, "Live words");
  assert.equal(after!.status, "published");
  const history = await listRevisions(id, { target: "page", targetId: String(page._id) });
  assert.equal(history.some((item) => item.reason === "before_revert"), true);
});

test("restoring a version changes the draft and never what visitors see", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  await recordRevision({ businessId: id, target: "page", targetId: String(page._id), reason: "published", label: "About", snapshot: { title: "About", slug: "about", sections: [section("Old words")] } });
  const revision = await WebsiteRevision.findOne({ business: id }).lean();
  const res = await callHandler(restorePOST, req("POST", "/x", {}, headers), ctx({ id, revisionId: String(revision!._id) }));
  assert.equal(res.status, 200);
  const restored = await Page.findById(page._id).lean();
  assert.equal((restored!.sections as Array<{ settings: { title: string } }>)[0].settings.title, "Old words");
  assert.equal((restored!.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "Live words");
});

test("a deleted page can be brought back as a draft", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  const del = await callHandler(pageDELETE, req("DELETE", "/x", {}, headers), ctx({ id, pageId: String(page._id) }));
  assert.equal(del.status, 200);
  const [deleted] = await listRevisions(id, { target: "page", reason: "deleted" });
  assert.ok(deleted);
  const res = await callHandler(restorePOST, req("POST", "/x", {}, headers), ctx({ id, revisionId: deleted.id }));
  assert.equal(res.status, 200);
  const back = await Page.findOne({ business: id, slug: "about" }).lean();
  assert.equal(back?.status, "draft");
});

test("changing a published page's address keeps the old one working", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  const res = await callHandler(pagePATCH, req("PATCH", "/x", { slug: "our-story", expectedVersion: page.version }, headers), ctx({ id, pageId: String(page._id) }));
  assert.equal(res.status, 200);
  assert.equal(await findPageRedirect(id, "about"), "/our-story");
  assert.equal(await findPageRedirect(id, "our-story"), null);
  assert.equal(await findPageRedirect(id, "nothing"), null);
});

test("an address already in use is refused", async () => {
  const { id, headers, business } = await setup();
  const page = await livePage(business._id);
  await livePage(business._id, "taken");
  const res = await callHandler(pagePATCH, req("PATCH", "/x", { slug: "taken", expectedVersion: page.version }, headers), ctx({ id, pageId: String(page._id) }));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "slug_taken");
});

test("a design draft shows in previews only until it is published", async () => {
  const { id, owner } = await setup();
  const original = (await Business.findById(id).lean())!.themeId;
  const nextTheme = THEME_IDS.find((themeId) => themeId !== original)!;
  await saveDesignDraft(id, { themeId: nextTheme, useThemeColors: false, primaryColor: "#123456", accentColor: "#654321", displayFont: "fraunces", bodyFont: "theme", buttonShape: "pill", textSize: "large" });

  const draftStore = (await Business.findById(id).lean())!;
  const publicView = toStorefrontView(draftStore, [], false, [], { useDraft: false });
  assert.equal(publicView.themeId, original);
  assert.notEqual(publicView.theme.primaryColor, "#123456");
  assert.equal(JSON.stringify(publicView).includes("designDraft"), false);
  assert.equal(JSON.stringify(publicView).includes("fraunces"), false);

  const preview = toStorefrontView(draftStore, [], false, [], { useDraft: true });
  assert.equal(preview.themeId, nextTheme);
  assert.equal(preview.theme.primaryColor, "#123456");
  assert.equal((await getDesignState(id)).hasUnpublishedChanges, true);

  await publishDesignDraft(id, { createdBy: owner._id, requirePlan: false });
  const live = (await Business.findById(id).lean())!;
  const liveView = toStorefrontView(live, [], false, [], { useDraft: false });
  assert.equal(liveView.themeId, nextTheme);
  assert.equal(liveView.theme.primaryColor, "#123456");
  assert.equal((await getDesignState(id)).hasUnpublishedChanges, false);
});

test("a theme outside the plan cannot be saved to the design draft", async () => {
  const allowed = THEME_IDS.slice(0, 3);
  const { id, headers } = await setup(allowed);
  await Business.updateOne({ _id: id }, { $set: { themeId: allowed[0] } });
  const locked = THEME_IDS.find((themeId) => !allowed.includes(themeId))!;
  const state = await getDesignState(id);
  const res = await callHandler(designPUT, req("PUT", "/x", { ...state.draft, themeId: locked }, headers), ctx({ id }));
  assert.equal(res.status, 402);
  assert.equal((await Business.findById(id).lean())!.themeId, allowed[0]);
});

test("the publish overview lists differences and publishes only what is chosen", async () => {
  const { id, business, owner } = await setup();
  const edited = await livePage(business._id);
  const other = await livePage(business._id, "other");
  await Page.updateOne({ _id: edited._id }, { $set: { sections: [section("New words")] } });
  await Page.updateOne({ _id: other._id }, { $set: { sections: [section("Other new words")] } });

  const status = await websiteStatus(id);
  const keys = status.items.map((item) => item.key);
  assert.equal(keys.includes(`page:${edited._id}`), true);
  assert.equal(keys.includes(`page:${other._id}`), true);

  const result = await publishWebsiteItems(id, [`page:${edited._id}`], owner._id);
  assert.deepEqual(result.published, [`page:${edited._id}`]);
  const editedAfter = await Page.findById(edited._id).lean();
  const otherAfter = await Page.findById(other._id).lean();
  assert.equal((editedAfter!.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "New words");
  assert.equal((otherAfter!.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "Live words");
});

test("staff cannot use the version history", async () => {
  const { id, business } = await setup();
  const { createUser } = await import("./helpers/fixtures");
  const { createMembership } = await import("./helpers/tenant");
  const staff = await createUser({ email: "staff@example.com", name: "Staff" });
  await createMembership(business._id, staff._id, "staff");
  const headers = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  const res = await callHandler(revisionsGET, req("GET", "/x", undefined, headers), ctx({ id }));
  assert.equal(res.status, 403);
});
