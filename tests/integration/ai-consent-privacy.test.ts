import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as aiStorefrontPOST } from "@/app/api/businesses/[id]/ai/storefront/route";
import { POST as productCopyPOST } from "@/app/api/businesses/[id]/ai/product-copy/route";
import { POST as generatePOST } from "@/app/api/businesses/[id]/planning/generate/route";
import { DELETE as consentDELETE, GET as consentGET, POST as consentPOST } from "@/app/api/businesses/[id]/ai/consent/route";
import { AI_CONSENT_VERSION, grantAiConsent } from "@/lib/ai-builder/consent";
import { runAiRequest } from "@/lib/ai-builder/request";
import { geminiGenerateJson } from "@/lib/ai-planning/gemini-http";
import { DEFAULT_GEMINI_MODEL } from "@/lib/env";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { presetConfig } from "@/lib/storefront-config";
import { AiConsentEvent } from "@/models/AiConsentEvent";
import { AiUsage } from "@/models/AiUsage";
import { Business } from "@/models/Business";
import { Customer } from "@/models/Customer";
import { Order } from "@/models/Order";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { RateLimit } from "@/models/RateLimit";
import { User } from "@/models/User";
import { WebsiteProposal } from "@/models/WebsiteProposal";

/**
 * Google Gemini integration: owner consent, data sanitization, usage
 * accounting, model/timeout configuration and provider errors, against a
 * FAKE provider (global fetch replaced; any request that is not to the Gemini
 * host fails the test, so nothing leaves the process).
 */

const KEY = "test-gemini-key-SECRET123";
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let replies: Array<(init?: RequestInit) => Response | Promise<Response>> = [];
const gemini = (value: unknown, usage: Record<string, number> | null = { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 }) => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: typeof value === "string" ? value : JSON.stringify(value) }] }, finishReason: "STOP" }],
      ...(usage ? { usageMetadata: usage } : {}),
    }),
    { status: 200 },
  );
/** Never answers; resolves only when the request is aborted (timeout). */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const name of ["AI_PROVIDER_ENABLED", "GEMINI_API_KEY", "GEMINI_MODEL", "AI_PROVIDER_TIMEOUT_MS"]) delete process.env[name];
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  process.env.GEMINI_API_KEY = KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.AI_PROVIDER_TIMEOUT_MS;
  calls.length = 0;
  replies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected network request: ${url}`);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    const next = replies.shift();
    if (!next) throw new Error("no fake provider reply queued");
    return next(init);
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
  options: { origin?: string } = {},
) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  ipCounter += 1;
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": `198.20.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...auth,
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function store(options: { consent?: boolean } = {}) {
  const { owner, business } = await createBusinessWithOwner({ status: "published", name: "Canary Tea House" });
  await grantActiveFreePlan(business._id);
  await Business.updateOne(
    { _id: business._id },
    { $set: { category: "clothing", description: "Relaxed everyday clothing.", "themeSettings.storefront": presetConfig("clothing"), "themeSettings.publishedStorefront": presetConfig("clothing") } },
  );
  const product = await Product.create({ business: business._id, name: "Linen Shirt", slug: "linen-shirt", price: 40, stock: 5, status: "active", category: "Shirts", description: "Relaxed fit linen shirt." });
  if (options.consent !== false) {
    await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  }
  return { owner, business, id: String(business._id), productId: String(product._id) };
}

const suggest = (id: string, actor: Actor | null, instruction = "Make the hero shorter and show new arrivals first") =>
  call(aiStorefrontPOST, "POST", `/api/businesses/${id}/ai/storefront`, { id }, actor, { instruction });
const copy = (id: string, actor: Actor, productId: string) => call(productCopyPOST, "POST", `/api/businesses/${id}/ai/product-copy`, { id }, actor, { productId });
const plan = (id: string, actor: Actor, overrides: Record<string, unknown> = {}) =>
  call(generatePOST, "POST", `/api/businesses/${id}/planning/generate`, { id }, actor, {
    businessSummary: "We sell linen clothing.",
    targetAudience: "People who like natural fabrics.",
    requestedPageCount: 1,
    pages: [{ title: "Home", purpose: "Welcome visitors", requiredContent: "" }],
    preferredTheme: "studio",
    designPreferences: { notes: "" },
    ...overrides,
  });
const consentPath = (id: string) => `/api/businesses/${id}/ai/consent`;

const GOOD_CHANGES = {
  summary: "A shorter hero and new arrivals first.",
  changes: [
    { op: "hero", set: { headline: "Everyday clothing, relaxed", description: "" } },
    { op: "move", sectionId: "new-arrivals", toIndex: 0 },
  ],
  notes: [],
};
const GOOD_COPY = { summary: "Clearer description", description: "A relaxed-fit linen shirt.", missing: [] };
const VALID_PLAN = {
  businessSummary: "A linen clothing store.",
  targetAudience: "Natural fabric lovers.",
  recommendedTheme: "studio",
  requestedPageCount: 1,
  designPreferences: { notes: "Calm." },
  specialRequirements: "",
  productIds: [],
  pages: [{ title: "Home", slug: "home", purpose: "Home page.", proposedContent: "Welcome.", isHome: true, sections: [] }],
  navigation: [{ pageSlug: "home", label: "Home" }],
  assumptions: [],
  unansweredQuestions: [],
  summary: "A plan.",
};

test("consent: without the owner's consent for THIS business nothing is sent, and no rate-limit or usage budget is spent", async () => {
  const { owner, id, productId } = await store({ consent: false });
  // The same person owns a second store and consented there: consent is per business.
  const second = await store();
  await createMembership(second.business._id, owner._id, "owner");
  await grantAiConsent({ businessId: second.id, actorId: String(owner._id), version: AI_CONSENT_VERSION });

  for (const res of [await suggest(id, owner), await copy(id, owner, productId), await plan(id, owner)]) {
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, "ai_consent_required");
  }
  assert.equal(calls.length, 0);
  assert.equal(await AiUsage.countDocuments(), 0);
  assert.equal(await RateLimit.countDocuments(), 0, "consent is checked before any rate limit");
});

test("consent is managed by the owner only: same-origin, verified email, the current disclosure; every change is recorded", async () => {
  const { owner, business, id } = await store({ consent: false });
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const other = await createBusinessWithOwner();
  const grant = (actor: Actor | null, version = AI_CONSENT_VERSION, options: { origin?: string } = {}) =>
    call(consentPOST, "POST", consentPath(id), { id }, actor, { version }, options);
  const revoke = (actor: Actor) => call(consentDELETE, "DELETE", consentPath(id), { id }, actor, {});
  const view = (actor: Actor) => call(consentGET, "GET", consentPath(id), { id }, actor);

  assert.equal((await grant(null)).status, 401);
  assert.equal((await grant(manager)).status, 403, "manager");
  assert.equal((await grant(staff)).status, 403, "staff");
  assert.equal((await grant(other.owner)).status, 403, "another business's owner");
  assert.equal((await grant(owner, AI_CONSENT_VERSION, { origin: "https://evil.example" })).body.code, "csrf_failed");
  const stale = await grant(owner, "2020-01-01");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "consent_version_mismatch", "consent is to the disclosure the owner was shown");
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await grant(owner)).body.code, "email_unverified");
  await User.updateOne({ _id: owner._id }, { $unset: { emailVerifiedAt: 1 } });
  assert.equal(await AiConsentEvent.countDocuments(), 0, "refused attempts record nothing");

  const granted = await grant(owner);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.consent.granted, true);

  assert.equal((await view(staff)).status, 403);
  const managerView = await view(manager);
  assert.equal(managerView.status, 200);
  assert.equal(managerView.body.provider.name, "Google Gemini");
  assert.equal(managerView.body.consent.granted, true);
  assert.equal(managerView.body.canManage, false);
  assert.deepEqual(managerView.body.history, []);
  assert.ok(!JSON.stringify(managerView.body).includes("SECRET123"), "the key is never returned");

  assert.equal((await revoke(manager)).status, 403);
  const revoked = await revoke(owner);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.consent.granted, false);

  const events = await AiConsentEvent.find({ business: business._id }).sort({ _id: 1 }).lean();
  assert.deepEqual(
    events.map((e) => [e.action, e.version, String(e.actor), String(e.business)]),
    [
      ["granted", AI_CONSENT_VERSION, String(owner._id), id],
      ["revoked", AI_CONSENT_VERSION, String(owner._id), id],
    ],
  );
  assert.ok(events.every((e) => e.createdAt instanceof Date), "each change is timestamped");
  assert.equal((await view(owner)).body.history.length, 2, "the owner sees the history");
  const stored = await Business.findById(id).select("aiConsent").lean<{ aiConsent: { grantedBy: unknown; revokedBy: unknown; revokedAt: unknown } }>();
  assert.equal(String(stored?.aiConsent.grantedBy), String(owner._id));
  assert.equal(String(stored?.aiConsent.revokedBy), String(owner._id));
  assert.ok(stored?.aiConsent.revokedAt instanceof Date);
});

test("revocation blocks the very next request, even one already past the route guard; a new disclosure needs consent again", async () => {
  const { owner, id } = await store();
  replies.push(gemini(GOOD_CHANGES));
  assert.equal((await suggest(id, owner)).status, 201);
  assert.equal((await call(consentDELETE, "DELETE", consentPath(id), { id }, owner, {})).status, 200);

  const blocked = await suggest(id, owner);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "ai_consent_required");
  // A request that passed the guard before the revocation is refused right before the provider call.
  await assert.rejects(
    runAiRequest({ businessId: id, task: "storefront", limit: 30, system: "Rules.", prompt: "Store data.", maxOutputTokens: 100, accept: (v) => v }),
    (error: { code?: string }) => error.code === "ai_consent_required",
  );
  assert.equal(calls.length, 1);
  assert.equal((await AiUsage.findOne({ business: id }).lean())?.requests, 1, "refused requests are not charged");

  await grantAiConsent({ businessId: id, actorId: String(owner._id), version: AI_CONSENT_VERSION });
  await Business.updateOne({ _id: id }, { $set: { "aiConsent.version": "2026-01-01" } });
  const outdated = await suggest(id, owner);
  assert.equal(outdated.body.code, "ai_consent_required");
  assert.match(outdated.body.error, /disclosure has changed/);
  const view = await call(consentGET, "GET", consentPath(id), { id }, owner);
  assert.deepEqual([view.body.consent.granted, view.body.consent.outdated], [false, true]);
  assert.equal(calls.length, 1);
});

test("privacy: customer, order, payment, account and secret data never reach Gemini; only approved store content does", async () => {
  const { owner, business, id, productId } = await store();
  await Business.updateOne(
    { _id: id },
    {
      $set: {
        description: "Relaxed everyday clothing. Questions: owner-canary@shop.example or +91 98765 43210. Key rzp_live_CANARYKEY123.",
        contactEmail: "contact-canary@example.com",
        phone: "+1 555 0100 2468",
        address: "42 Canary Lane, Springfield",
        "themeSettings.storefront.announcement.text": "Write to promo-canary@example.com",
      },
    },
  );
  await Product.updateOne(
    { _id: productId },
    {
      $set: {
        description: "Relaxed fit linen shirt. Wholesale: wholesale-canary@example.com, card 4111 1111 1111 1111.",
        price: 9137,
        stock: 8642,
        sku: "SKU-CANARY-77",
        options: [{ name: "Size", values: ["Small", "Medium"] }],
      },
    },
  );
  await Customer.create({ business: business._id, name: "Canary Customer Zed", email: "customer-canary@example.com" });
  const order = await Order.create({
    business: business._id,
    ownerToken: "ownertoken-canary-0001",
    customerName: "Canary Shopper Quinn",
    customerEmail: "shopper-canary@example.com",
    items: [{ product: productId, productName: "Linen Shirt", quantity: 1, unitPrice: 9137, currency: "INR" }],
    subtotal: 9137,
    total: 9137,
    currency: "INR",
    status: "paid",
    paymentMethod: "online",
    paidAt: new Date(),
  });
  const ownerRecord = await User.findById(owner._id).select("+passwordHash").lean<{ email: string; passwordHash: string }>();
  const sessionCookie = (await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion)).cookie;
  const sessionToken = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
  assert.ok(ownerRecord?.passwordHash && sessionToken.length > 20);

  replies.push(gemini(GOOD_CHANGES), gemini(GOOD_COPY), gemini(VALID_PLAN));
  const suggested = await suggest(id, owner, "Make the hero about linen. Email instr-canary@example.com when done");
  assert.equal(suggested.status, 201, JSON.stringify(suggested.body));
  assert.equal((await copy(id, owner, productId)).status, 200);
  assert.equal((await plan(id, owner, { businessSummary: "We sell linen. Reach brief-canary@example.com or 9876543210." })).status, 200);
  assert.equal(calls.length, 3);

  const forbidden = [
    "owner-canary", "contact-canary", "promo-canary", "wholesale-canary", "customer-canary", "shopper-canary", "instr-canary", "brief-canary",
    "Canary Customer Zed", "Canary Shopper Quinn", "ownertoken-canary", order.orderNumber,
    "rzp_live_CANARYKEY123", "4111 1111", "98765", "9876543210", "555 0100", "42 Canary Lane", "SKU-CANARY", "9137", "8642",
    ownerRecord!.email, ownerRecord!.passwordHash, sessionToken, KEY, "SECRET123",
  ];
  for (const c of calls) {
    const sent = `${c.url}\n${c.body}`;
    for (const value of forbidden) assert.ok(!sent.includes(value), `must never be sent: ${value}`);
    assert.equal(c.headers["x-goog-api-key"], KEY, "the key travels only in its header");
  }
  // The approved content is what the suggestions are built from.
  const [storefront, product, planning] = calls.map((c) => c.body);
  for (const expected of ["Canary Tea House", "Relaxed everyday clothing.", "Linen Shirt", "[email removed]", "[number removed]", "hero about linen"]) {
    assert.ok(storefront.includes(expected), `storefront prompt includes ${expected}`);
  }
  for (const expected of ["Relaxed fit linen shirt.", "Size", "Small", "Medium", "[email removed]"]) assert.ok(product.includes(expected), `product prompt includes ${expected}`);
  assert.ok(planning.includes("We sell linen.") && planning.includes("[email removed]"));

  // The suggestion is only a pending proposal: neither the draft nor the live store changed.
  const proposal = await WebsiteProposal.findById(suggested.body.proposal.id).lean();
  assert.equal(proposal?.status, "pending");
  const settings = await getStorefrontSettings(id);
  assert.notEqual(settings.draft.hero.headline, "Everyday clothing, relaxed");
  assert.notEqual(settings.published?.hero.headline, "Everyday clothing, relaxed");
});

test("the final data check refuses anything personal or secret that slipped through: nothing sent, nothing charged", async () => {
  const { id } = await store();
  for (const prompt of [
    "Contact jane@example.com",
    "Card 4111 1111 1111 1111",
    "Key sk_live_abcdefgh12345678",
    "Session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
  ]) {
    await assert.rejects(
      runAiRequest({ businessId: id, task: "storefront", limit: 30, system: "Rules.", prompt, maxOutputTokens: 100, accept: (v) => v }),
      (error: { code?: string; status?: number }) => error.code === "unsafe_content" && error.status === 422,
    );
  }
  // The transport itself checks every request (planning included).
  await assert.rejects(
    geminiGenerateJson({ apiKey: KEY, prompt: "Call +44 20 7946 0958", maxOutputTokens: 10, logTag: "test", subject: "Test", advice: "" }),
    (error: { code?: string }) => error.code === "unsafe_content",
  );
  assert.equal(calls.length, 0);
  assert.equal(await AiUsage.countDocuments(), 0);
});

test("usage: only requests that reach Gemini are charged; outcomes and token counts are recorded as reported", async () => {
  const { owner, business, id, productId } = await store();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");

  assert.equal((await suggest(id, owner, "x")).status, 422, "invalid request");
  assert.equal((await copy(id, owner, new mongoose.Types.ObjectId().toString())).status, 404, "unknown product");
  assert.equal((await copy(id, staff, productId)).status, 403, "not allowed");
  process.env.GEMINI_MODEL = "not a model";
  const misconfigured = await suggest(id, owner);
  assert.deepEqual([misconfigured.status, misconfigured.body.code], [503, "provider_not_configured"]);
  delete process.env.GEMINI_MODEL;
  // The kill switch turned off after the allowance was reserved: refunded.
  process.env.AI_PROVIDER_ENABLED = "false";
  await assert.rejects(
    runAiRequest({ businessId: id, task: "product", limit: 30, system: "Rules.", prompt: "Store data.", maxOutputTokens: 100, accept: (v) => v }),
    (error: { code?: string }) => error.code === "provider_not_configured",
  );
  process.env.AI_PROVIDER_ENABLED = "true";
  assert.equal(calls.length, 0);
  assert.equal((await AiUsage.findOne({ business: id }).lean())?.requests ?? 0, 0, "nothing charged");

  replies.push(gemini(GOOD_CHANGES), gemini(GOOD_COPY, null), gemini("not json"));
  assert.equal((await suggest(id, owner)).status, 201);
  assert.equal((await copy(id, owner, productId)).status, 200);
  assert.equal((await copy(id, owner, productId)).body.code, "invalid_response");
  // No HTTP response at all (connection failure): Gemini never received it, so it is refunded.
  replies.push(() => {
    throw new TypeError("fetch failed");
  });
  const unreachable = await copy(id, owner, productId);
  assert.deepEqual([unreachable.status, unreachable.body.code], [502, "provider_unreachable"]);
  const view = await call(consentGET, "GET", consentPath(id), { id }, owner);
  assert.deepEqual([view.body.usage.used, view.body.usage.limit], [3, 30], "the panel's count comes from the server");
  const usage = await AiUsage.findOne({ business: id }).lean();
  assert.deepEqual(
    [usage?.requests, usage?.successes, usage?.rejected, usage?.failures, usage?.tasks?.storefront, usage?.tasks?.product],
    [3, 2, 1, 0, 1, 2],
  );
  // Token counts only as Gemini reported them (the second reply reported none).
  assert.deepEqual([usage?.tokenReports, usage?.promptTokens, usage?.outputTokens, usage?.totalTokens], [2, 240, 80, 320]);
  assert.equal(usage?.model, DEFAULT_GEMINI_MODEL);
});

test("concurrent requests never exceed the monthly allowance", async () => {
  const { owner, business, id, productId } = await store();
  const limited = await createPlan({ price: 0 });
  await Plan.updateOne({ _id: limited._id }, { $set: { "features.aiRequestsPerMonth": 3 } });
  await createSubscription(business._id, limited._id, { status: "active", currentPeriodEnd: null });
  for (let i = 0; i < 8; i++) replies.push(gemini(GOOD_COPY));
  const results = await Promise.all(Array.from({ length: 8 }, () => copy(id, owner, productId)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429, 429, 429]);
  assert.ok(results.filter((r) => r.status === 429).every((r) => r.body.code === "ai_quota_exceeded"));
  assert.equal(calls.length, 3, "the provider is called exactly as often as the allowance permits");
  assert.equal((await AiUsage.findOne({ business: id }).lean())?.requests, 3);
});

test("the model is configurable; timeouts, provider rate limits and errors give fixed messages, count as failed and log no content", async () => {
  const { owner, id } = await store();
  process.env.GEMINI_MODEL = "gemini-2.5-pro";
  replies.push(gemini(GOOD_CHANGES));
  assert.equal((await suggest(id, owner)).status, 201);
  assert.ok(calls[0].url.endsWith("/models/gemini-2.5-pro:generateContent"), calls[0].url);
  delete process.env.GEMINI_MODEL;

  const logged: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    process.env.AI_PROVIDER_TIMEOUT_MS = "50";
    replies.push(hang);
    const timedOut = await suggest(id, owner, "Rewrite the hero UNIQUE-INSTRUCTION");
    assert.deepEqual([timedOut.status, timedOut.body.code], [504, "timeout"]);
    delete process.env.AI_PROVIDER_TIMEOUT_MS;

    replies.push(() => new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "UPSTREAM-DETAIL quota" } }), { status: 429 }));
    const busy = await suggest(id, owner, "Rewrite the hero UNIQUE-INSTRUCTION");
    assert.deepEqual([busy.status, busy.body.code], [429, "rate_limit_exceeded"]);

    replies.push(() => new Response(JSON.stringify({ error: { code: 500, status: "INTERNAL", message: "UPSTREAM-DETAIL" } }), { status: 500 }));
    const broken = await suggest(id, owner, "Rewrite the hero UNIQUE-INSTRUCTION");
    assert.deepEqual([broken.status, broken.body.code], [502, "provider_error"]);

    for (const res of [timedOut, busy, broken]) {
      assert.ok(!JSON.stringify(res.body).includes("UPSTREAM-DETAIL") && !JSON.stringify(res.body).includes("SECRET123"));
    }
  } finally {
    console.error = realError;
    delete process.env.AI_PROVIDER_TIMEOUT_MS;
  }
  const log = JSON.stringify(logged);
  for (const value of ["UPSTREAM-DETAIL", "SECRET123", "UNIQUE-INSTRUCTION", "Relaxed everyday clothing", "Linen Shirt"]) {
    assert.ok(!log.includes(value), `never logged: ${value}`);
  }
  assert.ok(calls.slice(1).every((c) => c.url.endsWith(`/models/${DEFAULT_GEMINI_MODEL}:generateContent`)));
  const usage = await AiUsage.findOne({ business: id }).lean();
  assert.deepEqual([usage?.requests, usage?.successes, usage?.failures, usage?.rejected], [4, 1, 3, 0], "requests that reached Gemini are counted");
  assert.equal(await WebsiteProposal.countDocuments(), 1);
});
