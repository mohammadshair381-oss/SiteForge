import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as generatePOST } from "@/app/api/businesses/[id]/planning/generate/route";
import { AI_CONSENT_VERSION, grantAiConsent } from "@/lib/ai-builder/consent";
import { Product } from "@/models/Product";
import { User } from "@/models/User";

/**
 * AI builder M0: the planning "generate" route against a FAKE provider (global
 * fetch replaced; nothing leaves the process). Covers the kill switch, origin,
 * roles, verified email, rate/usage limits, tenant isolation, key handling and
 * error hygiene.
 */

const realFetch = globalThis.fetch;
const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let upstream: () => Response;

const VALID_PLAN = {
  businessSummary: "A test business.",
  targetAudience: "Test audience.",
  recommendedTheme: "studio",
  requestedPageCount: 1,
  designPreferences: { notes: "Test notes." },
  specialRequirements: "",
  productIds: [],
  pages: [{ title: "Home", slug: "home", purpose: "Home page.", proposedContent: "Welcome.", isHome: true, sections: [] }],
  navigation: [{ pageSlug: "home", label: "Home" }],
  assumptions: [],
  unansweredQuestions: [],
  summary: "A test plan.",
};
const okResponse = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(VALID_PLAN) }] }, finishReason: "STOP" }] }), { status: 200 });

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
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
  delete process.env.AI_PROVIDER_ENABLED;
  process.env.GEMINI_API_KEY = "test-gemini-key-SECRET123";
  calls.length = 0;
  upstream = okResponse;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) throw new Error(`Unexpected network request: ${url}`);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? "") });
    return upstream();
  }) as typeof fetch;
  clearRequestCookies();
  await clearAllCollections();
});

let ipCounter = 0;
function body(overrides: Record<string, unknown> = {}) {
  return {
    businessSummary: "We sell handmade tea.",
    targetAudience: "Tea lovers.",
    requestedPageCount: 1,
    pages: [{ title: "Home", purpose: "Welcome visitors", requiredContent: "" }],
    preferredTheme: "studio",
    designPreferences: { notes: "" },
    ...overrides,
  };
}

async function generate(
  businessId: unknown,
  user: { _id: unknown; tokenVersion: number } | null,
  payload: unknown = body(),
  options: { origin?: string; contentType?: string; ip?: string } = {},
) {
  const id = String(businessId);
  const auth = user ? await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion) : {};
  ipCounter += 1;
  const res = (await callHandler(
    generatePOST,
    new Request(`http://localhost/api/businesses/${id}/planning/generate`, {
      method: "POST",
      headers: {
        "content-type": options.contentType ?? "application/json",
        host: "localhost",
        "x-forwarded-for": options.ip ?? `198.19.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`,
        ...(options.origin ? { origin: options.origin } : {}),
        ...auth,
      },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("the kill switch is checked first: with a key but AI_PROVIDER_ENABLED unset, nothing is sent", async () => {
  const { owner, business } = await createBusinessWithOwner();
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  for (const value of [undefined, "false", "TRUE", "1"]) {
    if (value === undefined) delete process.env.AI_PROVIDER_ENABLED;
    else process.env.AI_PROVIDER_ENABLED = value;
    const res = await generate(business._id, owner);
    assert.equal(res.status, 503, String(value));
    assert.equal(res.body.code, "provider_not_configured");
  }
  assert.equal(calls.length, 0, "no provider call while paused");
});

test("same-origin JSON, owner/manager of this business and a verified email are required", async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  const { owner, business } = await createBusinessWithOwner();
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const other = await createBusinessWithOwner();

  assert.equal((await generate(business._id, owner, body(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await generate(business._id, owner, "businessSummary=x", { contentType: "application/x-www-form-urlencoded" })).status, 415);
  assert.equal((await generate(business._id, null)).status, 401);
  assert.equal((await generate(business._id, staff)).status, 403);
  assert.equal((await generate(business._id, other.owner)).status, 403);
  await User.updateOne({ _id: manager._id }, { $set: { emailVerifiedAt: null } });
  const unverified = await generate(business._id, manager);
  assert.equal(unverified.status, 403);
  assert.equal(unverified.body.code, "email_unverified");
  assert.equal(calls.length, 0);

  const ok = await generate(business._id, owner);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.review.applied, false, "generate never applies anything");
  assert.equal(calls.length, 1);
});

test("the API key travels only in a header, never in the URL; the prompt holds only what the owner typed", async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  const { owner, business } = await createBusinessWithOwner({ name: "Secret Biz Name" });
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  await Product.create({ business: business._id, name: "Hidden Product", slug: "hidden", price: 1, status: "active" });
  assert.equal((await generate(business._id, owner)).status, 200);
  const [call] = calls;
  assert.ok(!call.url.includes("key="), "no key in the URL");
  assert.ok(!call.url.includes("SECRET123"));
  assert.equal(call.headers["x-goog-api-key"], "test-gemini-key-SECRET123");
  assert.ok(call.body.includes("We sell handmade tea."));
  assert.ok(!call.body.includes("Hidden Product") && !call.body.includes(owner.email), "no database records or emails in the prompt");
});

test("product references must belong to this business", async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  const { owner, business } = await createBusinessWithOwner();
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  const other = await createBusinessWithOwner();
  const mine = await Product.create({ business: business._id, name: "Mine", slug: "mine", price: 1, status: "active" });
  const theirs = await Product.create({ business: other.business._id, name: "Theirs", slug: "theirs", price: 1, status: "active" });
  const refused = await generate(business._id, owner, body({ productIds: [String(mine._id), String(theirs._id)] }));
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "invalid_product_reference");
  assert.equal(calls.length, 0);
  assert.equal((await generate(business._id, owner, body({ productIds: [String(mine._id)] }))).status, 200);
});

test("provider errors reach the client as fixed messages, never the upstream text or key", async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  const { owner, business } = await createBusinessWithOwner();
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    for (const make of [
      () => new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "UPSTREAM-DETAIL echo We sell handmade tea." } }), { status: 400 }),
      () => new Response(JSON.stringify({ error: { code: 500, status: "INTERNAL", message: "UPSTREAM-DETAIL" } }), { status: 200 }),
    ]) {
      upstream = make;
      const res = await generate(business._id, owner);
      assert.equal(res.status, 502);
      assert.equal(res.body.code, "provider_error");
      assert.ok(!JSON.stringify(res.body).includes("UPSTREAM-DETAIL"));
    }
  } finally {
    console.error = realError;
  }
  const logged = JSON.stringify(errors);
  assert.ok(!logged.includes("UPSTREAM-DETAIL") && !logged.includes("SECRET123") && !logged.includes("handmade tea"));
});

test("usage limits: 10 per member per hour and 20 per business per day", async () => {
  process.env.AI_PROVIDER_ENABLED = "true";
  const { owner, business } = await createBusinessWithOwner();
  await grantActiveFreePlan(business._id);
  await grantAiConsent({ businessId: String(business._id), actorId: String(owner._id), version: AI_CONSENT_VERSION });
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await generate(business._id, owner)).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429, "11th call by the same member within an hour");

  const managers = await Promise.all([1, 2].map(async () => {
    const m = await createUser();
    await createMembership(business._id, m._id, "manager");
    return m;
  }));
  const more: number[] = [];
  for (let i = 0; i < 10; i++) more.push((await generate(business._id, managers[0])).status);
  assert.deepEqual(more, Array(10).fill(200), "the business has used 20 calls today");
  const capped = await generate(business._id, managers[1]);
  assert.equal(capped.status, 429, "the daily business cap applies across members");
  assert.equal(calls.length, 20);
});
