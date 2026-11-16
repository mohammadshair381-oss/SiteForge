import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createBusiness, createMembership } from "./helpers/tenant";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest, makeRequest, type AuthHeaders } from "./helpers/auth";
import { getMockCookieStore, resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { platformLogin } from "./helpers/platform-login";
import { waitForSafeRateLimitWindow } from "./helpers/rate-limit-window";
import { clearEmailOutbox, getEmailOutbox, setMemoryEmailFailure } from "@/lib/email";
import { verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { verifySession } from "@/lib/auth/tokens";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";
import { POST as membersPOST } from "@/app/api/businesses/[id]/members/route";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { User } from "@/models/User";
import { Business } from "@/models/Business";
import { AuthToken } from "@/models/AuthToken";
import { SecurityEvent } from "@/models/SecurityEvent";

/**
 * Platform signup and login with email and password only (no emailed code), against the in-memory
 * email outbox. Password reset (still by code) is in password-reset.test.ts.
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
  resetMockCookieStore();
  clearEmailOutbox();
  setMemoryEmailFailure(null);
});

const PASSWORD = "password123";
const BUSINESSES_URL = "http://localhost/api/businesses";
let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${(counter += 1)}@example.com`;
const sessionUser = async () => {
  const token = getMockCookieStore().get(SESSION_COOKIE)?.value;
  return token ? (await verifySession(token))?.userId ?? null : null;
};
const ctx = (businessId: unknown) => ({ params: Promise.resolve({ id: String(businessId) }) });
const authFor = (user: { _id: unknown; tokenVersion: number }): Promise<AuthHeaders> => createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);

async function register(email: string, password = PASSWORD, name = "Signup User") {
  const res = await callHandler(registerPOST, makeRequest("http://localhost/api/auth/register", { name, email, password }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

test("signing up creates the account and signs in at once, with no code and no email", async () => {
  const email = uniqueEmail("signup");
  const res = await register(email);
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, email);
  assert.equal(res.body.user.passwordHash, undefined);

  const user = await User.findOne({ email }).select("+passwordHash");
  assert.ok(user);
  assert.equal(await sessionUser(), String(user._id), "signed in");
  assert.notEqual(user.passwordHash, PASSWORD);
  assert.ok(await verifyPassword(PASSWORD, user.passwordHash));
  assert.equal(user.emailVerifiedAt, undefined, "no confirmation step exists, so no unconfirmed marker");
  assert.equal(getEmailOutbox().length, 0, "no email");
  assert.equal(await AuthToken.countDocuments({}), 0, "no pending code");

  const business = await callHandler(businessesPOST, makeAuthenticatedRequest(BUSINESSES_URL, { name: "New Biz", category: "retail" }, await authFor(user)));
  assert.equal(business.status, 201, "a new account can start building straight away");
});

test("an address that already has an account is refused and keeps its own password", async () => {
  const existing = await createUser({ email: uniqueEmail("taken"), password: "their-own-password" });
  const res = await register(existing.email, "someone-elses-password");
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "email_taken");
  assert.ok(res.body.fields?.email, "shown beside the email field");
  assert.equal(getMockCookieStore().has(SESSION_COOKIE), false);
  const stored = (await User.findById(existing._id).select("+passwordHash"))!;
  assert.ok(await verifyPassword("their-own-password", stored.passwordHash));
  assert.equal(await User.countDocuments({ email: existing.email }), 1);
});

test("concurrent signups for one address create exactly one account", async () => {
  const email = uniqueEmail("race");
  const results = await Promise.all([register(email), register(email, "other-password-1"), register(email, "other-password-2")]);
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.deepEqual(results.filter((r) => r.status !== 201).map((r) => r.status), [409, 409]);
  assert.equal(await User.countDocuments({ email }), 1);
});

test("signup validates the input", async () => {
  const bad = await register("not-an-email");
  assert.equal(bad.status, 422);
  const short = await register(uniqueEmail("short"), "short");
  assert.equal(short.status, 422);
  assert.equal(await User.countDocuments({}), 0);
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("the right password signs in directly, every time, with no code", async () => {
  const user = await createUser({ email: uniqueEmail("login"), password: PASSWORD });
  for (let i = 0; i < 2; i++) {
    resetMockCookieStore();
    const res = await platformLogin(user.email, PASSWORD);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user.email, user.email);
    assert.equal(await sessionUser(), String(user._id));
  }
  assert.equal(getEmailOutbox().length, 0, "no code is emailed");
  assert.equal(await AuthToken.countDocuments({}), 0);
});

test("a wrong password, an unknown and an inactive address get the same answer and no session", async () => {
  const user = await createUser({ email: uniqueEmail("wrong"), password: PASSWORD });
  const inactive = await createUser({ email: uniqueEmail("inactive"), password: PASSWORD });
  await User.updateOne({ _id: inactive._id }, { $set: { active: false } });
  const answers = [await platformLogin(user.email, "not-the-password"), await platformLogin(uniqueEmail("nobody"), PASSWORD), await platformLogin(inactive.email, PASSWORD)];
  const bodies = await Promise.all(answers.map((res) => res.json()));
  for (let i = 0; i < answers.length; i++) {
    assert.equal(answers[i].status, 401);
    assert.deepEqual(bodies[i], bodies[0]);
  }
  assert.equal(getMockCookieStore().has(SESSION_COOKIE), false);
});

test("an account left unconfirmed by the earlier code-based signup works normally after logging in", async () => {
  const user = await createUser({ email: uniqueEmail("legacy-null"), password: PASSWORD });
  await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await platformLogin(user.email, PASSWORD)).status, 200);
  const stored = (await User.findById(user._id).lean())!;
  assert.equal(stored.emailVerifiedAt, undefined);
  const business = await callHandler(businessesPOST, makeAuthenticatedRequest(BUSINESSES_URL, { name: "Biz", category: "retail" }, await authFor(stored)));
  assert.equal(business.status, 201);
});

test("super admin logins are recorded, ordinary ones are not", async () => {
  const admin = await createUser({ email: uniqueEmail("admin"), password: PASSWORD, platformRole: "super_admin" });
  const owner = await createUser({ email: uniqueEmail("owner"), password: PASSWORD });
  assert.equal((await platformLogin(owner.email, PASSWORD)).status, 200);
  assert.equal((await platformLogin(admin.email, PASSWORD)).status, 200);
  const events = await SecurityEvent.find({ type: "admin_login" }).lean();
  assert.equal(events.length, 1);
  assert.equal(String(events[0].user), String(admin._id));
});

test("login works during an email outage: no email is involved", async () => {
  const user = await createUser({ email: uniqueEmail("outage"), password: PASSWORD });
  setMemoryEmailFailure(new Error("provider down"));
  const res = await platformLogin(user.email, PASSWORD);
  setMemoryEmailFailure(null);
  assert.equal(res.status, 200);
  assert.equal(await sessionUser(), String(user._id));
});

test("stale cookies from the old code flow are ignored", async () => {
  const user = await createUser({ email: uniqueEmail("stale"), password: PASSWORD });
  const stale = `swb_login_challenge=${crypto.randomBytes(32).toString("base64url")}; swb_platform_device=garbage`;
  const res = await platformLogin(user.email, PASSWORD, { cookie: stale });
  assert.equal(res.status, 200);
  assert.equal(res.headers.getSetCookie().filter((c) => !c.startsWith(`${SESSION_COOKIE}=`)).length, 0, "no other cookie is set");
});

test("repeated wrong passwords from one source are still limited", async () => {
  const user = await createUser({ email: uniqueEmail("limit"), password: PASSWORD });
  // The limit is a fixed 5-minute window: keep the burst inside one.
  await waitForSafeRateLimitWindow([5 * 60 * 1000]);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await platformLogin(user.email, "not-the-password", { ip: "198.51.100.77" })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});

// ---------------------------------------------------------------------------
// Explicitly unconfirmed accounts (only from before this change) stay gated until they log in
// ---------------------------------------------------------------------------

test("an unconfirmed session cannot create, publish, invite or start checkout", async () => {
  const owner = await createUser();
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  const auth = await authFor(owner);
  const blocked = await callHandler(businessesPOST, makeAuthenticatedRequest(BUSINESSES_URL, { name: "Blocked Biz", category: "retail" }, auth));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, "email_unverified");

  const business = await createBusiness(owner._id);
  await createMembership(business._id, owner._id, "owner");
  for (const [handler, url, body] of [
    [publishPOST, `http://localhost/api/businesses/${business._id}/publish`, { publish: true }],
    [membersPOST, `http://localhost/api/businesses/${business._id}/members`, { email: "someone@example.com", role: "staff" }],
    [subscriptionPOST, `http://localhost/api/businesses/${business._id}/subscription`, { planKey: "free" }],
  ] as const) {
    const res = await callHandler(handler, makeAuthenticatedRequest(url, body, auth), ctx(business._id));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "email_unverified");
  }
  const stored = await Business.findById(business._id);
  assert.equal(stored?.status, "draft");
});
