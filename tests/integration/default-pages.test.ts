import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { createUser } from "./helpers/fixtures";
import { GET as defaultsGET, POST as defaultsPOST } from "@/app/api/businesses/[id]/pages/defaults/route";
import { PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { publishDesignDraft, updateDesignDraft } from "@/lib/design-service";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import { THEME_IDS } from "@/lib/constants";
import { findPlaceholders } from "@/lib/page-presets";
import { generateDefaultPages, previewDefaultPages } from "@/lib/page-generation";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";

/**
 * Default pages (lib/page-presets.ts + lib/page-generation.ts): created as
 * drafts from the business type and real data, never duplicated, never
 * overwriting owner content, never public before the owner publishes, and
 * generated pages need placeholders replaced (and policy templates reviewed)
 * before they can be published.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };
type Json = Record<string, any>;

const authFor = (actor: Actor) => createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion);

async function getDefaults(id: string, actor?: Actor) {
  const headers = actor ? await authFor(actor) : {};
  const res = (await callHandler(defaultsGET as never, new Request(`http://localhost/api/businesses/${id}/pages/defaults`, { headers }), { params: Promise.resolve({ id }) } as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function postDefaults(id: string, actor: Actor, body: unknown = {}, extraHeaders: Record<string, string> = {}) {
  const headers = await authFor(actor);
  const res = (await callHandler(
    defaultsPOST as never,
    new Request(`http://localhost/api/businesses/${id}/pages/defaults`, { method: "POST", headers: { "Content-Type": "application/json", host: "localhost", ...headers, ...extraHeaders }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function patchPage(id: string, pageId: string, actor: Actor, body: unknown) {
  const headers = await authFor(actor);
  const res = (await callHandler(
    pagePATCH as never,
    new Request(`http://localhost/api/businesses/${id}/pages/${pageId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id, pageId }) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function clothingStore() {
  const ctx = await createBusinessWithOwner({ status: "published" });
  const id = String(ctx.business._id);
  await Business.updateOne(
    { _id: id },
    { $set: { category: "clothing", description: "Hand-made linen clothing.", contactEmail: "hello@linen.test", themeSettings: { sections: [{ id: "legacy-hero", type: "hero", order: 0, visible: true, settings: { headline: "Legacy homepage" } }] } } },
  );
  for (const [name, category] of [["Shirt", "Men"], ["Dress", "Women"], ["Scarf", "Women"]] as const) {
    await Product.create({ business: id, name, slug: name.toLowerCase(), price: 20, stock: 3, status: "active", category });
  }
  return { ...ctx, id };
}

test("only owners and managers of the business can see and prepare default pages", async () => {
  const { business, owner, id } = await clothingStore();
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const outsider = (await createBusinessWithOwner()).owner;

  assert.equal((await getDefaults(id)).status, 401);
  assert.equal((await getDefaults(id, owner)).status, 200);
  assert.equal((await getDefaults(id, manager)).status, 200);
  assert.equal((await getDefaults(id, staff)).status, 403);
  const crossed = await getDefaults(id, outsider);
  assert.ok(crossed.status === 403 || crossed.status === 404);

  assert.equal((await postDefaults(id, staff)).status, 403);
  const crossedPost = await postDefaults(id, outsider);
  assert.ok(crossedPost.status === 403 || crossedPost.status === 404);
  assert.equal((await postDefaults(id, owner, {}, { origin: "https://evil.example" })).status, 403, "cross-origin requests are refused");
  assert.equal((await postDefaults(id, owner, { keys: ["about"], extra: true })).status, 422, "unknown fields are refused");
  assert.equal(await Page.countDocuments({ business: id }), 0, "nothing was created by refused requests");

  const prepared = await postDefaults(id, manager, { keys: ["about"] });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
});

test("preparing pages on a legacy store keeps the live homepage, creates drafts only, and is idempotent", async () => {
  const { owner, id } = await clothingStore();
  const preview = await getDefaults(id, owner);
  assert.equal(preview.body.plan.family, "fashion");
  const keys = (preview.body.plan.pages as Array<{ key: string; status: string }>).map((p) => p.key);
  assert.ok(keys.includes("category-men") && keys.includes("category-women") && keys.includes("collections"));
  assert.ok(preview.body.plan.pages.every((p: { status: string }) => p.status === "new"));

  const first = await postDefaults(id, owner);
  assert.equal(first.status, 200);
  const result = first.body.result;
  assert.equal(result.homeCreated, true);
  assert.equal(result.created.length, keys.length);

  // The homepage still renders the legacy sections, now from a published Home page.
  const home = await resolveStorefrontPage(id, null);
  assert.equal(home.kind, "page");
  assert.deepEqual(home.kind === "page" ? home.sections.map((s) => s.id) : [], ["legacy-hero"]);
  const homeDoc = await Page.findOne({ business: id, isHome: true }).lean();
  assert.equal(homeDoc?.status, "published");
  assert.equal(homeDoc?.generated, undefined, "the home mirror is not a generated template");

  // Every generated page is a draft: nothing new is public.
  const generated = await Page.find({ business: id, "generated.key": { $exists: true } }).lean();
  assert.equal(generated.length, keys.length);
  for (const page of generated) {
    assert.equal(page.status, "draft", page.slug);
    assert.equal(page.isHome, false);
    assert.equal(page.generated?.source, "template");
    assert.equal((await resolveStorefrontPage(id, page.slug)).kind, "not-found", `${page.slug} is not public`);
  }
  const terms = generated.find((p) => p.generated?.key === "terms");
  assert.equal(terms?.slug, "terms-and-conditions", "never a reserved storefront slug");
  assert.equal(terms?.generated?.needsReview, true);

  // Draft navigation was empty, so it is filled; nothing is published.
  const business = await Business.findById(id).lean<Json>();
  assert.ok(business?.themeSettings.navigation.header.length > 0);
  assert.ok(business?.themeSettings.navigation.header.length <= 5);
  assert.ok(business?.themeSettings.navigation.footer.length > 0);
  assert.equal(business?.themeSettings.publishedNavigation, undefined, "public navigation is unchanged");

  // Second run: nothing new, nothing changed.
  const pagesBefore = await Page.find({ business: id }).sort({ _id: 1 }).lean();
  const second = await postDefaults(id, owner);
  assert.equal(second.body.result.created.length, 0);
  assert.equal(second.body.result.homeCreated, false);
  assert.deepEqual(await Page.find({ business: id }).sort({ _id: 1 }).lean(), pagesBefore);
  assert.ok((await getDefaults(id, owner)).body.plan.pages.every((p: { status: string }) => p.status === "exists"));
});

test("concurrent preparation never creates duplicate pages", async () => {
  const { id } = await clothingStore();
  const results = await Promise.all([generateDefaultPages(id), generateDefaultPages(id), generateDefaultPages(id)]);
  const pages = await Page.find({ business: id }).lean();
  const slugs = pages.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, "no duplicate slugs");
  assert.equal(pages.filter((p) => p.isHome).length, 1, "one home page");
  const created = results.flatMap((r) => r.created.map((c) => c.key));
  assert.equal(new Set(created).size, created.length, "each page is created by exactly one run");
});

test("existing owner pages and navigation are never overwritten", async () => {
  const { owner, id } = await clothingStore();
  const home = await Page.create({ business: id, title: "My home", slug: "home", isHome: true, status: "published", sections: [], publishedSections: [] });
  const about = await Page.create({ business: id, title: "Our story", slug: "about-the-brand", isHome: false, status: "published", sections: [{ id: "mine", type: "about", order: 0, visible: true, settings: { title: "Mine", body: "Owner text" } }] });
  await Business.updateOne({ _id: id }, { $set: { "themeSettings.navigation": { header: [{ pageId: String(about._id), label: "Story", order: 0 }], footer: [] } } });
  const aboutBefore = await Page.findById(about._id).lean();

  const res = await postDefaults(id, owner);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.homeCreated, false);
  assert.ok(res.body.result.existing.some((p: { key: string }) => p.key === "about"));
  assert.deepEqual(await Page.findById(about._id).lean(), aboutBefore, "owner page untouched");
  assert.equal((await Page.findById(home._id).lean())?.title, "My home");
  assert.equal(await Page.countDocuments({ business: id, isHome: true }), 1);

  const nav = (await Business.findById(id).lean<Json>())?.themeSettings.navigation;
  assert.deepEqual(nav.header, [{ pageId: String(about._id), label: "Story", order: 0 }], "the owner's header is kept");
  assert.ok(nav.footer.length > 0, "an empty footer is filled");
});

test("only the requested pages are prepared", async () => {
  const { owner, id } = await clothingStore();
  const res = await postDefaults(id, owner, { keys: ["faq", "contact", "not-a-page"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.result.created.map((p: { key: string }) => p.key).sort(), ["contact", "faq"]);
  assert.equal(await Page.countDocuments({ business: id, "generated.key": { $exists: true } }), 2);
});

test("generated pages: placeholders block publishing, policy templates need a confirmed review", async () => {
  const { owner, business, id } = await clothingStore();
  // Publishing on a live store needs an active plan.
  const plan = await createPlan({ price: 0, themes: [...THEME_IDS] });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  await generateDefaultPages(id);
  const returns = await Page.findOne({ business: id, "generated.key": "returns-policy" }).lean();
  assert.ok(returns);
  const pageId = String(returns._id);
  assert.ok(findPlaceholders(returns.sections).length > 0);

  const blocked = await patchPage(id, pageId, owner, { status: "published" });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "placeholders_remaining");

  const cleaned = JSON.parse(JSON.stringify(returns.sections).replace(/\[\[[^\]]+\]\]/g, "Returns accepted within 14 days."));
  const unreviewed = await patchPage(id, pageId, owner, { status: "published", sections: cleaned });
  assert.equal(unreviewed.status, 409);
  assert.equal(unreviewed.body.code, "review_required");
  assert.equal((await Page.findById(pageId).lean())?.status, "draft");

  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await patchPage(id, pageId, staff, { status: "published", sections: cleaned, confirmReviewed: true })).status, 403);

  const published = await patchPage(id, pageId, owner, { status: "published", sections: cleaned, confirmReviewed: true });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const stored = await Page.findById(pageId).lean();
  assert.equal(stored?.status, "published");
  assert.equal(stored?.generated?.needsReview, false);
  assert.ok(stored?.generated?.reviewedAt instanceof Date);
  assert.equal(String(stored?.generated?.reviewedBy), String(owner._id));
  const live = await resolveStorefrontPage(id, "returns-policy");
  assert.equal(live.kind, "page");

  // A non-policy page needs only its placeholders replaced.
  const contact = await Page.findOne({ business: id, "generated.key": "contact" }).lean();
  assert.deepEqual(findPlaceholders(contact?.sections), [], "contact details came from the business");
  assert.equal((await patchPage(id, String(contact?._id), owner, { status: "published" })).status, 200);
});

test("switching themes keeps every page, slug, SEO field and navigation entry", async () => {
  const { owner, business, id } = await clothingStore();
  const plan = await createPlan({ price: 0, themes: [...THEME_IDS] });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  await generateDefaultPages(id);
  const snapshot = async () => ({
    pages: await Page.find({ business: id }).sort({ _id: 1 }).select("-updatedAt").lean(),
    nav: (await Business.findById(id).lean<Json>())?.themeSettings.navigation,
  });
  const before = await snapshot();
  for (const themeId of THEME_IDS) {
    // A live store changes theme through the design draft and publishing.
    await updateDesignDraft(id, { themeId });
    await publishDesignDraft(id, { createdBy: owner._id });
    assert.deepEqual(await snapshot(), before, `${themeId}: pages and navigation unchanged`);
  }
});

test("business creation prepares the default pages as drafts; the homepage is unchanged", async () => {
  await createPlan({ key: "free", price: 0 });
  const user = await createUser();
  const headers = await authFor(user);
  const res = (await callHandler(businessesPOST, makeAuthenticatedRequest("http://localhost/api/businesses", { name: "Corner Grocer", category: "grocery", subdomain: "corner-grocer" }, headers))) as Response;
  assert.equal(res.status, 201);
  const business = await Business.findOne({ subdomain: "corner-grocer" }).lean();
  const id = String(business?._id);
  const pages = await Page.find({ business: id }).lean();
  const generated = pages.filter((p) => p.generated);
  assert.ok(generated.length >= 5, `generated ${generated.length}`);
  assert.ok(generated.every((p) => p.status === "draft"));
  assert.ok(!generated.some((p) => p.generated?.key === "offers"), "no offers page without a reduced price");
  assert.ok(!generated.some((p) => p.generated?.key?.startsWith("category-")), "no category pages without categories");
  const home = await resolveStorefrontPage(id, null);
  assert.equal(home.kind, "page");
  assert.deepEqual(home.kind === "page" ? home.sections : null, [], "an empty home renders the commerce homepage, as before");
  // The preview reports all of them as existing now.
  const preview = await previewDefaultPages(id);
  assert.ok(preview.pages.every((p) => p.status === "exists"));
});
