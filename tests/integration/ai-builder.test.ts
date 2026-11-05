import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as aiStorefrontPOST } from "@/app/api/businesses/[id]/ai/storefront/route";
import { POST as productCopyPOST } from "@/app/api/businesses/[id]/ai/product-copy/route";
import { GET as proposalsGET } from "@/app/api/businesses/[id]/proposals/route";
import { GET as proposalGET } from "@/app/api/businesses/[id]/proposals/[proposalId]/route";
import { POST as reviewPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/review/route";
import { POST as applyPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/apply/route";
import { PUT as setupPUT } from "@/app/api/businesses/[id]/setup/route";
import { getStorefrontSettings, saveStorefrontDraft } from "@/lib/storefront-settings";
import { AI_CONSENT_VERSION, grantAiConsent } from "@/lib/ai-builder/consent";
import { presetConfig } from "@/lib/storefront-config";
import { AiUsage } from "@/models/AiUsage";
import { Business } from "@/models/Business";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { RateLimit } from "@/models/RateLimit";
import { User } from "@/models/User";
import { WebsiteProposal } from "@/models/WebsiteProposal";

/**
 * AI builder: homepage suggestions, product copy, usage limits and the setup
 * progress route, against a FAKE provider (global fetch replaced; any request
 * that is not to the Gemini host fails the test, so nothing leaves the process).
 */

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let replies: Array<() => Response> = [];
const gemini = (value: unknown) => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
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
  calls.length = 0;
  replies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected network request: ${url}`);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    const next = replies.shift();
    if (!next) throw new Error("no fake provider reply queued");
    return next();
  }) as typeof fetch;
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };
let ipCounter = 0;

async function call(
  handler: unknown,
  method: string,
  path: string,
  params: Record<string, string>,
  actor: Actor | null,
  body?: unknown,
  options: { origin?: string; contentType?: string } = {},
) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  ipCounter += 1;
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        host: "localhost",
        "content-type": options.contentType ?? "application/json",
        "x-forwarded-for": `198.18.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...auth,
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function store() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  await Business.updateOne(
    { _id: business._id },
    { $set: { category: "clothing", description: "Relaxed everyday clothing.", contactEmail: "owner-contact@example.com", phone: "+1 555 0199", "themeSettings.storefront": presetConfig("clothing"), "themeSettings.publishedStorefront": presetConfig("clothing") } },
  );
  await Product.create([
    { business: business._id, name: "Linen Shirt", slug: "linen-shirt", price: 40, stock: 5, status: "active", category: "Shirts", description: "Relaxed fit linen shirt." },
    { business: business._id, name: "Chino", slug: "chino", price: 55, compareAtPrice: 70, stock: 5, status: "active", category: "Trousers" },
  ]);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  return { owner, business, id: String(business._id) };
}

const suggest = (id: string, actor: Actor | null, instruction = "Make the hero shorter and show new arrivals first", options: { origin?: string; contentType?: string } = {}) =>
  call(aiStorefrontPOST, "POST", `/api/businesses/${id}/ai/storefront`, { id }, actor, { instruction }, options);
const review = (id: string, proposalId: string, actor: Actor, decision: "approve" | "reject") =>
  call(reviewPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/review`, { id, proposalId }, actor, { decision });
const apply = (id: string, proposalId: string, actor: Actor) => call(applyPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/apply`, { id, proposalId }, actor, {});

const GOOD_CHANGES = {
  summary: "A shorter hero, new arrivals first and a darker primary colour.",
  changes: [
    { op: "hero", set: { headline: "Everyday clothing, relaxed", description: "" } },
    { op: "move", sectionId: "new-arrivals", toIndex: 0 },
    { op: "brand", set: { primaryColor: "#111827" } },
  ],
  notes: ["Which category should the hero button open?"],
};

test("AI is off by default: nothing is sent, and no rate-limit or usage budget is spent", async () => {
  const { owner, id } = await store();
  for (const value of [undefined, "false", "TRUE", " true", "true "]) {
    if (value === undefined) delete process.env.AI_PROVIDER_ENABLED;
    else process.env.AI_PROVIDER_ENABLED = value;
    const res = await suggest(id, owner);
    assert.equal(res.status, 503, String(value));
    assert.equal(res.body.code, "provider_not_configured");
    const product = await Product.findOne({ business: id }).lean();
    assert.equal((await call(productCopyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId: String(product!._id) })).status, 503);
  }
  process.env.AI_PROVIDER_ENABLED = "true";
  delete process.env.GEMINI_API_KEY;
  assert.equal((await suggest(id, owner)).status, 503, "a flag without a key sends nothing");
  assert.equal(calls.length, 0);
  assert.equal(await AiUsage.countDocuments(), 0);
  assert.equal(await RateLimit.countDocuments(), 0, "the kill switch is checked before any rate limit");
});

test("guards: same-origin JSON, owner or manager of THIS business, verified email, not suspended", async () => {
  const { owner, business, id } = await store();
  const other = await createBusinessWithOwner();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await suggest(id, owner, "Change it", { origin: "https://evil.example" })).body.code, "csrf_failed");
  assert.equal((await suggest(id, owner, "Change it", { contentType: "text/plain" })).status, 415);
  assert.equal((await suggest(id, staff)).status, 403, "staff");
  assert.equal((await suggest(id, other.owner)).status, 403, "another business");
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await suggest(id, owner)).status, 403, "unverified email");
  await User.updateOne({ _id: owner._id }, { $unset: { emailVerifiedAt: 1 } });
  await Business.updateOne({ _id: business._id }, { $set: { status: "suspended" } });
  assert.equal((await suggest(id, owner)).body.code, "suspended");
  assert.equal(calls.length, 0);
});

test("a request becomes a PENDING homepage proposal; approve + apply changes only the draft (and the stated brand)", async () => {
  const { owner, id } = await store();
  const before = await getStorefrontSettings(id);
  replies.push(gemini(GOOD_CHANGES));
  const created = await suggest(id, owner);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const proposal = created.body.proposal;
  assert.equal(proposal.target, "storefront");
  assert.equal(proposal.source, "ai");
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.request, "Make the hero shorter and show new arrivals first");
  assert.equal(proposal.diff.live, true, "the brand change is flagged as store-wide");
  assert.deepEqual(proposal.notes, GOOD_CHANGES.notes);

  // What was sent: key in a header only; owner text delimited; no contact data.
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes("SECRET123") && !calls[0].url.includes("key="));
  assert.equal(calls[0].headers["x-goog-api-key"], "test-gemini-key-SECRET123");
  const sent = JSON.parse(calls[0].body);
  const promptText = sent.contents[0].parts[0].text as string;
  assert.ok(promptText.includes("<owner_request>") && promptText.includes("Make the hero shorter"));
  assert.ok(!promptText.includes("owner-contact@example.com") && !promptText.includes("555 0199"), "no contact details");
  assert.ok(sent.systemInstruction.parts[0].text.includes("Never invent facts"));

  // Usage: counters only.
  const usage = await AiUsage.findOne({ business: id }).lean();
  assert.equal(usage?.requests, 1);
  assert.equal(usage?.successes, 1);
  assert.equal(usage?.totalTokens, 160);
  assert.ok(!JSON.stringify(usage).includes("hero"), "no request or generated text in usage records");

  // Nothing changed yet.
  assert.deepEqual((await getStorefrontSettings(id)).draft, before.draft);
  assert.equal(((await Business.findById(id).lean())!.themeSettings as unknown as Record<string, unknown>).primaryColor, "#4f46e5");

  assert.equal((await review(id, proposal.id, owner, "approve")).status, 200);
  const applied = await apply(id, proposal.id, owner);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const after = await getStorefrontSettings(id);
  assert.equal(after.draft.hero.headline, "Everyday clothing, relaxed");
  assert.equal(after.draft.sections[0].id, "new-arrivals");
  assert.deepEqual(after.published, before.published, "the published homepage is untouched");
  assert.equal(after.hasUnpublishedChanges, true);
  const business = await Business.findById(id).lean();
  // Colours wait in the design draft: the proposal changed nothing visitors see.
  const appliedSettings = business!.themeSettings as unknown as Record<string, unknown>;
  assert.equal(appliedSettings.primaryColor, "#4f46e5");
  assert.equal((appliedSettings.designDraft as { primaryColor: string; useThemeColors: boolean }).primaryColor, "#111827");
  assert.equal((appliedSettings.designDraft as { primaryColor: string; useThemeColors: boolean }).useThemeColors, false);
  assert.equal(business!.status, "published");
  const stored = await WebsiteProposal.findById(proposal.id).lean();
  assert.equal(stored?.status, "applied");
  assert.deepEqual(stored?.history.map((h) => h.action), ["created", "approved", "applied"]);
});

test("stale suggestions are refused at approval and at apply; concurrent applies succeed exactly once", async () => {
  const { owner, id } = await store();
  const edit = async (headline: string) => {
    const { draft } = await getStorefrontSettings(id);
    await saveStorefrontDraft(id, { ...draft, hero: { ...draft.hero, headline } });
  };
  replies.push(gemini(GOOD_CHANGES), gemini(GOOD_CHANGES), gemini(GOOD_CHANGES));

  const a = (await suggest(id, owner)).body.proposal;
  await edit("Owner edit 1");
  const approveStale = await review(id, a.id, owner, "approve");
  assert.equal(approveStale.status, 409);
  assert.equal(approveStale.body.code, "version_conflict");
  assert.equal((await WebsiteProposal.findById(a.id).lean())?.status, "failed");

  const b = (await suggest(id, owner)).body.proposal;
  assert.equal((await review(id, b.id, owner, "approve")).status, 200);
  await edit("Owner edit 2");
  const applyStale = await apply(id, b.id, owner);
  assert.equal(applyStale.body.code, "version_conflict");
  assert.equal((await getStorefrontSettings(id)).draft.hero.headline, "Owner edit 2", "the owner's edit is kept");

  const c = (await suggest(id, owner)).body.proposal;
  assert.equal((await review(id, c.id, owner, "approve")).status, 200);
  const results = await Promise.all([apply(id, c.id, owner), apply(id, c.id, owner)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
});

test("rejected suggestions are never applied; other businesses and staff cannot see or act on them", async () => {
  const { owner, business, id } = await store();
  const other = await store();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  replies.push(gemini(GOOD_CHANGES));
  const p = (await suggest(id, owner)).body.proposal;
  assert.equal((await review(id, p.id, owner, "reject")).status, 200);
  assert.equal((await apply(id, p.id, owner)).body.code, "proposal_not_approved");
  assert.equal((await call(proposalGET, "GET", `/api/businesses/${other.id}/proposals/${p.id}`, { id: other.id, proposalId: p.id }, other.owner)).status, 404, "another tenant's id is not found");
  assert.equal((await review(other.id, p.id, other.owner, "approve")).status, 404);
  assert.equal((await call(proposalsGET, "GET", `/api/businesses/${id}/proposals?target=storefront`, { id }, staff)).status, 403);
  const listed = await call(proposalsGET, "GET", `/api/businesses/${id}/proposals?target=storefront`, { id }, owner);
  assert.equal(listed.body.proposals.length, 1);
  assert.equal(listed.body.proposals[0].target, "storefront");
  assert.equal((await call(proposalsGET, "GET", `/api/businesses/${id}/proposals?target=pages`, { id }, owner)).body.proposals.length, 0);
});

test("invalid output is never saved: unreadable, unsupported, unknown sections or invented facts", async () => {
  const { owner, id } = await store();
  replies.push(
    gemini("this is not json"),
    gemini({ summary: "x", changes: [{ op: "script", code: "alert(1)" }] }),
    gemini({ summary: "x", changes: [{ op: "section", sectionId: "ghost", set: { title: "Hi" } }] }),
    gemini({ summary: "x", changes: [{ op: "hero", set: { headline: "Rated 5 stars by 10,000 happy customers" } }] }),
    gemini({ summary: "Your homepage already does this.", changes: [], notes: [] }),
  );
  assert.equal((await suggest(id, owner)).body.code, "invalid_response");
  assert.equal((await suggest(id, owner)).body.code, "invalid_suggestion");
  assert.equal((await suggest(id, owner)).body.code, "unknown_section");
  const invented = await suggest(id, owner);
  assert.equal(invented.body.code, "unsupported_claims");
  assert.match(invented.body.error, /Rated/);
  const nothing = await suggest(id, owner);
  assert.equal(nothing.status, 200);
  assert.equal(nothing.body.proposal, null);
  assert.equal(nothing.body.message, "Your homepage already does this.");
  assert.equal(await WebsiteProposal.countDocuments(), 0);
  const usage = await AiUsage.findOne({ business: id }).lean();
  // Refused output was sent and answered, so it counts as a request, recorded as rejected (not failed).
  assert.deepEqual([usage?.requests, usage?.successes, usage?.rejected, usage?.failures], [5, 1, 4, 0]);
});

test("monthly allowance: enforced atomically before the provider is called; no plan, no AI", async () => {
  const { owner, business, id } = await store();
  const plan = await createPlan({ price: 0 });
  await Plan.updateOne({ _id: plan._id }, { $set: { "features.aiRequestsPerMonth": 1 } });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  replies.push(gemini(GOOD_CHANGES), gemini(GOOD_CHANGES));
  assert.equal((await suggest(id, owner)).status, 201);
  const over = await suggest(id, owner);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "ai_quota_exceeded");
  assert.equal(calls.length, 1, "the provider is not called over the allowance");

  const noPlan = await createBusinessWithOwner();
  await grantAiConsent({ businessId: String(noPlan.business._id), actorId: String(noPlan.owner._id), version: AI_CONSENT_VERSION });
  const res = await suggest(String(noPlan.business._id), noPlan.owner);
  assert.equal(res.status, 402);
  assert.equal(res.body.code, "ai_not_in_plan");
  assert.equal(calls.length, 1);
});

test("product copy: suggested from the product's own details, never saved; invented specifications are refused", async () => {
  const { owner, id } = await store();
  const other = await store();
  const shirt = await Product.findOne({ business: id, slug: "linen-shirt" }).lean();
  const foreign = await Product.findOne({ business: other.id }).lean();
  const copy = (productId: string) => call(productCopyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId });
  replies.push(
    gemini({ summary: "Clearer description", description: "A relaxed-fit linen shirt for warm days.", missing: ["Which colours is it available in?"] }),
    gemini({ summary: "x", description: "Made from 100% organic cotton and certified by experts." }),
  );
  const ok = await copy(String(shirt!._id));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.applied, false);
  assert.equal(ok.body.suggestion.description, "A relaxed-fit linen shirt for warm days.");
  assert.deepEqual(ok.body.missing, ["Which colours is it available in?"]);
  assert.equal((await Product.findById(shirt!._id).lean())?.description, "Relaxed fit linen shirt.", "nothing is saved");
  assert.ok(JSON.parse(calls[0].body).contents[0].parts[0].text.includes("Relaxed fit linen shirt."), "the product's own details are the source");
  const invented = await copy(String(shirt!._id));
  assert.equal(invented.body.code, "unsupported_claims");
  assert.equal((await copy(String(foreign!._id))).status, 404, "another store's product");
  assert.equal(calls.length, 2);
});

test("store setup progress: owners and managers only, validated, same-origin; never changes store data", async () => {
  const { owner, business, id } = await store();
  const other = await store();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const put = (actor: Actor, body: unknown, options: { origin?: string } = {}) => call(setupPUT, "PUT", `/api/businesses/${id}/setup`, { id }, actor, body, options);

  const first = await put(owner, { step: "brand", done: "business" });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.setup.step, first.body.setup.done], ["brand", ["business"]]);
  assert.deepEqual((await put(manager, { skipped: "products" })).body.setup.skipped, ["products"]);
  const done = await put(owner, { done: "products" });
  assert.deepEqual([done.body.setup.done, done.body.setup.skipped], [["business", "products"], []]);
  assert.ok((await put(owner, { finished: true })).body.setup.completedAt);

  assert.equal((await put(staff, { step: "brand" })).status, 403);
  assert.equal((await put(other.owner, { step: "brand" })).status, 403);
  assert.equal((await put(owner, { step: "hack" })).status, 422);
  assert.equal((await put(owner, { done: "brand", skipped: "products" })).status, 422);
  assert.equal((await put(owner, {})).status, 422);
  assert.equal((await put(owner, { step: "brand" }, { origin: "https://evil.example" })).status, 403);
  const after = await Business.findById(id).lean();
  assert.equal(after!.name, business.name, "store data unchanged");
});
