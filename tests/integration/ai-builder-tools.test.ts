import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import React from "react";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { clearRequestCookies, setRequestCookiesFromHeader } from "./helpers/mock-next-headers-setup";
import { POST as aiPagePOST } from "@/app/api/businesses/[id]/ai/page/route";
import { POST as aiSeoPOST } from "@/app/api/businesses/[id]/ai/seo/route";
import { GET as aiThemeGET, POST as aiThemePOST } from "@/app/api/businesses/[id]/ai/theme/route";
import { POST as productCopyPOST } from "@/app/api/businesses/[id]/ai/product-copy/route";
import { POST as reviewPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/review/route";
import { POST as applyPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/apply/route";
import { GET as proposalGET } from "@/app/api/businesses/[id]/proposals/[proposalId]/route";
import { PATCH as pagePATCH } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { PUT as categoryPUT } from "@/app/api/businesses/[id]/categories/[categoryId]/route";
import AdminAiUsagePage from "@/app/admin/ai-usage/page";
import { AI_CONSENT_VERSION, grantAiConsent, revokeAiConsent } from "@/lib/ai-builder/consent";
import { usagePeriod, usageId } from "@/lib/ai-builder/usage";
import { getAiUsageOverview, recentPeriods } from "@/lib/admin/ai-usage";
import { getCategoryMetadata, getProductMetadata } from "@/lib/seo";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { presetConfig } from "@/lib/storefront-config";
import { AiUsage } from "@/models/AiUsage";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { ProductCategory } from "@/models/ProductCategory";
import { Media } from "@/models/Media";
import { WebsiteProposal } from "@/models/WebsiteProposal";

(globalThis as unknown as { React?: typeof React }).React = React;
const MEDIA_BASE = "https://cdn.test";
process.env.AWS_S3_PUBLIC_URL = MEDIA_BASE;

/**
 * AI Builder tools (pages, SEO, themes, product modes, admin usage) against a
 * FAKE provider: global fetch is replaced and any request that is not to the
 * Gemini host fails the test, so nothing leaves the process. This verifies the
 * code paths around Gemini; it says nothing about real Gemini output.
 */

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; body: string }> = [];
let replies: Array<() => Response> = [];
const gemini = (value: unknown) => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    }),
    { status: 200 },
  );

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.AI_PROVIDER_ENABLED;
  delete process.env.GEMINI_API_KEY;
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  process.env.GEMINI_API_KEY = "test-gemini-key-SECRET123";
  process.env.AWS_S3_PUBLIC_URL = MEDIA_BASE;
  calls.length = 0;
  replies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected network request: ${url}`);
    calls.push({ url, body: String(init?.body ?? "") });
    const next = replies.shift();
    if (!next) throw new Error("no fake provider reply queued");
    return next();
  }) as typeof fetch;
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };

let ipCounter = 0;
async function call(handler: unknown, method: string, path: string, params: Record<string, string>, actor: Actor | null, body?: unknown, options: { origin?: string } = {}) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  ipCounter += 1;
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${path}`, {
      method,
      headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": `198.19.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`, ...(options.origin ? { origin: options.origin } : {}), ...auth },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function store(planOptions: { key?: string; price?: number } = { key: "pro", price: 49 }) {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const plan = (planOptions.key ? await Plan.findOne({ key: planOptions.key }) : null) ?? (await createPlan(planOptions));
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const id = String(business._id);
  await Business.updateOne(
    { _id: id },
    {
      $set: {
        category: "clothing",
        description: "Relaxed everyday clothing.",
        contactEmail: "owner-contact@example.com",
        phone: "+1 555 019 9999",
        address: "1 Mill Lane",
        "themeSettings.storefront": presetConfig("clothing"),
        "themeSettings.publishedStorefront": presetConfig("clothing"),
      },
    },
  );
  const [shirt] = await Product.create([
    { business: id, name: "Linen Shirt", slug: "linen-shirt", price: 40, stock: 5, status: "active", category: "Shirts", description: "Relaxed fit linen shirt.", sku: "SKU-SECRET-1", imageUrl: "https://cdn.test/shirt.png" },
    { business: id, name: "Chino", slug: "chino", price: 55, compareAtPrice: 70, stock: 5, status: "active", category: "Trousers" },
  ]);
  await grantAiConsent({ businessId: id, actorId: String(owner._id), version: AI_CONSENT_VERSION });
  return { owner, business, id, shirt, host: `${business.subdomain}.localhost:3000` };
}

/** An image in this business's own media library. */
async function ownedImage(id: string, name = "photo.webp"): Promise<string> {
  const storageKey = `media/${id}/${name}`;
  await Media.create({ business: id, storageKey, originalName: name, mimeType: "image/webp", size: 128 });
  return `${MEDIA_BASE}/${storageKey}`;
}

const askPage = (id: string, actor: Actor | null, body: Record<string, unknown>, options: { origin?: string } = {}) => call(aiPagePOST, "POST", `/api/businesses/${id}/ai/page`, { id }, actor, body, options);
const askSeo = (id: string, actor: Actor | null, body: Record<string, unknown>) => call(aiSeoPOST, "POST", `/api/businesses/${id}/ai/seo`, { id }, actor, body);
const askTheme = (id: string, actor: Actor | null, instruction = "Which theme is best for my luxury clothing store?") => call(aiThemePOST, "POST", `/api/businesses/${id}/ai/theme`, { id }, actor, { instruction });
const review = (id: string, proposalId: string, actor: Actor, decision: "approve" | "reject") => call(reviewPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/review`, { id, proposalId }, actor, { decision });
const apply = (id: string, proposalId: string, actor: Actor) => call(applyPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/apply`, { id, proposalId }, actor, {});
const usageDoc = (id: string) => AiUsage.findById(usageId(id, usagePeriod())).lean();

/** The settings of a stored page's first section. */
const settingsOf = (sections: unknown) => ((sections as Array<{ settings: Record<string, string> }> | null | undefined)?.[0]?.settings ?? {}) as Record<string, string>;

const ABOUT_ANSWER = {
  summary: "An About page from your description.",
  title: "About us",
  sections: [
    { type: "about", title: "Our story", body: "We make relaxed everyday clothing. [[Add when and why you started]]" },
    { type: "products", title: "Shirts", category: "shirts" },
    { type: "contact", title: "Get in touch", description: "We would love to hear from you." },
  ],
  notes: ["When did you start?"],
};

// ---------------------------------------------------------------------------
// Page builder
// ---------------------------------------------------------------------------

test("a new page: a pending proposal with no store change; applied as an AI draft that cannot publish with placeholders", async () => {
  const { owner, id } = await store();
  await Page.create({ business: id, title: "Home", slug: "home", isHome: true, status: "published", sections: [], publishedSections: [] });
  replies = [gemini(ABOUT_ANSWER)];
  const created = await askPage(id, owner, { instruction: "Create an About Us page for my clothing brand" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const proposal = created.body.proposal;
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.source, "ai");
  assert.equal(proposal.request, "Create an About Us page for my clothing brand");
  assert.deepEqual(created.body.notes, ["When did you start?"]);
  assert.equal(await Page.countDocuments({ business: id }), 1, "nothing is written before approval");

  // Privacy: contact details, prices, SKUs and keys never reach the provider.
  const sent = calls[0].body;
  for (const secret of ["owner-contact@example.com", "555 019", "1 Mill Lane", "SKU-SECRET-1", "test-gemini-key"]) assert.ok(!sent.includes(secret), secret);
  assert.ok(!calls[0].url.includes("test-gemini-key"), "the key is never in the URL");
  assert.ok(sent.includes("Linen Shirt") && sent.includes("Relaxed everyday clothing"), "approved data is sent");

  // Applying needs approval first.
  assert.equal((await apply(id, proposal.id, owner)).status, 409);
  assert.equal((await review(id, proposal.id, owner, "approve")).status, 200);
  const applied = await apply(id, proposal.id, owner);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const page = await Page.findOne({ business: id, slug: "about-us" }).lean();
  assert.ok(page);
  assert.equal(page.status, "draft", "never published");
  assert.equal(page.generated?.source, "ai", "AI content is identified");
  const contact = (page.sections as Array<{ type: string; settings: Record<string, string> }>).find((s) => s.type === "contact")!;
  assert.equal(contact.settings.email, "owner-contact@example.com", "filled on the server from the business");
  assert.equal((await resolveStorefrontPage(id, "about-us")).kind, "not-found", "drafts are not public");

  const blocked = await call(pagePATCH, "PATCH", `/api/businesses/${id}/pages/${page._id}`, { id, pageId: String(page._id) }, owner, { status: "published" });
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "placeholders_remaining");

  const usage = await usageDoc(id);
  assert.equal(usage?.requests, 1);
  assert.equal(usage?.successes, 1);
  assert.equal(usage?.tasks.page, 1);
});

test("the first page of a store without pages keeps its homepage", async () => {
  const { owner, id } = await store();
  assert.equal(await Page.countDocuments({ business: id }), 0);
  assert.equal((await resolveStorefrontPage(id, null)).kind, "legacy-business");
  replies = [gemini(ABOUT_ANSWER)];
  const { body } = await askPage(id, owner, { instruction: "Create an About Us page" });
  await review(id, body.proposal.id, owner, "approve");
  assert.equal((await apply(id, body.proposal.id, owner)).status, 200);
  const home = await resolveStorefrontPage(id, null);
  assert.equal(home.kind, "page", "`/` still renders");
  assert.deepEqual(home.kind === "page" ? home.sections : null, [], "an empty home is the commerce homepage, as before");
  assert.equal(await Page.countDocuments({ business: id, isHome: true }), 1);
});

test("invented facts and unsupported output are refused: no proposal, recorded as rejected", async () => {
  const { owner, id } = await store();
  const cases: Array<[unknown, string]> = [
    [{ summary: "s", title: "About", sections: [{ type: "about", body: "Founded in 1998 with a lifetime warranty on every order." }] }, "unsupported_claims"],
    [{ summary: "s", title: "About", sections: [{ type: "about", body: "<script>alert(1)</script>" }] }, "invalid_suggestion"],
    [{ summary: "s", title: "About", sections: [{ type: "testimonials", items: [{ quote: "Great", author: "A" }] }] }, "invalid_suggestion"],
    [{ summary: "s", title: "About", sections: [{ type: "contact", email: "fake@example.com" }] }, "invalid_suggestion"],
    [{ summary: "s", title: "About", sections: [{ type: "products", category: "Spaceships" }] }, "unknown_category"],
    ["not json at all", "invalid_response"],
  ];
  let n = 0;
  for (const [answer, code] of cases) {
    replies = [gemini(answer)];
    const res = await askPage(id, owner, { instruction: "Create an About page" });
    assert.equal(res.status, 422, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code);
    n += 1;
  }
  assert.equal(await WebsiteProposal.countDocuments({ business: id }), 0);
  const usage = await usageDoc(id);
  assert.equal(usage?.rejected, n);
  assert.equal(usage?.successes, 0);
});

test("improving a draft page: only the listed text changes; stale proposals never overwrite newer owner changes", async () => {
  const { owner, id } = await store();
  const image = await ownedImage(id);
  const draft = await Page.create({
    business: id, title: "About", slug: "about", status: "draft",
    sections: [{ id: "about-1", type: "about", order: 0, visible: true, settings: { title: "Story", body: "Old body", imageUrl: image, imageAlt: "Team" } }],
  });
  const pageId = String(draft._id);
  const answer = { summary: "A clearer story.", changes: [{ op: "update", sectionId: "about-1", set: { body: "We make relaxed everyday clothing." } }], notes: [] };
  replies = [gemini(answer)];
  const first = await askPage(id, owner, { instruction: "Improve the content on this page", pageId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(settingsOf((await Page.findById(pageId).lean())?.sections).body, "Old body", "nothing changes before approval");

  // A rejected proposal never touches the draft.
  assert.equal((await review(id, first.body.proposal.id, owner, "reject")).status, 200);
  assert.equal((await apply(id, first.body.proposal.id, owner)).status, 409);
  assert.equal(settingsOf((await Page.findById(pageId).lean())?.sections).body, "Old body");

  // The owner edits after the proposal was made: it goes stale and cannot apply.
  replies = [gemini(answer)];
  const second = await askPage(id, owner, { instruction: "Improve the content on this page", pageId });
  assert.equal((await call(pagePATCH, "PATCH", `/api/businesses/${id}/pages/${pageId}`, { id, pageId }, owner, { title: "About the team" })).status, 200);
  const detail = await call(proposalGET, "GET", `/api/businesses/${id}/proposals/${second.body.proposal.id}`, { id, proposalId: second.body.proposal.id }, owner);
  assert.equal(detail.body.proposal.stale, true);
  const stale = await review(id, second.body.proposal.id, owner, "approve");
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(settingsOf((await Page.findById(pageId).lean())?.sections).body, "Old body");

  // A fresh one applies, keeps the image, and stays a draft.
  replies = [gemini(answer)];
  const third = await askPage(id, owner, { instruction: "Improve the content on this page", pageId });
  await review(id, third.body.proposal.id, owner, "approve");
  assert.equal((await apply(id, third.body.proposal.id, owner)).status, 200);
  const page = await Page.findById(pageId).lean();
  assert.equal(page?.status, "draft");
  assert.equal(settingsOf(page?.sections).body, "We make relaxed everyday clothing.");
  assert.equal(settingsOf(page?.sections).imageUrl, image);
  assert.equal(page?.title, "About the team", "the owner's edit is kept");
});

test("an answer with no changes explains why and stores nothing", async () => {
  const { owner, id } = await store();
  const draft = await Page.create({ business: id, title: "About", slug: "about", status: "draft", sections: [{ id: "a", type: "about", order: 0, visible: true, settings: { body: "x" } }] });
  replies = [gemini({ summary: "That cannot be done with these sections.", changes: [], notes: [] })];
  const res = await askPage(id, owner, { instruction: "Add a video background", pageId: String(draft._id) });
  assert.equal(res.status, 200);
  assert.equal(res.body.proposal, null);
  assert.equal(res.body.message, "That cannot be done with these sections.");
  assert.equal(await WebsiteProposal.countDocuments({ business: id }), 0);
});

test("a published page stays live: the improved version is a new draft, and the live page does not change", async () => {
  const { owner, id } = await store();
  const image = await ownedImage(id);
  const sections = [{ id: "about-1", type: "about", order: 0, visible: true, settings: { title: "Story", body: "Live body", imageUrl: image, imageAlt: "Team" } }];
  const live = await Page.create({ business: id, title: "About", slug: "about", status: "published", sections, publishedSections: sections });
  const pageId = String(live._id);

  const refused = await askPage(id, owner, { instruction: "Improve this page", pageId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "page_published");
  assert.equal(calls.length, 0, "refused before anything is sent or charged");
  assert.equal(await AiUsage.countDocuments(), 0);

  replies = [gemini({ summary: "Sharper.", changes: [{ op: "update", sectionId: "about-1", set: { body: "New body" } }], notes: [] })];
  const created = await askPage(id, owner, { instruction: "Improve this page", pageId, asNewDraft: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await review(id, created.body.proposal.id, owner, "approve");
  assert.equal((await apply(id, created.body.proposal.id, owner)).status, 200);

  const copy = await Page.findOne({ business: id, slug: "about-new" }).lean();
  assert.equal(copy?.status, "draft");
  assert.equal(copy?.title, "About (new version)");
  assert.equal(settingsOf(copy?.sections).body, "New body");
  assert.equal(settingsOf(copy?.sections).imageUrl, image, "the store's own image is kept in the copy");
  const unchanged = await Page.findById(pageId).lean();
  assert.equal(unchanged?.status, "published");
  assert.equal(settingsOf(unchanged?.sections).body, "Live body");
  assert.equal(settingsOf(unchanged?.publishedSections).body, "Live body");
});

test("a page with an image from outside the media library gets a clear answer and uses no request", async () => {
  const { owner, id } = await store();
  const other = await store();
  for (const imageUrl of ["https://external.example.test/photo.webp", await ownedImage(other.id, "theirs.webp")]) {
    const page = await Page.create({ business: id, title: `P ${imageUrl.length}`, slug: `p-${imageUrl.length}`, status: "draft", sections: [{ id: "a", type: "about", order: 0, visible: true, settings: { body: "x", imageUrl } }] });
    const res = await askPage(id, owner, { instruction: "Improve this page", pageId: String(page._id) });
    assert.equal(res.status, 409, imageUrl);
    assert.equal(res.body.code, "page_media_not_supported");
  }
  assert.equal(calls.length, 0);
  assert.equal(await AiUsage.countDocuments(), 0);
});

test("page requests: the homepage goes elsewhere; other tenants' pages are not found", async () => {
  const { owner, id } = await store();
  const home = await Page.create({ business: id, title: "Home", slug: "home", isHome: true, status: "published", sections: [], publishedSections: [] });
  assert.equal((await askPage(id, owner, { instruction: "Improve this page", pageId: String(home._id) })).body.code, "page_is_home");
  const other = await store();
  const theirs = await Page.create({ business: other.id, title: "Secret", slug: "secret", status: "draft", sections: [] });
  assert.equal((await askPage(id, owner, { instruction: "Improve this page", pageId: String(theirs._id) })).status, 404);
  assert.equal(calls.length, 0);
});

test("every new AI route has the same guards: AI off, no consent, roles, tenants, origin, allowance", async () => {
  const { owner, business, id, shirt } = await store();
  const routes: Array<(actor: Actor | null, options?: { origin?: string }) => Promise<{ status: number; body: Record<string, any> }>> = [
    (actor, options) => askPage(id, actor, { instruction: "Create an About page" }, options),
    (actor, options) => call(aiSeoPOST, "POST", `/api/businesses/${id}/ai/seo`, { id }, actor, { kind: "product", targetId: String(shirt._id) }, options),
    (actor, options) => call(aiThemePOST, "POST", `/api/businesses/${id}/ai/theme`, { id }, actor, { instruction: "Which theme?" }, options),
  ];
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const outsider = (await createBusinessWithOwner()).owner;

  for (const route of routes) {
    assert.equal((await route(null)).status, 401);
    assert.equal((await route(owner, { origin: "https://evil.example" })).body.code, "csrf_failed");
    assert.equal((await route(staff)).status, 403);
    assert.equal((await route(outsider)).status, 403);
    process.env.AI_PROVIDER_ENABLED = "TRUE";
    assert.equal((await route(owner)).body.code, "provider_not_configured");
    process.env.AI_PROVIDER_ENABLED = "true";
  }
  await revokeAiConsent({ businessId: id, actorId: String(owner._id) });
  for (const route of routes) assert.equal((await route(owner)).body.code, "ai_consent_required");
  await grantAiConsent({ businessId: id, actorId: String(owner._id), version: AI_CONSENT_VERSION });

  await Plan.updateMany({}, { $set: { "features.aiRequestsPerMonth": 0 } });
  for (const route of routes) assert.equal((await route(owner)).body.code, "ai_not_in_plan");
  await Plan.updateMany({}, { $set: { "features.aiRequestsPerMonth": 1 } });
  await AiUsage.deleteMany({});
  await AiUsage.collection.insertOne({ _id: usageId(id, usagePeriod()) as never, business: business._id, period: usagePeriod(), requests: 1, successes: 1, failures: 0, rejected: 0, tasks: {} });
  for (const route of routes) assert.equal((await route(owner)).body.code, "ai_quota_exceeded");
  assert.equal(calls.length, 0, "nothing was sent");
});

test("a provider failure is recorded and leaves the store unchanged", async () => {
  const { owner, id } = await store();
  replies = [() => new Response(JSON.stringify({ error: { code: 500, status: "INTERNAL", message: "secret upstream detail" } }), { status: 500 })];
  const res = await askPage(id, owner, { instruction: "Create an About page" });
  assert.ok(res.status >= 500 || res.status === 429, `status ${res.status}`);
  assert.ok(!JSON.stringify(res.body).includes("secret upstream detail"), "fixed messages only");
  assert.equal((await usageDoc(id))?.failures, 1);
  assert.equal(await WebsiteProposal.countDocuments({ business: id }), 0);
});

// ---------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------

const SEO_ANSWER = { summary: "Clear and specific.", seoTitle: "Linen Shirt | Relaxed fit", seoDescription: "A relaxed fit linen shirt from our everyday clothing range.", description: "Everyday linen.", imageAlt: "Linen shirt on a hanger", notes: [] };

test("SEO suggestions are never saved by the server; the owner saves through the normal routes", async () => {
  const { owner, id, shirt, host } = await store();
  await Product.updateOne({ _id: shirt._id }, { $set: { seoTitle: "Owner title" } });

  replies = [gemini(SEO_ANSWER)];
  const res = await askSeo(id, owner, { kind: "product", targetId: String(shirt._id) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, false);
  assert.equal(res.body.current.seoTitle, "Owner title");
  assert.equal(res.body.suggestion.seoTitle, SEO_ANSWER.seoTitle);
  assert.equal(res.body.suggestion.imageAlt, SEO_ANSWER.imageAlt);
  assert.equal(res.body.suggestion.description, undefined, "products have no SEO page description");
  assert.equal((await Product.findById(shirt._id).lean())?.seoTitle, "Owner title", "the existing text is kept until replaced");
  assert.ok(!calls[0].body.includes("SKU-SECRET-1"));
  assert.equal((await usageDoc(id))?.tasks.seo, 1);

  // Explicit save, then the store uses it.
  const saved = await call(productPATCH, "PATCH", `/api/businesses/${id}/products/${shirt._id}`, { id, productId: String(shirt._id) }, owner, { seoTitle: "Linen Shirt | Relaxed fit", seoDescription: SEO_ANSWER.seoDescription, imageAlt: SEO_ANSWER.imageAlt });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = await Product.findById(shirt._id).lean();
  assert.equal(stored?.price, 40, "other fields are untouched");
  assert.equal(stored?.stock, 5);
  const meta = await getProductMetadata(host, "linen-shirt");
  assert.deepEqual(meta.title, { absolute: "Linen Shirt | Relaxed fit" });
  assert.equal(meta.description, SEO_ANSWER.seoDescription);
  assert.match(String(meta.alternates?.canonical), /\/product\/linen-shirt$/, "the canonical URL does not change");
});

test("SEO for pages and categories; misleading or malformed text is refused; other tenants are not found", async () => {
  const { owner, id, host } = await store();
  const page = await Page.create({ business: id, title: "About", slug: "about", status: "draft", sections: [{ id: "a", type: "about", order: 0, visible: true, settings: { body: "We make clothing." } }] });
  replies = [gemini(SEO_ANSWER)];
  const onPage = await askSeo(id, owner, { kind: "page", targetId: String(page._id) });
  assert.equal(onPage.status, 200);
  assert.equal(onPage.body.suggestion.description, SEO_ANSWER.description);
  assert.equal(onPage.body.suggestion.imageAlt, undefined);
  assert.equal((await Page.findById(page._id).lean())?.seoTitle ?? "", "");

  const category = await ProductCategory.create({ business: id, name: "Shirts", slug: "shirts", description: "All our shirts.", active: true, sort: 0, seoTitle: "Keep me" });
  replies = [gemini(SEO_ANSWER)];
  const onCategory = await askSeo(id, owner, { kind: "category", targetId: String(category._id) });
  assert.equal(onCategory.status, 200);
  assert.equal(onCategory.body.current.seoTitle, "Keep me");
  assert.equal((await ProductCategory.findById(category._id).lean())?.seoTitle, "Keep me");

  // An ordinary category edit (no SEO fields) keeps the SEO text; an explicit save changes it.
  const path = `/api/businesses/${id}/categories/${category._id}`;
  const params = { id, categoryId: String(category._id) };
  assert.equal((await call(categoryPUT, "PUT", path, params, owner, { name: "Shirts", slug: "shirts", description: "New text", active: true })).status, 200);
  assert.equal((await ProductCategory.findById(category._id).lean())?.seoTitle, "Keep me");
  assert.equal((await call(categoryPUT, "PUT", path, params, owner, { name: "Shirts", slug: "shirts", description: "New text", active: true, seoTitle: "Shirts | Linen", seoDescription: "Linen shirts." })).status, 200);
  const meta = await getCategoryMetadata(host, "shirts");
  assert.deepEqual(meta.title, { absolute: "Shirts | Linen" });
  assert.equal(meta.description, "Linen shirts.");

  for (const [bad, code] of [
    [{ ...SEO_ANSWER, seoTitle: "x".repeat(71) }, "invalid_suggestion"],
    [{ ...SEO_ANSWER, seoTitle: "[[Add a title]]" }, "invalid_suggestion"],
    [{ ...SEO_ANSWER, seoDescription: "The award-winning store with free shipping on every order." }, "unsupported_claims"],
  ] as const) {
    replies = [gemini(bad)];
    const res = await askSeo(id, owner, { kind: "page", targetId: String(page._id) });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, code);
  }

  const other = await store();
  for (const [kind, target] of [["page", await Page.create({ business: other.id, title: "S", slug: "s", status: "draft", sections: [] })], ["product", other.shirt]] as const) {
    assert.equal((await askSeo(id, owner, { kind, targetId: String(target._id) })).status, 404, kind);
  }
});

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

const seedTiers = async () => {
  await Plan.create({ key: "starter", name: "Starter", price: 19, currency: "USD", sort: 1, features: { productLimit: 10, staffLimit: 1 } });
  await Plan.create({ key: "pro", name: "Pro", price: 49, currency: "USD", sort: 2, features: { productLimit: 10, staffLimit: 1 } });
};

test("theme advice on a Free store: locked themes are not selectable and name their plan; the API still refuses them", async () => {
  const { owner, id } = await store({ key: "free", price: 0 });
  await seedTiers();
  await Business.updateOne({ _id: id }, { $set: { themeId: "studio" } });
  replies = [gemini({ summary: "Atelier fits a luxury brand; Studio is close on your plan.", recommendations: [{ themeId: "atelier", reason: "Editorial." }, { themeId: "studio", reason: "Minimal." }, { themeId: "market", reason: "Practical." }], notes: [] })];
  const res = await askTheme(id, owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.source, "ai");
  assert.equal(res.body.applied, false);
  const [atelier, studio, market] = res.body.recommendations;
  assert.deepEqual([atelier.themeId, atelier.selectable, atelier.requiredPlan?.name], ["atelier", false, "Pro"]);
  assert.deepEqual([studio.themeId, studio.selectable, studio.current], ["studio", true, true]);
  assert.deepEqual([market.themeId, market.selectable], ["market", true]);
  assert.equal((await Business.findById(id).lean())?.themeId, "studio", "nothing is saved");
  assert.equal((await usageDoc(id))?.tasks.theme, 1);

  const refused = await call(businessPATCH, "PATCH", `/api/businesses/${id}`, { id }, owner, { themeId: "atelier" });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, "theme_not_in_plan");
  // An included theme goes through the draft on a live store.
  const direct = await call(businessPATCH, "PATCH", `/api/businesses/${id}`, { id }, owner, { themeId: "market" });
  assert.equal(direct.status, 409);
  assert.equal(direct.body.code, "use_design_draft");

  for (const bad of [{ summary: "s", recommendations: [{ themeId: "made-up", reason: "x" }] }, { summary: "s", recommendations: [] }]) {
    replies = [gemini(bad)];
    assert.equal((await askTheme(id, owner)).body.code, "invalid_suggestion");
  }
});

test("recommendations without AI work with AI off and send nothing; staff and other tenants are refused", async () => {
  const { owner, business, id } = await store({ key: "free", price: 0 });
  await seedTiers();
  delete process.env.AI_PROVIDER_ENABLED;
  const path = `/api/businesses/${id}/ai/theme`;
  const res = await call(aiThemeGET, "GET", path, { id }, owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.source, "catalog");
  assert.equal(res.body.recommendations[0].themeId, "atelier");
  assert.equal(res.body.recommendations[0].selectable, false);
  assert.equal(res.body.recommendations[0].requiredPlan.name, "Pro");
  assert.equal(calls.length, 0);
  assert.equal(await AiUsage.countDocuments(), 0);
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await call(aiThemeGET, "GET", path, { id }, staff)).status, 403);
  assert.equal((await call(aiThemeGET, "GET", path, { id }, (await createBusinessWithOwner()).owner)).status, 403);
});

// ---------------------------------------------------------------------------
// Product text
// ---------------------------------------------------------------------------

test("product modes: highlights and SEO come back unsaved; invented specifications are refused", async () => {
  const { owner, id, shirt } = await store();
  const ask = (body: Record<string, unknown>) => call(productCopyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId: String(shirt._id), ...body });
  replies = [gemini({ summary: "Shorter.", description: "A relaxed linen shirt.", highlights: ["Relaxed fit", "Linen"], seoTitle: "Linen Shirt", seoDescription: "A relaxed fit linen shirt.", missing: ["What sizes are available?"] })];
  const res = await ask({ mode: "highlights", instruction: "Keep it short" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.applied, false);
  assert.equal(res.body.mode, "highlights");
  assert.deepEqual(res.body.suggestion.highlights, ["Relaxed fit", "Linen"]);
  assert.equal(res.body.suggestion.seoTitle, "Linen Shirt");
  assert.deepEqual(res.body.missing, ["What sizes are available?"]);
  assert.match(calls[0].body, /3 to 6 short highlights/);
  assert.ok(calls[0].body.includes("Keep it short"));
  const stored = await Product.findById(shirt._id).lean();
  assert.equal(stored?.description, "Relaxed fit linen shirt.", "nothing is saved");
  assert.equal(stored?.seoTitle ?? "", "");

  replies = [gemini({ description: "A relaxed linen shirt.", highlights: ["Organic cotton blend", "Lifetime warranty"], missing: [] })];
  const invented = await ask({ mode: "highlights" });
  assert.equal(invented.status, 422);
  assert.equal(invented.body.code, "unsupported_claims");

  assert.equal((await ask({ mode: "not-a-mode" })).status, 422);
  // Older callers without a mode keep working.
  replies = [gemini({ description: "A relaxed linen shirt.", missing: [] })];
  assert.equal((await ask({})).status, 200);
});

// ---------------------------------------------------------------------------
// Super Admin usage
// ---------------------------------------------------------------------------

test("admin usage: real stored counters per business, plan and month; no prompts, no costs", async () => {
  const a = await store();
  const b = await store({ key: "free", price: 0 });
  await Plan.updateOne({ key: "pro" }, { $set: { "features.aiRequestsPerMonth": 10 } });
  const period = usagePeriod();
  const now = new Date();
  const earlier = recentPeriods(2, now)[1];
  await AiUsage.collection.insertMany([
    { _id: usageId(a.id, period) as never, business: a.business._id, period, requests: 9, successes: 7, failures: 1, rejected: 1, tasks: { page: 5, seo: 4 }, promptTokens: 900, outputTokens: 300, totalTokens: 1200, tokenReports: 8 },
    { _id: usageId(b.id, period) as never, business: b.business._id, period, requests: 2, successes: 2, failures: 0, rejected: 0, tasks: { theme: 2 }, promptTokens: 0, outputTokens: 0, totalTokens: 0, tokenReports: 0 },
    { _id: usageId(a.id, earlier) as never, business: a.business._id, period: earlier, requests: 3, successes: 3, failures: 0, rejected: 0, tasks: { storefront: 3 } },
  ]);
  const data = await getAiUsageOverview(period, now);
  assert.equal(data.totals.requests, 11);
  assert.equal(data.totals.successes, 9);
  assert.equal(data.totals.failures, 1);
  assert.equal(data.totals.rejected, 1);
  assert.equal(data.totals.businesses, 2);
  assert.equal(data.totals.totalTokens, 1200);
  assert.equal(data.totals.tokenReports, 8);
  assert.equal(data.rows[0].businessId, a.id, "most used first");
  assert.deepEqual([data.rows[0].limit, data.rows[0].remaining, data.rows[0].planName], [10, 1, `Plan pro`]);
  assert.deepEqual(data.approaching.map((r) => r.businessId), [a.id], "90% used");
  assert.deepEqual(data.byPlan.map((p) => [p.planName, p.requests]), [["Plan pro", 9], ["Plan free", 2]]);
  assert.deepEqual(data.byTask.find((t) => t.task === "page"), { task: "page", requests: 5 });
  assert.equal(data.months.length, 6);
  assert.equal(data.months[0].requests, 11);
  assert.equal(data.months[1].requests, 3);
  const json = JSON.stringify(data);
  for (const forbidden of ["cost", "prompt\":", "owner-contact", "instruction", "test-gemini-key"]) assert.ok(!json.includes(forbidden), forbidden);
});

test("admin usage page: super admins only", async () => {
  const redirected = async () => {
    try {
      await AdminAiUsagePage({ searchParams: Promise.resolve({}) });
      return false;
    } catch (error) {
      return String((error as { digest?: unknown }).digest ?? (error as Error).message).includes("NEXT_REDIRECT");
    }
  };
  clearRequestCookies();
  assert.equal(await redirected(), true, "anonymous");
  const user = await createUser();
  const auth = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  setRequestCookiesFromHeader(auth.cookie);
  assert.equal(await redirected(), true, "ordinary user");
  const admin = await createUser({ email: `admin-${Date.now()}@test.com`, platformRole: "super_admin" });
  const adminAuth = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  setRequestCookiesFromHeader(adminAuth.cookie);
  const element = await AdminAiUsagePage({ searchParams: Promise.resolve({ period: "not-a-month" }) });
  assert.ok(element, "renders for a super admin; an invalid month falls back to this month");
  clearRequestCookies();
});

test("the saved address never reaches Gemini from product descriptions or SEO content", async () => {
  const { owner, id, shirt } = await store();
  await Product.updateOne({ _id: shirt._id }, { $set: { description: "Relaxed fit. Collect it from 1 mill  lane any day." } });
  replies = [
    gemini({ summary: "Clearer.", description: "Relaxed fit linen shirt.", missing: [] }),
    gemini({ summary: "Clear.", seoTitle: "Linen Shirt", seoDescription: "A relaxed fit linen shirt from our store.", notes: [] }),
  ];
  const copied = await call(productCopyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId: String(shirt._id), instruction: "Mention 1 Mill Lane" });
  assert.equal(calls.length, 1, JSON.stringify(copied.body));
  await askSeo(id, owner, { kind: "product", targetId: String(shirt._id) });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(!/mill\s+lane/i.test(call.body), "the saved address is removed");
    assert.match(call.body, /contact details removed/);
    assert.match(call.body, /Relaxed fit/, "the rest of the text is kept");
  }
});
