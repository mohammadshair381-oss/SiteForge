import assert from "node:assert/strict";
import test, { before, after, beforeEach, mock } from "node:test";
import crypto from "node:crypto";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest, makeRequest } from "./helpers/auth";
import { getMockCookieStore, resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { cookieFrom, lastLoginCode, loginCodeEmails, platformLogin, signInWithCode } from "./helpers/platform-login";
import { waitForSafeRateLimitWindow } from "./helpers/rate-limit-window";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email";
import { verifyPassword } from "@/lib/auth/password";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { RESET_CHALLENGE_COOKIE } from "@/lib/auth/login-challenge";
import { POST as forgotRoute } from "@/app/api/auth/password/forgot/route";
import { POST as resetPOST } from "@/app/api/auth/password/reset/route";
import { GET as meHandler } from "@/app/api/auth/me/route";
import { User } from "@/models/User";
import { AuthToken } from "@/models/AuthToken";

/**
 * Password reset with an emailed six-digit code (app/api/auth/password/forgot and /reset), against
 * the in-memory email outbox.
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
});

const OLD = "old-password-1";
const NEW = "brand-new-password-2";
let counter = 0;
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${(counter += 1)}@example.com`;

/** Starts a reset; the code email goes out after the response, so this waits for it. */
async function forgot(email: string) {
  const res = await callHandler(forgotRoute, makeRequest("http://localhost/api/auth/password/forgot", { email }));
  const text = await res.text();
  await drainAfterResponseTasks();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown>, challenge: cookieFrom(res, RESET_CHALLENGE_COOKIE) };
}

async function reset(challenge: string | null, code: string, password = NEW) {
  const res = await callHandler(
    resetPOST,
    new Request("http://localhost/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.9", ...(challenge ? { cookie: `${RESET_CHALLENGE_COOKIE}=${challenge}` } : {}) },
      body: JSON.stringify({ code, password }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
}

const otherThan = (code: string) => (code === "000000" ? "111111" : "000000");

// ---------------------------------------------------------------------------
// Asking for a code: enumeration safety
// ---------------------------------------------------------------------------

test("an existing, an unknown and an inactive address get the same answer; only the active account gets a code", async () => {
  const active = await createUser({ email: uniqueEmail("active"), password: OLD });
  const inactive = await createUser({ email: uniqueEmail("inactive"), password: OLD });
  await User.updateOne({ _id: inactive._id }, { $set: { active: false } });

  const answers = [await forgot(active.email), await forgot(uniqueEmail("nobody")), await forgot(inactive.email)];
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.ok(answer.challenge, "every answer sets a pending reset cookie");
    assert.deepEqual({ ...answer.body, expiresInSeconds: 0, resendInSeconds: 0 }, { ...answers[0].body, expiresInSeconds: 0, resendInSeconds: 0 });
  }
  assert.equal(loginCodeEmails(active.email, "reset").length, 1);
  assert.equal(getEmailOutbox().length, 1, "nothing else is sent");
  assert.ok(!answers[0].text.includes(lastLoginCode(active.email, "reset")), "the code is never in the answer");
});

test("only keyed hashes are stored, never the code or the pending value", async () => {
  const user = await createUser({ email: uniqueEmail("hashes"), password: OLD });
  const { challenge } = await forgot(user.email);
  const code = lastLoginCode(user.email, "reset");
  const raw = JSON.stringify(await AuthToken.collection.find({}).toArray());
  assert.ok(!raw.includes(code) && !raw.includes(challenge!));
  assert.equal(await AuthToken.countDocuments({ purpose: "reset" }), 1);
});

test("asking for a code is rate limited per email", async () => {
  const email = uniqueEmail("limit");
  // Requests use a fixed 15-minute window (FORGOT_WINDOW_MS): keep the burst inside one.
  await waitForSafeRateLimitWindow([15 * 60 * 1000]);
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await forgot(email)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

// ---------------------------------------------------------------------------
// Setting the new password
// ---------------------------------------------------------------------------

test("the right code sets the new password, ends every session, confirms the address and never signs in", async () => {
  const user = await createUser({ email: uniqueEmail("success"), password: OLD });
  await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
  const before = (await User.findById(user._id).lean())!;
  const oldSession = await createAuthHeadersForUser(String(user._id), "user", before.tokenVersion);

  const { challenge } = await forgot(user.email);
  const done = await reset(challenge, lastLoginCode(user.email, "reset"));
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { success: true });
  assert.equal(getMockCookieStore().has(SESSION_COOKIE), false, "a reset never signs in");

  const after = (await User.findById(user._id).select("+passwordHash"))!;
  assert.ok(await verifyPassword(NEW, after.passwordHash));
  assert.equal(after.tokenVersion, before.tokenVersion + 1, "sessions revoked once");
  assert.equal(after.deviceTrustVersion, 1, "pending codes revoked");
  assert.ok(after.emailVerifiedAt instanceof Date, "the code proved the mailbox");

  const me = await callHandler(meHandler, makeAuthenticatedRequest("http://localhost/api/auth/me", {}, oldSession));
  assert.equal(me.status, 401, "the old session no longer works");
  assert.equal((await platformLogin(user.email, OLD)).status, 401);
  assert.equal((await signInWithCode(user.email, NEW)).final.status, 200, "the new password works");
});

test("a short new password is refused with 422 and changes nothing", async () => {
  const user = await createUser({ email: uniqueEmail("short"), password: OLD });
  const { challenge } = await forgot(user.email);
  const res = await reset(challenge, lastLoginCode(user.email, "reset"), "short");
  assert.equal(res.status, 422);
  assert.ok(await verifyPassword(OLD, (await User.findById(user._id).select("+passwordHash"))!.passwordHash));
  assert.equal((await reset(challenge, lastLoginCode(user.email, "reset"))).status, 200, "the code was not used up");
});

test("a wrong code counts down, then locks the code; an expired code changes nothing", async () => {
  const user = await createUser({ email: uniqueEmail("wrong"), password: OLD });
  const { challenge } = await forgot(user.email);
  const code = lastLoginCode(user.email, "reset");
  const first = await reset(challenge, otherThan(code));
  assert.equal(first.status, 400);
  assert.equal(first.body.code, "code_invalid");
  for (let i = 0; i < 4; i++) await reset(challenge, otherThan(code));
  const locked = await reset(challenge, code);
  assert.equal(locked.status, 429, "after five wrong codes even the right one is refused");

  clearEmailOutbox();
  const again = await forgot(user.email);
  await AuthToken.updateOne({ purpose: "reset", usedAt: null }, { $set: { codeExpiresAt: new Date(Date.now() - 1000) } });
  const expired = await reset(again.challenge, lastLoginCode(user.email, "reset"));
  assert.equal(expired.status, 400);
  assert.equal(expired.body.code, "code_expired");
  assert.ok(await verifyPassword(OLD, (await User.findById(user._id).select("+passwordHash"))!.passwordHash));
});

test("a code works once, and a newer request replaces the older code", async () => {
  const user = await createUser({ email: uniqueEmail("once"), password: OLD });
  const first = await forgot(user.email);
  const firstCode = lastLoginCode(user.email, "reset");
  const second = await forgot(user.email);
  assert.equal((await reset(first.challenge, firstCode)).status, 400, "the older code stopped working");
  const secondCode = lastLoginCode(user.email, "reset");
  assert.equal((await reset(second.challenge, secondCode)).status, 200);
  assert.equal((await reset(second.challenge, secondCode, "another-password-3")).status, 400, "single use");
});

test("an unknown address's pending code answers exactly like a wrong code and changes nothing", async () => {
  const { challenge } = await forgot(uniqueEmail("ghost"));
  const res = await reset(challenge, "123456");
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "code_invalid");
  assert.equal(await User.countDocuments({}), 0);
});

test("concurrent resets with the right code succeed exactly once", async () => {
  const user = await createUser({ email: uniqueEmail("race"), password: OLD });
  const startVersion = (await User.findById(user._id).lean())!.tokenVersion;
  const { challenge } = await forgot(user.email);
  const code = lastLoginCode(user.email, "reset");
  const results = await Promise.all([reset(challenge, code, "race-password-1"), reset(challenge, code, "race-password-2"), reset(challenge, code, "race-password-3")]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await User.findById(user._id).lean())?.tokenVersion, startVersion + 1, "revoked once");
});

test("an inactive account is never reset or reactivated", async () => {
  const user = await createUser({ email: uniqueEmail("inactive"), password: OLD });
  const { challenge } = await forgot(user.email);
  const code = lastLoginCode(user.email, "reset");
  await User.updateOne({ _id: user._id }, { $set: { active: false } });
  const res = await reset(challenge, code);
  assert.equal(res.status, 400);
  const stored = (await User.findById(user._id).select("+passwordHash"))!;
  assert.equal(stored.active, false);
  assert.ok(await verifyPassword(OLD, stored.passwordHash));
});

test("wrong reset codes never block logging in", async () => {
  const user = await createUser({ email: uniqueEmail("budget"), password: OLD });
  // Two pending resets x 5 wrong codes = a whole daily budget, if it were the login one.
  for (let round = 0; round < 2; round++) {
    const { challenge } = await forgot(user.email);
    const code = lastLoginCode(user.email, "reset");
    for (let i = 0; i < 5; i++) await reset(challenge, otherThan(code));
  }
  const done = await signInWithCode(user.email, OLD);
  assert.equal(done.final.status, 200, "logging in still works");
});

test("the reset answers never reveal the code, the pending value or a password", async () => {
  const user = await createUser({ email: uniqueEmail("leak"), password: OLD });
  const { challenge, text } = await forgot(user.email);
  const code = lastLoginCode(user.email, "reset");
  const lines: string[] = [];
  mock.method(console, "error", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  mock.method(console, "warn", (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  try {
    const done = await reset(challenge, code);
    const all = [text, JSON.stringify(done.body), ...done.res.headers.getSetCookie(), ...lines].join("\n");
    for (const secret of [code, NEW, OLD, crypto.createHash("sha256").update(challenge!).digest("hex")]) assert.ok(!all.includes(secret));
  } finally {
    mock.restoreAll();
  }
});
