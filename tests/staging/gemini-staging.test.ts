import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "../integration/helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "../integration/helpers/db";
import { callHandler, createAuthHeadersForUser } from "../integration/helpers/auth";
import { createBusinessWithOwner, createPlan, createSubscription, grantActiveFreePlan } from "../integration/helpers/tenant";
import { clearRequestCookies } from "../integration/helpers/mock-next-headers-setup";
import { POST as suggestPOST } from "@/app/api/businesses/[id]/ai/storefront/route";
import { POST as copyPOST } from "@/app/api/businesses/[id]/ai/product-copy/route";
import { DELETE as consentDELETE } from "@/app/api/businesses/[id]/ai/consent/route";
import { POST as reviewPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/review/route";
import { POST as applyPOST } from "@/app/api/businesses/[id]/proposals/[proposalId]/apply/route";
import { HttpError } from "@/lib/api";
import { AI_CONSENT_VERSION, grantAiConsent } from "@/lib/ai-builder/consent";
import { runAiRequest } from "@/lib/ai-builder/request";
import { storefrontChangeSetSchema } from "@/lib/ai-builder/storefront-changes";
import { presetConfig } from "@/lib/storefront-config";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { AiUsage } from "@/models/AiUsage";
import { Business } from "@/models/Business";
import { Customer } from "@/models/Customer";
import { Order } from "@/models/Order";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { User } from "@/models/User";
import { WebsiteProposal } from "@/models/WebsiteProposal";

/**
 * STAGING-ONLY verification of the Google Gemini integration
 * (docs/ai-website-builder-plan.md, "Staging verification").
 *
 *   Real mode:  STAGING_GEMINI_API_KEY=<staging key> STAGING_AI_CONFIRM=isolated-staging npm run test:staging-ai
 *   Dry run:    STAGING_AI_DRY_RUN=1 npm run test:staging-ai   (fake Gemini; validates the suite itself)
 *
 * Isolation, enforced below:
 * - refuses to run with NODE_ENV=production;
 * - the database is ALWAYS a throwaway in-memory replica set (MONGODB_URI is
 *   replaced; `.env*` files are never loaded), seeded with synthetic data;
 * - the key comes only from this process's STAGING_GEMINI_API_KEY (never a
 *   file, never GEMINI_API_KEY) and is never printed;
 * - every outgoing request is recorded, and any host other than Gemini is
 *   blocked; online order payments stay off.
 *
 * Verifies: real generation, rejection of invalid structured output, timeout
 * handling, the monthly limit, consent revocation, that customer/order/
 * payment/account data never leaves the server, approval before any change,
 * and that publishing stays a separate action. Output is scalar-only (status
 * codes and counts), never prompts or generated text.
 */

if (process.env.NODE_ENV === "production") throw new Error("The staging AI suite never runs with NODE_ENV=production.");
const STAGING_KEY = process.env.STAGING_GEMINI_API_KEY ?? "";
const DRY_RUN = process.env.STAGING_AI_DRY_RUN === "1";
const REAL = !DRY_RUN && STAGING_KEY.length > 0 && process.env.STAGING_AI_CONFIRM === "isolated-staging";
const SKIP_REASON = REAL || DRY_RUN ? false : "set STAGING_GEMINI_API_KEY and STAGING_AI_CONFIRM=isolated-staging (staging only), or STAGING_AI_DRY_RUN=1";


const GEMINI_HOST = "https://generativelanguage.googleapis.com/";
const realFetch = globalThis.fetch;
const outgoing: Array<{ url: string; body: string; keyOnlyInHeader: boolean }> = [];
/** Dry run only: what the fake Gemini answers next (ignored in real mode). */
let fakeReplies: Array<(init?: RequestInit) => Response | Promise<Response>> = [];
/** Values that must never appear in an outgoing request (filled while seeding). */
const canaries = new Set<string>();
const outcomes: string[] = [];

const fakeGemini = (value: unknown, finishReason = "STOP") => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] }, finishReason }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    }),
    { status: 200 },
  );
const fakeHang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));

before(async () => {
  if (SKIP_REASON) return;
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error("not an isolated database");
  await connectTestDB();
  delete process.env.ORDER_ONLINE_PAYMENTS_ENABLED;
  delete process.env.ORDER_PAYMENTS_LIVE_ALLOWED;
  process.env.AI_PROVIDER_ENABLED = "true";
  process.env.GEMINI_API_KEY = REAL ? STAGING_KEY : "dry-run-not-a-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GEMINI_HOST)) throw new Error("Blocked: only the Gemini API may be called from this suite.");
    const key = process.env.GEMINI_API_KEY ?? "";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    outgoing.push({ url, body: String(init?.body ?? ""), keyOnlyInHeader: headers["x-goog-api-key"] === key && !url.includes(key) && !String(init?.body ?? "").includes(key) });
    if (REAL) return realFetch(input, init);
    const next = fakeReplies.shift();
    if (!next) throw new Error("dry run: no fake reply queued");
    return next(init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (SKIP_REASON) return;
  delete process.env.GEMINI_API_KEY;
  delete process.env.AI_PROVIDER_ENABLED;
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  clearRequestCookies();
  // Scalars only: never prompts, generated text or the key.
  console.log(`[staging-ai] mode=${REAL ? "real" : "dry-run"} provider_requests=${outgoing.length} outcomes=${outcomes.join(",")}`);
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  if (SKIP_REASON) return;
  fakeReplies = [];
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };
let ipCounter = 0;

async function call(handler: unknown, method: string, path: string, params: Record<string, string>, actor: Actor, body?: unknown) {
  const auth = await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion);
  ipCounter += 1;
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${path}`, {
      method,
      headers: { host: "localhost", "content-type": "application/json", "x-forwarded-for": `198.21.0.${ipCounter % 250}`, ...auth },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** A synthetic store, its consent, and canary data that must never leave the server. */
async function syntheticStore() {

  const { owner, business } = await createBusinessWithOwner({ status: "published", name: "Staging Linen Co" });
  await grantActiveFreePlan(business._id);
  await Business.updateOne(
    { _id: business._id },
    {
      $set: {
        category: "clothing",
        description: "Breathable linen and cotton clothing for warm days. Questions: owner-canary@staging.example or +91 98765 43210.",
        contactEmail: "contact-canary@staging.example",
        phone: "+1 555 0100 2468",
        address: "42 Canary Lane, Springfield",
        "themeSettings.storefront": presetConfig("clothing"),
        "themeSettings.publishedStorefront": presetConfig("clothing"),
      },
    },
  );
  const shirt = await Product.create({
    business: business._id, name: "Linen Shirt", slug: "linen-shirt", price: 9137, stock: 8642, sku: "SKU-CANARY-77", status: "active", category: "Shirts",
    description: "A relaxed linen shirt with a button front. Wholesale: wholesale-canary@staging.example.",
    options: [{ name: "Size", values: ["Small", "Medium", "Large"] }],
  });
  await Product.create({ business: business._id, name: "Cotton Tee", slug: "cotton-tee", price: 20, stock: 10, status: "active", category: "Tops", description: "A soft cotton t-shirt." });
  await Customer.create({ business: business._id, name: "Canary Customer Zed", email: "customer-canary@staging.example" });
  const order = await Order.create({
    business: business._id, ownerToken: "ownertoken-canary-0001", customerName: "Canary Shopper Quinn", customerEmail: "shopper-canary@staging.example",
    items: [{ product: String(shirt._id), productName: "Linen Shirt", quantity: 1, unitPrice: 9137, currency: "INR" }],
    subtotal: 9137, total: 9137, currency: "INR", status: "paid", paymentMethod: "online", paidAt: new Date(),
  });
  const record = await User.findById(owner._id).select("+passwordHash").lean<{ email: string; passwordHash: string }>();
  const cookie = (await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion)).cookie;
  for (const value of [
    "owner-canary", "contact-canary", "wholesale-canary", "customer-canary", "shopper-canary", "Canary Customer Zed", "Canary Shopper Quinn",
    "ownertoken-canary", order.orderNumber, "98765", "555 0100", "42 Canary Lane", "SKU-CANARY", "9137", "8642",
    record!.email, record!.passwordHash, cookie.slice(cookie.indexOf("=") + 1),
  ]) canaries.add(value);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  return { owner, business, id: String(business._id), productId: String(shirt._id) };
}

const DRY_CHANGES = {
  summary: "A linen-focused hero and new arrivals first.",
  changes: [
    { op: "hero", set: { headline: "Linen for warm days" } },
    { op: "move", sectionId: "new-arrivals", toIndex: 0 },
  ],
  notes: [],
};
const DRY_COPY = { summary: "Clearer", description: "A relaxed linen shirt with a button front, in Small, Medium and Large.", missing: [] };

/** Real output can vary: one retry when the answer is refused, then report the code. */
async function attempt(run: () => Promise<{ status: number; body: Record<string, any> }>, ok: number[]) {
  let res = await run();
  outcomes.push(String(res.status));
  if (REAL && !ok.includes(res.status) && res.status === 422) {
    res = await run();
    outcomes.push(String(res.status));
  }
  return res;
}

test("1+7+8. real generation: a homepage suggestion becomes a PENDING proposal; approval and apply change only the draft; publishing stays separate", { skip: SKIP_REASON }, async () => {
  const { owner, id } = await syntheticStore();
  const before = await getStorefrontSettings(id);
  fakeReplies.push(fakeGemini(DRY_CHANGES), fakeGemini(DRY_CHANGES));

  const res = await attempt(
    () => call(suggestPOST, "POST", `/api/businesses/${id}/ai/storefront`, { id }, owner, { instruction: "Change the hero headline to mention our linen clothing and show new arrivals first." }),
    [201],
  );
  assert.equal(res.status, 201, `code=${res.body.code ?? "none"}`);
  const proposalId = String(res.body.proposal.id);
  assert.equal(res.body.proposal.status, "pending");
  assert.deepEqual(await getStorefrontSettings(id), before, "nothing changes before approval");

  const early = await call(applyPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/apply`, { id, proposalId }, owner, {});
  assert.equal(early.body.code, "proposal_not_approved", "apply requires an approval first");
  assert.equal((await call(reviewPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/review`, { id, proposalId }, owner, { decision: "approve" })).status, 200);
  const applied = await call(applyPOST, "POST", `/api/businesses/${id}/proposals/${proposalId}/apply`, { id, proposalId }, owner, {});
  assert.equal(applied.status, 200, `code=${applied.body.code ?? "none"}`);

  const afterApply = await getStorefrontSettings(id);
  assert.notDeepEqual(afterApply.draft, before.draft, "the approved change reached the draft");
  assert.deepEqual(afterApply.published, before.published, "the live storefront is unchanged until the owner publishes");
  assert.equal(afterApply.hasUnpublishedChanges, true);
});

test("1. real generation: a product description is suggested for review and never saved", { skip: SKIP_REASON }, async () => {
  const { owner, id, productId } = await syntheticStore();
  fakeReplies.push(fakeGemini(DRY_COPY), fakeGemini(DRY_COPY));
  const res = await attempt(() => call(copyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId }), [200]);
  assert.equal(res.status, 200, `code=${res.body.code ?? "none"}`);
  assert.equal(res.body.applied, false);
  assert.ok(typeof res.body.suggestion.description === "string" && res.body.suggestion.description.length > 0);
  assert.match((await Product.findById(productId).lean())?.description ?? "", /^A relaxed linen shirt with a button front\./, "nothing is saved");
});

test("2. invalid structured output from the provider is rejected, recorded as rejected, and never saved", { skip: SKIP_REASON }, async () => {
  const { id } = await syntheticStore();
  fakeReplies.push(fakeGemini({ greeting: "hello" }), fakeGemini('{"summary": "cut', "MAX_TOKENS"));

  // A well-formed JSON answer that is not a supported change set.
  await assert.rejects(
    runAiRequest({
      businessId: id, task: "storefront", limit: 30, maxOutputTokens: 256,
      system: "Return only JSON.", prompt: 'Return exactly this JSON object and nothing else: {"greeting": "hello"}',
      accept: (value) => {
        if (!storefrontChangeSetSchema.safeParse(value).success) throw new HttpError(422, "Unsupported suggestion.", "invalid_suggestion");
        return value;
      },
    }),
    (error: { code?: string }) => error.code === "invalid_suggestion",
  );
  // An answer cut off by the output limit.
  await assert.rejects(
    runAiRequest({ businessId: id, task: "storefront", limit: 30, maxOutputTokens: 8, system: "Return only JSON.", prompt: "Describe a linen shirt in a JSON object with ten fields.", accept: (v) => v }),
    (error: { code?: string }) => ["output_truncated", "invalid_response"].includes(error.code ?? ""),
  );
  const usage = await AiUsage.findOne({ business: id }).lean();
  assert.deepEqual([usage?.requests, usage?.rejected, usage?.successes], [2, 2, 0]);
  assert.equal(await WebsiteProposal.countDocuments(), 0);
  outcomes.push("rejected", "rejected");
});

test("3. timeouts are handled: a fixed message, counted as failed, nothing saved", { skip: SKIP_REASON }, async () => {
  const { owner, id } = await syntheticStore();
  process.env.AI_PROVIDER_TIMEOUT_MS = "1";
  fakeReplies.push(fakeHang);
  const res = await call(suggestPOST, "POST", `/api/businesses/${id}/ai/storefront`, { id }, owner, { instruction: "Make the hero shorter." });
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  outcomes.push(String(res.status));
  assert.deepEqual([res.status, res.body.code], [504, "timeout"]);
  const usage = await AiUsage.findOne({ business: id }).lean();
  assert.deepEqual([usage?.requests, usage?.failures], [1, 1]);
  assert.equal(await WebsiteProposal.countDocuments(), 0);
});

test("4. the monthly limit is enforced before the provider is called", { skip: SKIP_REASON }, async () => {
  const { owner, business, id, productId } = await syntheticStore();
  const plan = await createPlan({ price: 0 });
  await Plan.updateOne({ _id: plan._id }, { $set: { "features.aiRequestsPerMonth": 1 } });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  fakeReplies.push(fakeGemini(DRY_COPY));
  const first = await call(copyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId });
  outcomes.push(String(first.status));
  assert.notEqual(first.status, 429);
  const sentBefore = outgoing.length;
  const second = await call(copyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, owner, { productId });
  outcomes.push(String(second.status));
  assert.deepEqual([second.status, second.body.code], [429, "ai_quota_exceeded"]);
  assert.equal(outgoing.length, sentBefore, "no provider request over the limit");
});

test("5. consent revocation blocks the next request before anything is sent", { skip: SKIP_REASON }, async () => {
  const { owner, id } = await syntheticStore();
  assert.equal((await call(consentDELETE, "DELETE", `/api/businesses/${id}/ai/consent`, { id }, owner, {})).status, 200);
  const sentBefore = outgoing.length;
  const res = await call(suggestPOST, "POST", `/api/businesses/${id}/ai/storefront`, { id }, owner, { instruction: "Make the hero shorter." });
  outcomes.push(String(res.status));
  assert.deepEqual([res.status, res.body.code], [403, "ai_consent_required"]);
  assert.equal(outgoing.length, sentBefore);
});

test("6. customer, order, payment and account data never left the server; the key travelled only in its header", { skip: SKIP_REASON }, () => {
  assert.ok(outgoing.length >= 5, "the provider was called by the tests above");
  for (const request of outgoing) {
    assert.ok(request.url.startsWith(GEMINI_HOST));
    assert.ok(request.keyOnlyInHeader, "the key is only in the x-goog-api-key header");
    for (const value of canaries) assert.ok(!request.body.includes(value), "a canary value was found in an outgoing request");
    assert.ok(!request.body.includes("@staging.example"), "no email address left the server");
  }
});
