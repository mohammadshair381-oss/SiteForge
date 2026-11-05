import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { THEME_IDS } from "@/lib/constants";
import { adoptLegacyHomepage } from "@/lib/legacy-homepage";
import { generateDefaultPages } from "@/lib/page-generation";
import { createPreviewLink, listPreviewLinks, resolvePreviewLink, revokePreviewLink } from "@/lib/preview-links";
import { toStorefrontView } from "@/lib/storefront";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { publishWebsiteItems } from "@/lib/website-publish";
import { listRevisions, recordRevision } from "@/lib/website-revisions";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { PreviewLink } from "@/models/PreviewLink";
import { Subscription } from "@/models/Subscription";
import { User } from "@/models/User";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as adoptPOST } from "@/app/api/businesses/[id]/homepage/adopt/route";
import { DELETE as pageDELETE, PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { GET as linksGET, POST as linksPOST } from "@/app/api/businesses/[id]/preview-links/route";
import { DELETE as linkDELETE } from "@/app/api/businesses/[id]/preview-links/[linkId]/route";
import { PATCH as designPATCH } from "@/app/api/businesses/[id]/design/route";
import { POST as restorePOST } from "@/app/api/businesses/[id]/revisions/[revisionId]/restore/route";

const section = (text: string) => ({ id: "s1", type: "richText", order: 0, visible: true, settings: { title: text, body: text } });
const menu = { header: [{ href: "/products", label: "Injected", order: 0 }], footer: [] };

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

async function setup(status: "draft" | "published" | "suspended" = "published", plan = true) {
  const { owner, business } = await createBusinessWithOwner({ status });
  if (plan) {
    const created = await createPlan({ price: 0, themes: [...THEME_IDS] as never });
    await createSubscription(business._id, created._id, { status: "active", currentPeriodEnd: null });
  }
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { owner, business, headers, id: String(business._id) };
}

function req(method: string, body: unknown, headers: unknown) {
  return new Request("http://localhost/x", {
    method,
    headers: { "Content-Type": "application/json", ...(headers as Record<string, string>) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const stored = async (id: string) => (await Business.findById(id).lean())!;

// ---- Published content is never written directly -----------------------------------------

for (const [field, value] of [
  ["publishedNavigation", menu],
  ["publishedDesignTokens", { fontScale: "2" }],
  ["publishedStorefront", { sections: [] }],
  ["design", { displayFont: "fraunces" }],
] as const) {
  test(`business update refuses ${field} and changes nothing`, async () => {
    const { id, headers } = await setup();
    const res = await callHandler(businessPATCH, req("PATCH", { themeSettings: { [field]: value } }, headers), ctx({ id }));
    assert.equal(res.status, 422);
    assert.equal((await stored(id)).themeSettings?.[field as never], undefined);
  });
}

test("a saved menu draft never reaches a live store, including through a combined request", async () => {
  const { id, headers } = await setup();
  const res = await callHandler(businessPATCH, req("PATCH", { themeSettings: { navigation: menu, publishedNavigation: menu } }, headers), ctx({ id }));
  assert.equal(res.status, 422);
  const saved = await callHandler(businessPATCH, req("PATCH", { themeSettings: { navigation: menu } }, headers), ctx({ id }));
  assert.equal(saved.status, 200);
  const business = await stored(id);
  assert.equal(toStorefrontView(business, [], false, [], { useDraft: false }).navigation?.header.length ?? 0, 0);
});

test("generated menus stay drafts on a live store until published", async () => {
  const { id } = await setup();
  await Business.updateOne({ _id: id }, { $set: { category: "clothing", description: "Linen clothing.", contactEmail: "hello@linen.test" } });
  await generateDefaultPages(id);
  const pages = await Page.find({ business: id }).lean();
  await Page.updateMany({ business: id }, { $set: { status: "published" } });
  const business = await stored(id);
  assert.ok((business.themeSettings?.navigation?.header?.length ?? 0) > 0);
  const live = toStorefrontView(business, [], false, pages.map((p) => ({ ...p, status: "published" as const })), { useDraft: false });
  assert.equal(live.navigation, undefined);
  assert.equal(JSON.stringify(live.theme).includes("navigationDraftOnly"), false);
});

test("live homepage sections change through the editor, while a store not yet live can still save them", async () => {
  const live = await setup();
  const refused = await callHandler(businessPATCH, req("PATCH", { themeSettings: { sections: [section("Injected")] } }, live.headers), ctx({ id: live.id }));
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { code: string }).code, "use_website_editor");
  assert.equal((await stored(live.id)).themeSettings?.sections, undefined);

  const draft = await setup("draft");
  const allowed = await callHandler(businessPATCH, req("PATCH", { themeSettings: { sections: [section("Fine")] } }, draft.headers), ctx({ id: draft.id }));
  assert.equal(allowed.status, 200);
});

test("a live store's design only changes through the draft, while its business details stay direct", async () => {
  const { id, headers } = await setup();
  const before = await stored(id);
  for (const body of [{ themeId: THEME_IDS.find((themeId) => themeId !== before.themeId) }, { themeSettings: { primaryColor: "#123456" } }, { themeSettings: { font: "serif" } }, { themeSettings: { heroHeadline: "Injected" } }]) {
    const res = await callHandler(businessPATCH, req("PATCH", body, headers), ctx({ id }));
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(((await res.json()) as { code: string }).code, "use_design_draft");
  }
  const after = await stored(id);
  assert.equal(after.themeId, before.themeId);
  assert.equal(after.themeSettings?.primaryColor, before.themeSettings?.primaryColor);
  // Sending back the values already stored is not a change.
  assert.equal((await callHandler(businessPATCH, req("PATCH", { themeId: before.themeId }, headers), ctx({ id }))).status, 200);
  // Business details are not website publishing, even with an unverified email.
  const details = await callHandler(businessPATCH, req("PATCH", { phone: "+1 555 0100" }, headers), ctx({ id }));
  assert.equal(details.status, 200);

  // A store that is not live has nothing to protect yet.
  const draftStore = await setup("draft");
  assert.equal((await callHandler(businessPATCH, req("PATCH", { themeSettings: { primaryColor: "#123456" } }, draftStore.headers), ctx({ id: draftStore.id }))).status, 200);
});

test("choosing a theme fills the draft, keeps the owner's other choices and leaves the live store alone", async () => {
  const { id, headers, owner } = await setup();
  const original = (await stored(id)).themeId;
  const next = THEME_IDS.find((themeId) => themeId !== original)!;
  const custom = await callHandler(designPATCH, req("PATCH", { useThemeColors: false, primaryColor: "#123456", accentColor: "#654321", displayFont: "fraunces" }, headers), ctx({ id }));
  assert.equal(custom.status, 200);

  const chosen = await callHandler(designPATCH, req("PATCH", { themeId: next }, headers), ctx({ id }));
  assert.equal(chosen.status, 200);
  const state = (await chosen.json()) as { draft: { themeId: string; primaryColor: string; displayFont: string }; live: { themeId: string }; hasUnpublishedChanges: boolean };
  assert.equal(state.draft.themeId, next);
  assert.equal(state.draft.primaryColor, "#123456", "the owner's colours stay");
  assert.equal(state.draft.displayFont, "fraunces", "the owner's font stays");
  assert.equal(state.live.themeId, original);
  assert.equal(state.hasUnpublishedChanges, true);

  const business = await stored(id);
  assert.equal(business.themeId, original);
  assert.equal(toStorefrontView(business, [], false, [], { useDraft: false }).themeId, original);
  assert.equal(toStorefrontView(business, [], false, [], { useDraft: true }).themeId, next);

  const result = await publishWebsiteItems(id, ["design"], owner._id);
  assert.deepEqual(result.published, ["design"]);
  const live = await stored(id);
  assert.equal(live.themeId, next);
  assert.equal(live.themeSettings?.primaryColor, "#123456");
});

test("choosing a locked theme is refused, and only known fields can be changed", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const id = String(business._id);
  await Business.updateOne({ _id: id }, { $set: { themeId: "bistro" } });
  const plan = await createPlan({ price: 0, themes: ["bistro", "market"] as never });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  assert.equal((await callHandler(designPATCH, req("PATCH", { themeId: "volt" }, headers), ctx({ id }))).status, 402);
  assert.equal((await callHandler(designPATCH, req("PATCH", { themeId: "made-up" }, headers), ctx({ id }))).status, 422);
  assert.equal((await callHandler(designPATCH, req("PATCH", { status: "published" }, headers), ctx({ id }))).status, 422);
  assert.equal((await stored(id)).themeSettings?.designDraft, undefined);
});

test("the public view carries no raw menus, and draft design tokens stay out of it", async () => {
  const { id, headers } = await setup();
  const secret = { header: [{ href: "/products", label: "Secret draft label", order: 0 }], footer: [] };
  await callHandler(businessPATCH, req("PATCH", { themeSettings: { navigation: secret, designTokens: { fontScale: "9" } } }, headers), ctx({ id }));
  const business = await stored(id);
  const view = JSON.stringify(toStorefrontView(business, [], false, [], { useDraft: false }));
  assert.equal(view.includes("Secret draft label"), false);
  assert.equal(view.includes('"fontScale":"9"'), false);
  assert.equal(JSON.stringify(toStorefrontView(business, [], false, [], { useDraft: true }).navigation).includes("Secret draft label"), true);
});

test("removing pages: a suspended store is frozen, while a lapsed plan can still take content down", async () => {
  const suspended = await setup("suspended");
  const frozen = await Page.create({ business: suspended.id, title: "About", slug: "about", status: "published", isHome: false, sections: [section("Words")], publishedSections: [section("Words")] });
  const refused = await callHandler(pageDELETE, req("DELETE", {}, suspended.headers), ctx({ id: suspended.id, pageId: String(frozen._id) }));
  assert.equal(refused.status, 403);
  assert.ok(await Page.findById(frozen._id));

  const lapsed = await setup("published", false);
  const page = await Page.create({ business: lapsed.id, title: "About", slug: "about", status: "published", isHome: false, sections: [section("Words")], publishedSections: [section("Words")] });
  assert.equal((await callHandler(pageDELETE, req("DELETE", {}, lapsed.headers), ctx({ id: lapsed.id, pageId: String(page._id) }))).status, 200);
  assert.equal(await Page.findById(page._id), null);

  // Restoring brings it back as a draft, so it cannot go live again this way.
  const [revision] = await listRevisions(lapsed.id, { target: "page", reason: "deleted" });
  assert.equal((await callHandler(restorePOST, req("POST", {}, lapsed.headers), ctx({ id: lapsed.id, revisionId: revision.id }))).status, 200);
  const restored = await Page.findOne({ business: lapsed.id, slug: "about" }).lean();
  assert.equal(restored?.status, "draft");
  assert.equal((await callHandler(pagePATCH, req("PATCH", { status: "published" }, lapsed.headers), ctx({ id: lapsed.id, pageId: String(restored!._id) }))).status, 402);
});

test("restoring a version into a published page changes only its draft, whatever the plan", async () => {
  const { id, headers } = await setup("published", false);
  const page = await Page.create({ business: id, title: "About", slug: "about", status: "published", isHome: false, sections: [section("Live")], publishedSections: [section("Live")] });
  await recordRevision({ businessId: id, target: "page", targetId: String(page._id), reason: "published", label: "Other name", snapshot: { title: "Other name", slug: "other-address", sections: [section("Old")] } });
  const [revision] = await listRevisions(id, { target: "page", targetId: String(page._id) });
  assert.equal((await callHandler(restorePOST, req("POST", {}, headers), ctx({ id, revisionId: revision.id }))).status, 200);
  const after = (await Page.findById(page._id).lean())!;
  assert.equal(after.slug, "about");
  assert.equal(after.title, "About");
  assert.equal((after.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "Live");
});

test("page publishing respects suspension and a live store's plan", async () => {
  const suspended = await setup("suspended");
  const page = await Page.create({ business: suspended.id, title: "About", slug: "about", status: "draft", isHome: false, sections: [section("Words")] });
  const refused = await callHandler(pagePATCH, req("PATCH", { status: "published" }, suspended.headers), ctx({ id: suspended.id, pageId: String(page._id) }));
  assert.equal(refused.status, 403);
  assert.equal((await Page.findById(page._id).lean())?.status, "draft");

  const lapsed = await setup("published", false);
  const other = await Page.create({ business: lapsed.id, title: "About", slug: "about", status: "draft", isHome: false, sections: [section("Words")] });
  const noPlan = await callHandler(pagePATCH, req("PATCH", { status: "published" }, lapsed.headers), ctx({ id: lapsed.id, pageId: String(other._id) }));
  assert.equal(noPlan.status, 402);
  const home = await callHandler(pagePATCH, req("PATCH", { isHome: true }, lapsed.headers), ctx({ id: lapsed.id, pageId: String(other._id) }));
  assert.equal(home.status, 402);
  const create = await callHandler(pagesPOST, req("POST", { title: "New home", isHome: true }, lapsed.headers), ctx({ id: lapsed.id }));
  assert.equal(create.status, 402);
  // Draft edits keep working.
  const draftEdit = await callHandler(pagePATCH, req("PATCH", { sections: [section("Draft")] }, lapsed.headers), ctx({ id: lapsed.id, pageId: String(other._id) }));
  assert.equal(draftEdit.status, 200);
});

// ---- Older homepages ------------------------------------------------------------------------

test("moving an older homepage keeps what visitors see and is safe to repeat", async () => {
  const { id, headers, owner } = await setup();
  const legacy = [section("Old homepage")];
  await Business.updateOne({ _id: id }, { $set: { "themeSettings.sections": legacy } });
  assert.equal((await resolveStorefrontPage(id, null)).kind, "legacy-business");

  const res = await callHandler(adoptPOST, req("POST", {}, headers), ctx({ id }));
  assert.equal(res.status, 200);
  const { pageId } = (await res.json()) as { pageId: string };
  const resolved = await resolveStorefrontPage(id, null);
  assert.equal(resolved.kind, "page");
  assert.deepEqual(resolved.kind === "page" ? resolved.sections.map((s) => s.id) : [], ["s1"]);

  const business = await stored(id);
  assert.equal(business.themeSettings?.sections, undefined);
  assert.deepEqual(business.themeSettings?.legacySections, legacy);
  assert.equal(JSON.stringify(toStorefrontView(business, [], false, [], { useDraft: false })).includes("legacySections"), false);
  assert.equal((await listRevisions(id, { target: "page", targetId: pageId })).length > 0, true);

  const again = await adoptLegacyHomepage(id, owner._id);
  assert.equal(again.pageId, pageId);
  assert.equal(await Page.countDocuments({ business: id, isHome: true }), 1);

  // A draft edit now waits for publishing.
  const edit = await callHandler(pagePATCH, req("PATCH", { sections: [section("New draft")] }, headers), ctx({ id, pageId }));
  assert.equal(edit.status, 200);
  const after = await resolveStorefrontPage(id, null);
  assert.equal(after.kind === "page" ? (after.sections[0].settings as { title: string }).title : "", "Old homepage");
});

test("a draft Home page keeps its own draft while the live sections become its published copy", async () => {
  const { id, owner } = await setup();
  await Business.updateOne({ _id: id }, { $set: { "themeSettings.sections": [section("Live old")] } });
  await Page.create({ business: id, title: "Other", slug: "other", status: "draft", isHome: false, sections: [] });
  const home = await Page.create({ business: id, title: "Home", slug: "home", status: "draft", isHome: true, sections: [section("Owner draft")] });
  await adoptLegacyHomepage(id, owner._id);
  const page = (await Page.findById(home._id).lean())!;
  assert.equal(page.status, "published");
  assert.equal((page.sections as Array<{ settings: { title: string } }>)[0].settings.title, "Owner draft");
  assert.equal((page.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "Live old");
});

test("a published Home page is never overwritten by older sections", async () => {
  const { id, owner } = await setup();
  await Business.updateOne({ _id: id }, { $set: { "themeSettings.sections": [section("Old")] } });
  const home = await Page.create({ business: id, title: "Home", slug: "home", status: "published", isHome: true, sections: [section("Current")], publishedSections: [section("Current")] });
  const result = await adoptLegacyHomepage(id, owner._id);
  assert.equal(result.pageId, String(home._id));
  const page = (await Page.findById(home._id).lean())!;
  assert.equal((page.publishedSections as Array<{ settings: { title: string } }>)[0].settings.title, "Current");
});

test("moving a homepage needs an owner or manager of that business", async () => {
  const { id, business } = await setup();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  assert.equal((await callHandler(adoptPOST, req("POST", {}, staffHeaders), ctx({ id }))).status, 403);
  const outsider = await setup();
  assert.equal((await callHandler(adoptPOST, req("POST", {}, outsider.headers), ctx({ id }))).status, 403);
});

// ---- Preview links -------------------------------------------------------------------------

test("a preview link stores only a hash and shows only through its token", async () => {
  const { id, owner, headers } = await setup();
  const res = await callHandler(linksPOST, req("POST", { scope: "site", duration: "24h" }, headers), ctx({ id }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { path: string; link: { id: string } };
  assert.match(body.path, /^\/preview#/, "the token follows #, which never reaches a server");
  const token = body.path.split("#").pop()!;
  assert.equal(token.length, 43);

  const stored = await PreviewLink.findById(body.link.id).select("+tokenHash").lean();
  assert.equal(stored?.tokenHash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal(String(stored?.createdBy), String(owner._id));

  const access = await resolvePreviewLink(token);
  assert.equal(access?.businessId, id);
  assert.equal(access?.scope, "site");

  const list = await callHandler(linksGET, req("GET", undefined, headers), ctx({ id }));
  const listed = JSON.stringify(await list.json());
  assert.equal(listed.includes(token), false);
  assert.equal(listed.includes("tokenHash"), false);
});

test("a preview link stops working when expired, revoked, or no longer permitted", async () => {
  const { id, owner, business } = await setup();
  const make = async () => (await createPreviewLink({ businessId: id, createdBy: owner._id, scope: "site", duration: "1h" }));

  assert.equal(await resolvePreviewLink("not-a-token"), null);
  assert.equal(await resolvePreviewLink("x".repeat(43)), null);
  assert.equal(await resolvePreviewLink(undefined), null);

  const expired = await make();
  await PreviewLink.collection.updateOne({ _id: new (await import("mongoose")).Types.ObjectId(expired.link.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await resolvePreviewLink(expired.token), null);

  const revoked = await make();
  await revokePreviewLink(id, revoked.link.id);
  assert.equal(await resolvePreviewLink(revoked.token), null);

  const suspended = await make();
  await Business.updateOne({ _id: id }, { $set: { status: "suspended" } });
  assert.equal(await resolvePreviewLink(suspended.token), null);
  await Business.updateOne({ _id: id }, { $set: { status: "published" } });
  assert.notEqual(await resolvePreviewLink(suspended.token), null);

  await Membership.updateOne({ business: business._id, user: owner._id }, { $set: { role: "staff" } });
  assert.equal(await resolvePreviewLink(suspended.token), null);
});

test("preview links are scoped to their business and need a verified owner or manager", async () => {
  const a = await setup();
  const b = await setup();
  const { link, token } = await createPreviewLink({ businessId: a.id, createdBy: a.owner._id, scope: "site", duration: "1h" });

  const crossDelete = await callHandler(linkDELETE, req("DELETE", {}, b.headers), ctx({ id: b.id, linkId: link.id }));
  assert.equal(crossDelete.status, 404);
  assert.notEqual(await resolvePreviewLink(token), null);
  assert.equal((await callHandler(linksGET, req("GET", undefined, b.headers), ctx({ id: a.id }))).status, 403);

  const otherPage = await Page.create({ business: b.id, title: "Theirs", slug: "theirs", status: "draft", isHome: false, sections: [] });
  const crossPage = await callHandler(linksPOST, req("POST", { scope: "page", pageId: String(otherPage._id), duration: "1h" }, a.headers), ctx({ id: a.id }));
  assert.equal(crossPage.status, 404);

  const staff = await createUser();
  await createMembership(a.business._id, staff._id, "staff");
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);
  assert.equal((await callHandler(linksPOST, req("POST", { scope: "site", duration: "1h" }, staffHeaders), ctx({ id: a.id }))).status, 403);

  await User.updateOne({ _id: a.owner._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await callHandler(linksPOST, req("POST", { scope: "site", duration: "1h" }, a.headers), ctx({ id: a.id }))).status, 403);
});

test("preview links need an active plan to create and to open", async () => {
  const lapsed = await setup("published", false);
  const refused = await callHandler(linksPOST, req("POST", { scope: "site", duration: "1h" }, lapsed.headers), ctx({ id: lapsed.id }));
  assert.equal(refused.status, 402);

  const { id, owner, business } = await setup();
  const { token } = await createPreviewLink({ businessId: id, createdBy: owner._id, scope: "site", duration: "1h" });
  assert.notEqual(await resolvePreviewLink(token), null);
  await Subscription.updateMany({ business: business._id }, { $set: { status: "canceled" } });
  assert.equal(await resolvePreviewLink(token), null);
});

test("a preview link ends when its creator's email is no longer verified or the account is off", async () => {
  const { id, owner } = await setup();
  const { token } = await createPreviewLink({ businessId: id, createdBy: owner._id, scope: "site", duration: "1h" });
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  assert.equal(await resolvePreviewLink(token), null);
  await User.updateOne({ _id: owner._id }, { $unset: { emailVerifiedAt: "" }, $set: { active: false } });
  assert.equal(await resolvePreviewLink(token), null);
  await User.updateOne({ _id: owner._id }, { $set: { active: true } });
  assert.notEqual(await resolvePreviewLink(token), null);
});

test("a single-page link shows that page only, and a bad duration is refused", async () => {
  const { id, owner, headers } = await setup();
  const page = await Page.create({ business: id, title: "About", slug: "about", status: "draft", isHome: false, sections: [section("Draft")] });
  const { token } = await createPreviewLink({ businessId: id, createdBy: owner._id, scope: "page", pageId: String(page._id), duration: "24h" });
  const access = await resolvePreviewLink(token);
  assert.equal(access?.scope, "page");
  assert.equal(access?.pageId, String(page._id));
  assert.equal((await listPreviewLinks(id))[0].pageTitle, "About");
  assert.equal((await callHandler(linksPOST, req("POST", { scope: "site", duration: "1y" }, headers), ctx({ id }))).status, 422);
});
