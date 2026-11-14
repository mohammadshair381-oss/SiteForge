import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import {
  startIntegrationSuite,
  stopIntegrationSuite,
  getTestMongoUri,
} from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createBusiness, createMembership } from "./helpers/tenant";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
  makeRequest,
  type AuthHeaders,
} from "./helpers/auth";
import { getMockCookieStore, resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { PLATFORM_DEVICE_COOKIE } from "@/lib/auth/platform-device";
import { signInWithCode } from "./helpers/platform-login";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email";
import { createActionToken } from "@/lib/auth/action-tokens";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { POST as verifyPOST } from "@/app/api/auth/email/verify/route";
import { POST as resendPOST } from "@/app/api/auth/email/resend/route";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";
import { POST as membersPOST } from "@/app/api/businesses/[id]/members/route";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { User } from "@/models/User";
import { Business } from "@/models/Business";
import { AuthToken } from "@/models/AuthToken";

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
});

const REGISTER_URL = "http://localhost/api/auth/register";
const VERIFY_URL = "http://localhost/api/auth/email/verify";
const RESEND_URL = "http://localhost/api/auth/email/resend";
const BUSINESSES_URL = "http://localhost/api/businesses";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function ctx(businessId: unknown) {
  return { params: Promise.resolve({ id: String(businessId) }) };
}

interface RegisterResult {
  status: number;
  body: {
    user: {
      _id: string;
      emailVerifiedAt: Date | null | undefined;
    };
  };
}

/** The answer never says what happened, so what it did is read from the database. */
async function register(email: string): Promise<RegisterResult> {
  const res = await callHandler(
    registerPOST,
    makeRequest(REGISTER_URL, { name: "Verify User", email, password: "password123" }),
  );
  await res.clone().json();
  await drainAfterResponseTasks();
  const user = await User.findOne({ email }).lean();
  return { status: res.status, body: { user: { _id: String(user?._id), emailVerifiedAt: user?.emailVerifiedAt } } };
}

/** Reads the raw verification token out of the queued in-memory email. */
function lastVerificationToken(): string {
  const outbox = getEmailOutbox();
  const message = outbox[outbox.length - 1];
  assert.ok(message, "expected a queued verification email");
  const match = message.text.match(/\/verify-email#token=(\S+)/);
  assert.ok(match, "verification email must contain a token link");
  return decodeURIComponent(match[1]);
}

async function authFor(user: { _id: unknown; tokenVersion: number }): Promise<AuthHeaders> {
  return createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registration creates an explicitly unverified user", async () => {
  const email = uniqueEmail("register-unverified");
  const { status, body } = await register(email);

  assert.equal(status, 202);
  assert.equal(body.user.emailVerifiedAt, null);

  const user = await User.findOne({ email });
  assert.ok(user);
  assert.equal(user.emailVerifiedAt, null);
});

test("registration queues a verification email and never returns the raw token", async () => {
  const email = uniqueEmail("register-email");
  const { body } = await register(email);

  const outbox = getEmailOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, email);

  const token = lastVerificationToken();
  assert.ok(token.length >= 16);

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(token), "response must not contain the raw token");
  assert.ok(!("token" in body), "response must not expose a token field");
});

// ---------------------------------------------------------------------------
// Verification endpoint
// ---------------------------------------------------------------------------

test("a valid token verifies the account", async () => {
  const email = uniqueEmail("verify-ok");
  await register(email);
  const token = lastVerificationToken();

  const res = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { verified: true });

  const user = await User.findOne({ email });
  assert.ok(user?.emailVerifiedAt instanceof Date);
});

test("an expired token is rejected and does not verify the account", async () => {
  const email = uniqueEmail("verify-expired");
  await register(email);
  const token = lastVerificationToken();

  await AuthToken.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

  const res = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");

  const user = await User.findOne({ email });
  assert.equal(user?.emailVerifiedAt, null);
});

test("an unknown token is rejected", async () => {
  await register(uniqueEmail("verify-unknown"));

  const res = await callHandler(
    verifyPOST,
    makeRequest(VERIFY_URL, { token: "a".repeat(43), password: "password123" }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");
});

test("a token cannot be used twice", async () => {
  const email = uniqueEmail("verify-reuse");
  await register(email);
  const token = lastVerificationToken();

  const first = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));
  assert.equal(first.status, 200);

  const second = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));
  assert.equal(second.status, 400);
  assert.equal((await second.json()).code, "invalid_token");
});

test("a token of the wrong type is rejected", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(
    user._id,
    "password_reset",
    60 * 60 * 1000,
  );

  const res = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token: rawToken, password: "password123" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");

  // The user is untouched (still a legacy account).
  const refreshed = await User.findById(user._id);
  assert.equal(refreshed?.emailVerifiedAt, undefined);
});

test("concurrent verification requests verify the account exactly once", async () => {
  const email = uniqueEmail("verify-concurrent");
  await register(email);
  const token = lastVerificationToken();

  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" })),
    ),
  );
  const statuses = results.map((res) => res.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.equal(statuses.filter((status) => status === 400).length, 5);

  const user = await User.findOne({ email });
  assert.ok(user?.emailVerifiedAt instanceof Date);
});

// ---------------------------------------------------------------------------
// Resend endpoint
// ---------------------------------------------------------------------------

test("resend invalidates the previous verification token", async () => {
  const email = uniqueEmail("resend-rotate");
  const { body } = await register(email);
  const userId = body.user._id;

  const firstToken = lastVerificationToken();
  clearEmailOutbox();

  const auth = await createAuthHeadersForUser(userId, "user", (await User.findById(userId).lean())?.tokenVersion);
  const resendRes = await callHandler(
    resendPOST,
    makeAuthenticatedRequest(RESEND_URL, {}, auth),
  );
  assert.equal(resendRes.status, 200);

  const secondToken = lastVerificationToken();
  assert.notEqual(firstToken, secondToken);

  const stale = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token: firstToken, password: "password123" }));
  assert.equal(stale.status, 400);

  const fresh = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token: secondToken, password: "password123" }));
  assert.equal(fresh.status, 200);
});

test("already-verified users receive a generic response and no new email", async () => {
  const email = uniqueEmail("resend-verified");
  const { body } = await register(email);
  const userId = body.user._id;

  const token = lastVerificationToken();
  await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));
  clearEmailOutbox();

  const auth = await createAuthHeadersForUser(userId, "user", (await User.findById(userId).lean())?.tokenVersion);
  const res = await callHandler(resendPOST, makeAuthenticatedRequest(RESEND_URL, {}, auth));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { sent: true });
  assert.equal(getEmailOutbox().length, 0, "no email should be queued for a verified user");
});

test("resend is rate limited per user", async () => {
  const email = uniqueEmail("resend-limit");
  const { body } = await register(email);
  const userId = body.user._id;
  const auth = await createAuthHeadersForUser(userId, "user", (await User.findById(userId).lean())?.tokenVersion);

  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await callHandler(resendPOST, makeAuthenticatedRequest(RESEND_URL, {}, auth));
    statuses.push(res.status);
  }

  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
});

test("resend requires authentication", async () => {
  const res = await callHandler(
    resendPOST,
    makeRequest(RESEND_URL, {}),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

test("unverified users cannot create a business", async () => {
  const email = uniqueEmail("guard-create");
  const { body } = await register(email);
  const userId = body.user._id;
  const auth = await createAuthHeadersForUser(userId, "user", (await User.findById(userId).lean())?.tokenVersion);

  const res = await callHandler(
    businessesPOST,
    makeAuthenticatedRequest(BUSINESSES_URL, { name: "Blocked Biz", category: "retail" }, auth),
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "email_unverified");
  assert.equal(await Business.countDocuments({ owner: userId }), 0);
});

test("business creation succeeds once the email is verified", async () => {
  const email = uniqueEmail("guard-verified");
  const { body } = await register(email);
  const userId = body.user._id;

  const token = lastVerificationToken();
  await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "password123" }));

  const auth = await createAuthHeadersForUser(userId, "user", (await User.findById(userId).lean())?.tokenVersion);
  const res = await callHandler(
    businessesPOST,
    makeAuthenticatedRequest(BUSINESSES_URL, { name: "Allowed Biz", category: "retail" }, auth),
  );
  assert.equal(res.status, 201);
});

test("legacy users without emailVerifiedAt retain full access", async () => {
  const user = await createUser();
  assert.equal(user.emailVerifiedAt, undefined, "legacy account has no verification field");

  const auth = await authFor(user);
  const res = await callHandler(
    businessesPOST,
    makeAuthenticatedRequest(BUSINESSES_URL, { name: "Legacy Biz", category: "retail" }, auth),
  );
  assert.equal(res.status, 201);
});

test("unverified users cannot publish, invite staff, or start checkout", async () => {
  const owner = await createUser();
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  const business = await createBusiness(owner._id);
  await createMembership(business._id, owner._id, "owner");
  const auth = await authFor(owner);

  const publishRes = await callHandler(
    publishPOST,
    makeAuthenticatedRequest(
      `http://localhost/api/businesses/${business._id}/publish`,
      { publish: true },
      auth,
    ),
    ctx(business._id),
  );
  assert.equal(publishRes.status, 403);
  assert.equal((await publishRes.json()).code, "email_unverified");

  const membersRes = await callHandler(
    membersPOST,
    makeAuthenticatedRequest(
      `http://localhost/api/businesses/${business._id}/members`,
      { email: "someone@example.com", role: "staff" },
      auth,
    ),
    ctx(business._id),
  );
  assert.equal(membersRes.status, 403);
  assert.equal((await membersRes.json()).code, "email_unverified");

  const subscriptionRes = await callHandler(
    subscriptionPOST,
    makeAuthenticatedRequest(
      `http://localhost/api/businesses/${business._id}/subscription`,
      { planKey: "free" },
      auth,
    ),
    ctx(business._id),
  );
  assert.equal(subscriptionRes.status, 403);
  assert.equal((await subscriptionRes.json()).code, "email_unverified");

  // The guard runs before any write: the business is untouched.
  const stored = await Business.findById(business._id);
  assert.equal(stored?.status, "draft");
  assert.equal(stored?.publishedAt, null);
});

// ---------------------------------------------------------------------------
// Privacy: nothing reveals whether an address already has an account
// ---------------------------------------------------------------------------

async function registerRaw(email: string, password = "password123") {
  const res = await callHandler(registerPOST, makeRequest(REGISTER_URL, { name: "Someone", email, password }));
  const body = await res.json();
  await drainAfterResponseTasks();
  return { status: res.status, body, cookie: res.headers.get("set-cookie") };
}

test("registering answers the same for a new and an existing address, and signs nobody in", async () => {
  const existing = await createUser({ email: uniqueEmail("taken"), password: "their-own-password" });
  const taken = await registerRaw(existing.email, "attackers-password");
  const fresh = await registerRaw(uniqueEmail("fresh"));
  assert.deepEqual([taken.status, taken.body], [fresh.status, fresh.body]);
  assert.equal(taken.status, 202);
  assert.equal(taken.cookie, null);
  assert.equal(fresh.cookie, null);

  // Nothing about the existing account changed, and its owner is told.
  const after = await User.findById(existing._id).select("+passwordHash");
  assert.equal(after?.passwordHash, existing.passwordHash);
  assert.equal(await User.countDocuments({ email: existing.email }), 1);
  const notice = getEmailOutbox().find((m) => m.to === existing.email);
  assert.ok(notice);
  assert.doesNotMatch(notice.text, /token=/);
});

test("an address cannot be probed by registering and then logging in", async () => {
  const email = uniqueEmail("probe");
  await registerRaw(email, "probing-password-1");
  const login = (address: string, password: string) => callHandler(loginPOST, makeRequest("http://localhost/api/auth/login", { email: address, password }));

  // A new, unconfirmed account refuses exactly as a wrong password does.
  const unconfirmed = await login(email, "probing-password-1");
  const existing = await createUser({ email: uniqueEmail("real"), password: "their-own-password" });
  const wrong = await login(existing.email, "probing-password-1");
  assert.equal(unconfirmed.status, 401);
  assert.deepEqual(await unconfirmed.json(), await wrong.json());

  // With the right password it sends a fresh link, and confirming then works.
  clearEmailOutbox();
  await drainAfterResponseTasks();
  const again = await login(email, "probing-password-1");
  await drainAfterResponseTasks();
  assert.equal(again.status, 401);
  const token = lastVerificationToken();
  assert.equal((await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "probing-password-1" }))).status, 200);
  // Confirmed: the password is accepted, and this new browser then needs its emailed code.
  assert.equal((await login(email, "probing-password-1")).status, 202);
  assert.equal((await signInWithCode(email, "probing-password-1")).final.status, 200);
});

test("the link alone cannot confirm someone else's registration, and a wrong password does not use it up", async () => {
  const email = uniqueEmail("hijack");
  await registerRaw(email, "attackers-password");
  const token = lastVerificationToken();
  const wrong = await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "victims-password" }));
  assert.equal(wrong.status, 400);
  assert.equal((await User.findOne({ email }))?.emailVerifiedAt, null);
  assert.equal((await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "attackers-password" }))).status, 200);
});

test("a correct password on an unconfirmed account neither signs in nor confirms the address", async () => {
  const email = uniqueEmail("unconfirmed-login");
  await registerRaw(email, "the-right-password");
  const login = (address: string, password: string) =>
    callHandler(loginPOST, makeRequest("http://localhost/api/auth/login", { email: address, password }));
  const sessionSet = () => getMockCookieStore().has(SESSION_COOKIE);
  const deviceSet = (res: Response) => res.headers.getSetCookie().some((c) => c.startsWith(`${PLATFORM_DEVICE_COOKIE}=`));

  // The answer a wrong password gets, from a confirmed account.
  const confirmed = await createUser({ email: uniqueEmail("confirmed"), password: "their-own-password" });
  resetMockCookieStore();
  const wrong = await login(confirmed.email, "not-their-password");
  assert.equal(wrong.status, 401);
  const wrongBody = await wrong.json();

  resetMockCookieStore();
  const unconfirmed = await login(email, "the-right-password");
  await drainAfterResponseTasks();
  assert.equal(unconfirmed.status, 401);
  assert.deepEqual(await unconfirmed.json(), wrongBody, "same answer as a wrong password");
  assert.equal(sessionSet(), false, "no session cookie");
  assert.equal(deviceSet(unconfirmed), false, "no device-marker cookie");
  assert.deepEqual(unconfirmed.headers.getSetCookie(), [], "no cookie of any kind");

  const stored = await User.findOne({ email }).lean();
  assert.equal(stored?.emailVerifiedAt, null, "login never confirms an address");

  // Control: once confirmed through the link and password, the same login issues both cookies,
  // so the checks above are not passing for an unrelated reason.
  const token = lastVerificationToken();
  assert.equal((await callHandler(verifyPOST, makeRequest(VERIFY_URL, { token, password: "the-right-password" }))).status, 200);
  // Confirmed now: the password alone still signs nothing in on this new browser ...
  resetMockCookieStore();
  const passwordStep = await login(email, "the-right-password");
  assert.equal(passwordStep.status, 202);
  assert.equal(sessionSet(), false);
  assert.equal(deviceSet(passwordStep), false);
  // ... and the emailed code does, setting the session and the known-device marker.
  resetMockCookieStore();
  const signedIn = (await signInWithCode(email, "the-right-password")).final;
  assert.equal(signedIn.status, 200);
  assert.equal(sessionSet(), true);
  assert.equal(deviceSet(signedIn), true);
});
