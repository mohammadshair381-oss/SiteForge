import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";
import {
  startIntegrationSuite,
  stopIntegrationSuite,
  getTestMongoUri,
} from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createBusinessWithOwner, createMembership } from "./helpers/tenant";
import { getMockCookieStore, resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import {
  cookieFrom,
  freshSourceIp,
  lastLoginCode,
  loginCodeEmails,
  platformLogin,
  requestNewLoginCode,
  setCookieHeader,
  signInWithCode,
  submitLoginCode,
} from "./helpers/platform-login";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { verifySession } from "@/lib/auth/tokens";
import { PLATFORM_DEVICE_COOKIE, platformCredentialFingerprint, signPlatformDevice, verifyPlatformDevice } from "@/lib/auth/platform-device";
import { LOGIN_CHALLENGE_COOKIE, LOGIN_CODE_MAX_ATTEMPTS } from "@/lib/auth/login-challenge";
import { hashPassword } from "@/lib/auth/password";
import { clearEmailOutbox, getEmailOutbox, setMemoryEmailFailure } from "@/lib/email";
import { AuthToken } from "@/models/AuthToken";
import { RateLimit } from "@/models/RateLimit";
import { SecurityEvent } from "@/models/SecurityEvent";
import { User } from "@/models/User";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { applyUserAdminAction, type UserAdminAction } from "@/lib/admin/user-actions";
import { getSecuritySummary } from "@/lib/admin/security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { LOGIN_CODE_FAILURE_WINDOW_MS, LOGIN_CODE_FAILURES_PER_ACCOUNT } from "@/lib/auth/login-code-limits";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest } from "./helpers/auth";

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
  delete process.env.AUTH_LOG_OTP;
});

const PASSWORD = "right-password-1";
const sessionSet = () => getMockCookieStore().has(SESSION_COOKIE);
const sessionUser = async () => {
  const token = getMockCookieStore().get(SESSION_COOKIE)?.value;
  return token ? (await verifySession(token))?.userId ?? null : null;
};
const pendingCount = () => AuthToken.countDocuments({ type: "login_code", usedAt: null });

/** Makes the next codes come out as given (in order), so tests can tell codes apart for certain. */
function forceCodes(...codes: number[]) {
  const queue = [...codes];
  const target = crypto as unknown as { randomInt: (...args: unknown[]) => unknown };
  const original = target.randomInt.bind(crypto);
  return mock.method(target, "randomInt", (...args: unknown[]) => {
    if (args.length === 2 && args[0] === 0 && args[1] === 1_000_000 && queue.length) return queue.shift();
    return original(...args);
  });
}

async function knownDevice(email: string, password = PASSWORD): Promise<string> {
  const done = await signInWithCode(email, password);
  assert.equal(done.final.status, 200);
  assert.ok(done.device);
  resetMockCookieStore();
  clearEmailOutbox();
  return done.device;
}

// ---------------------------------------------------------------------------
// Successful authentication
// ---------------------------------------------------------------------------

test("a new device gets no session or marker for the right password: only a code is emailed", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });

  const first = await platformLogin(user.email, PASSWORD);
  assert.equal(first.status, 202);
  const body = await first.json();
  assert.equal(body.codeRequired, true);
  assert.ok(body.expiresInSeconds > 0 && body.expiresInSeconds <= 300);
  assert.equal(body.attemptsAllowed, LOGIN_CODE_MAX_ATTEMPTS);
  assert.equal(body.user, undefined, "no account data before the code");

  assert.equal(sessionSet(), false, "no session before the code");
  assert.equal(cookieFrom(first, PLATFORM_DEVICE_COOKIE), null, "no marker before the code");
  const challengeHeader = setCookieHeader(first, LOGIN_CHALLENGE_COOKIE);
  assert.ok(challengeHeader);
  assert.match(challengeHeader, /HttpOnly/);
  assert.match(challengeHeader, /SameSite=Strict/);
  assert.match(challengeHeader, /Max-Age=1200/);
  assert.equal(first.headers.getSetCookie().length, 1, "the pending sign-in cookie is the only cookie");

  const code = lastLoginCode(user.email);
  assert.match(code, /^\d{6}$/);
  assert.equal(loginCodeEmails(user.email).length, 1);
  assert.ok(!JSON.stringify(body).includes(code), "the code is never in the answer");
  assert.ok(!(cookieFrom(first, LOGIN_CHALLENGE_COOKIE) ?? "").includes(code));

  // A pending sign-in is not a session anywhere.
  assert.equal(await verifySession(cookieFrom(first, LOGIN_CHALLENGE_COOKIE) ?? ""), null);
});

test("the right code signs in, sets the marker, and that device then signs in without a code", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const done = await signInWithCode(user.email, PASSWORD);
  assert.equal(done.final.status, 200);
  const body = await done.final.json();
  assert.equal(body.user.email, user.email);
  assert.equal(body.user.passwordHash, undefined);
  assert.equal(await sessionUser(), user._id.toString());
  assert.ok(done.device, "the marker is set only now");
  const cleared = setCookieHeader(done.final, LOGIN_CHALLENGE_COOKIE);
  assert.ok(cleared && /Max-Age=0/.test(cleared), "the pending sign-in cookie is cleared");
  assert.ok(await verifyPlatformDevice(done.device, { email: user.email, currentCredential: async () => platformCredentialFingerprint((await User.findById(user._id).select("+passwordHash"))!.passwordHash) }));

  // Recognised device: the existing behaviour, no code.
  resetMockCookieStore();
  clearEmailOutbox();
  const again = await platformLogin(user.email, PASSWORD, { device: done.device });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).user.email, user.email);
  assert.equal(sessionSet(), true);
  assert.ok(cookieFrom(again, PLATFORM_DEVICE_COOKIE), "the marker is refreshed");
  assert.equal(getEmailOutbox().length, 0, "no code for a known device");
  assert.equal(await pendingCount(), 0);
});

test("a known device still needs the right password", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const device = await knownDevice(user.email);
  const wrong = await platformLogin(user.email, "not-the-password", { device });
  assert.equal(wrong.status, 401);
  assert.equal(sessionSet(), false);
});

test("missing, forged, foreign or outdated markers never skip the code", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const other = await createUser({ email: "other@example.com", password: PASSWORD });
  const device = await knownDevice(user.email);
  const otherDevice = await knownDevice(other.email);

  const forged = await signPlatformDevice({ deviceId: "A".repeat(22), email: user.email, credential: "B".repeat(43) });
  const tampered = `${device.slice(0, -2)}xx`;
  for (const marker of [null, "garbage", tampered, forged, otherDevice]) {
    resetMockCookieStore();
    // Each refused marker emails a code; stay under the per-account limit on emailed codes.
    await RateLimit.deleteMany({});
    const res = await platformLogin(user.email, PASSWORD, { device: marker });
    assert.equal(res.status, 202, `marker ${String(marker).slice(0, 12)} must not skip the code`);
    assert.equal(sessionSet(), false);
  }

  // A password change outdates every older marker.
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword("new-password-1") } });
  resetMockCookieStore();
  const outdated = await platformLogin(user.email, "new-password-1", { device });
  assert.equal(outdated.status, 202);
  assert.equal(sessionSet(), false);
});

// ---------------------------------------------------------------------------
// Failure cases
// ---------------------------------------------------------------------------

test("a wrong code is refused and counts down; the fifth wrong code locks that code", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(123456);
  const first = await platformLogin(user.email, PASSWORD);
  mock.restoreAll();
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);

  const statuses: Array<[number, string]> = [];
  for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS; i++) {
    const res = await submitLoginCode(challenge, "000000");
    const body = await res.json();
    statuses.push([res.status, body.code]);
    if (i === 0) {
      assert.match(body.fields.code, /4 tries left/);
    }
  }
  assert.deepEqual(statuses, [
    [400, "code_invalid"],
    [400, "code_invalid"],
    [400, "code_invalid"],
    [400, "code_invalid"],
    [429, "code_attempts_exceeded"],
  ]);
  // Even the right code no longer works for this code.
  const right = await submitLoginCode(challenge, "123456");
  assert.equal(right.status, 429);
  assert.equal((await right.json()).code, "code_attempts_exceeded");
  assert.equal(sessionSet(), false);
  const events = await SecurityEvent.find({ type: "login_code_failed" }).sort({ _id: 1 }).lean();
  assert.deepEqual(events.map((e) => e.reason), ["wrong_code", "wrong_code", "wrong_code", "wrong_code", "too_many_attempts", "too_many_attempts"]);
});

test("an expired code is refused, even when it is right", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const first = await platformLogin(user.email, PASSWORD);
  const code = lastLoginCode(user.email);
  await AuthToken.updateOne({ type: "login_code", user: user._id }, { $set: { codeExpiresAt: new Date(Date.now() - 1000) } });

  const res = await submitLoginCode(cookieFrom(first, LOGIN_CHALLENGE_COOKIE), code);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "code_expired");
  assert.equal(sessionSet(), false);
});

test("a used code cannot be used again", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const done = await signInWithCode(user.email, PASSWORD);
  assert.equal(done.final.status, 200);

  resetMockCookieStore();
  const replay = await submitLoginCode(done.challenge, done.code!);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).code, "login_expired");
  assert.equal(sessionSet(), false);
  assert.equal(cookieFrom(replay, PLATFORM_DEVICE_COOKIE), null);
});

test("a resend replaces the code at once, after a cooldown, at most three times", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(111111, 222222, 333333, 444444);
  const first = await platformLogin(user.email, PASSWORD);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);

  const tooSoon = await requestNewLoginCode(challenge);
  assert.equal(tooSoon.status, 429);
  assert.equal((await tooSoon.json()).code, "resend_cooldown");
  assert.ok(Number(tooSoon.headers.get("Retry-After")) > 0);

  const pastCooldown = () => AuthToken.updateOne({ type: "login_code", user: user._id }, { $set: { lastSentAt: new Date(Date.now() - 61_000) } });
  await pastCooldown();
  const resent = await requestNewLoginCode(challenge);
  assert.equal(resent.status, 200);
  const view = await resent.json();
  assert.equal(view.codeRequired, true);
  assert.equal(view.resendsLeft, 2);
  assert.ok(!JSON.stringify(view).includes("222222"));
  assert.equal(lastLoginCode(user.email), "222222");

  const old = await submitLoginCode(challenge, "111111");
  assert.equal(old.status, 400);
  assert.equal((await old.json()).code, "code_invalid", "the earlier code stopped working");

  for (const expected of [200, 200, 429]) {
    await pastCooldown();
    const res = await requestNewLoginCode(challenge);
    assert.equal(res.status, expected);
    if (expected === 429) assert.equal((await res.json()).code, "resend_limit");
  }
  mock.restoreAll();
  assert.equal(loginCodeEmails(user.email).length, 4, "the first code and three resends");

  const latest = await submitLoginCode(challenge, "444444");
  assert.equal(latest.status, 200);
  assert.equal(await sessionUser(), user._id.toString());
});

test("a code for one account cannot sign in another", async () => {
  const alice = await createUser({ email: "alice@example.com", password: PASSWORD });
  const bob = await createUser({ email: "bob@example.com", password: PASSWORD });
  forceCodes(111111, 222222);
  const aliceLogin = await platformLogin(alice.email, PASSWORD);
  const bobLogin = await platformLogin(bob.email, PASSWORD);
  mock.restoreAll();

  // Alice's code in Bob's pending sign-in.
  const swapped = await submitLoginCode(cookieFrom(bobLogin, LOGIN_CHALLENGE_COOKIE), "111111");
  assert.equal(swapped.status, 400);
  assert.equal((await swapped.json()).code, "code_invalid");
  assert.equal(sessionSet(), false);

  // Alice's own sign-in still works, and signs in Alice only.
  const ok = await submitLoginCode(cookieFrom(aliceLogin, LOGIN_CHALLENGE_COOKIE), "111111");
  assert.equal(ok.status, 200);
  assert.equal(await sessionUser(), alice._id.toString());
});

test("a code for one sign-in cannot finish another, and a newer sign-in cancels the older one", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(111111, 222222);
  const firstBrowser = await platformLogin(user.email, PASSWORD);
  const secondBrowser = await platformLogin(user.email, PASSWORD);
  mock.restoreAll();
  const one = cookieFrom(firstBrowser, LOGIN_CHALLENGE_COOKIE);
  const two = cookieFrom(secondBrowser, LOGIN_CHALLENGE_COOKIE);
  assert.notEqual(one, two);

  const cross = await submitLoginCode(two, "111111");
  assert.equal(cross.status, 400);
  assert.equal((await cross.json()).code, "code_invalid");
  const older = await submitLoginCode(one, "111111");
  assert.equal(older.status, 400);
  assert.equal((await older.json()).code, "login_expired", "the newer sign-in cancelled this one");
  assert.equal(sessionSet(), false);

  const own = await submitLoginCode(two, "222222");
  assert.equal(own.status, 200);
});

test("simultaneous right codes finish the sign-in exactly once", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const first = await platformLogin(user.email, PASSWORD);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  const code = lastLoginCode(user.email);

  const results = await Promise.all(Array.from({ length: 6 }, () => submitLoginCode(challenge, code)));
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one success, got ${statuses.join(",")}`);
  assert.equal(results.filter((r) => cookieFrom(r, PLATFORM_DEVICE_COOKIE)).length, 1, "one marker");
  const record = await AuthToken.findOne({ type: "login_code" }).lean();
  assert.ok(record?.usedAt);
  assert.ok((record?.attempts ?? 0) <= LOGIN_CODE_MAX_ATTEMPTS);
});

test("simultaneous wrong guesses cannot exceed the attempt limit", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(123456);
  const first = await platformLogin(user.email, PASSWORD);
  mock.restoreAll();
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  const guesses = Array.from({ length: 12 }, (_, i) => String(i).padStart(6, "9"));
  const results = await Promise.all(guesses.map((g) => submitLoginCode(challenge, g)));
  assert.equal(results.filter((r) => r.status === 400).length, LOGIN_CODE_MAX_ATTEMPTS - 1);
  assert.equal((await AuthToken.findOne({ type: "login_code" }).lean())?.attempts, LOGIN_CODE_MAX_ATTEMPTS);
  assert.equal((await submitLoginCode(challenge, "123456")).status, 429);
});

test("a password change, sign-out everywhere or deactivation meanwhile cancels the sign-in", async () => {
  for (const change of [
    async (id: unknown) => User.updateOne({ _id: id }, { $set: { passwordHash: await hashPassword("changed-password-1") } }),
    async (id: unknown) => User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } }),
    async (id: unknown) => User.updateOne({ _id: id }, { $set: { active: false } }),
  ]) {
    await clearAllCollections();
    resetMockCookieStore();
    clearEmailOutbox();
    const user = await createUser({ email: "owner@example.com", password: PASSWORD });
    const first = await platformLogin(user.email, PASSWORD);
    const code = lastLoginCode(user.email);
    await change(user._id);
    const res = await submitLoginCode(cookieFrom(first, LOGIN_CHALLENGE_COOKIE), code);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "login_expired");
    assert.equal(sessionSet(), false);
    assert.equal(cookieFrom(res, PLATFORM_DEVICE_COOKIE), null);
    assert.equal(await SecurityEvent.countDocuments({ type: "login_code_failed", reason: "account_changed" }), 1);
  }
});

test("without the pending sign-in cookie a code does nothing", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  await platformLogin(user.email, PASSWORD);
  const code = lastLoginCode(user.email);
  for (const challenge of [null, "x".repeat(43), crypto.randomBytes(32).toString("base64url")]) {
    const res = await submitLoginCode(challenge, code);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "login_expired");
  }
  const malformed = await submitLoginCode(null, "12345");
  assert.equal(malformed.status, 422);
  assert.equal(sessionSet(), false);
});

test("if the code email cannot be sent, nothing is pending and no cookie is set", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  setMemoryEmailFailure(new Error("provider down"));
  const res = await platformLogin(user.email, PASSWORD);
  setMemoryEmailFailure(null);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, "code_not_sent");
  assert.equal(res.headers.getSetCookie().length, 0);
  assert.equal(await pendingCount(), 0);
  assert.equal(sessionSet(), false);
});

// ---------------------------------------------------------------------------
// Account boundaries
// ---------------------------------------------------------------------------

test("super admins, business owners, managers and staff all need the code on a new device", async () => {
  const admin = await createUser({ email: "admin@example.com", password: PASSWORD, platformRole: "super_admin" });
  const { owner, business } = await createBusinessWithOwner();
  await User.updateOne({ _id: owner._id }, { $set: { passwordHash: await hashPassword(PASSWORD) } });
  const manager = await createUser({ email: "manager@example.com", password: PASSWORD });
  const staff = await createUser({ email: "staff@example.com", password: PASSWORD });
  await createMembership(business._id, manager._id, "manager");
  await createMembership(business._id, staff._id, "staff");

  let adminSignIns = 0;
  for (const account of [admin, owner, manager, staff]) {
    resetMockCookieStore();
    const first = await platformLogin(account.email, PASSWORD);
    assert.equal(first.status, 202, `${account.email} must enter a code`);
    assert.equal(sessionSet(), false);
    assert.equal(await SecurityEvent.countDocuments({ type: "admin_login" }), adminSignIns, "no admin sign-in is recorded before the code");

    const done = await submitLoginCode(cookieFrom(first, LOGIN_CHALLENGE_COOKIE), lastLoginCode(account.email));
    if (account === admin) adminSignIns += 1;
    assert.equal(done.status, 200);
    const session = await verifySession(getMockCookieStore().get(SESSION_COOKIE)!.value);
    assert.equal(session?.userId, account._id.toString());
    assert.equal(session?.platformRole, account === admin ? "super_admin" : "user", "the role comes from the account, unchanged");
  }
  assert.equal(await SecurityEvent.countDocuments({ type: "admin_login" }), 1, "the super admin's sign-in is recorded once, after the code");
});

test("an unconfirmed account still gets the wrong-password answer and never a code", async () => {
  const user = await createUser({ email: "new@example.com", password: PASSWORD });
  await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: null } });
  const confirmed = await createUser({ email: "real@example.com", password: PASSWORD });
  const wrong = await platformLogin(confirmed.email, "not-the-password");
  const unconfirmed = await platformLogin(user.email, PASSWORD);
  assert.equal(unconfirmed.status, 401);
  assert.deepEqual(await unconfirmed.json(), await wrong.json());
  assert.equal(unconfirmed.headers.getSetCookie().length, 0);
  assert.equal(await AuthToken.countDocuments({ type: "login_code" }), 0);
  assert.equal(loginCodeEmails(user.email).length, 0);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("only keyed hashes are stored: never the code or the pending sign-in value", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const first = await platformLogin(user.email, PASSWORD);
  const code = lastLoginCode(user.email);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE)!;
  const raw = await AuthToken.collection.find({ type: "login_code" }).toArray();
  assert.equal(raw.length, 1);
  const stored = JSON.stringify(raw);
  assert.ok(!stored.includes(code), "no plaintext code");
  assert.ok(!stored.includes(challenge), "no raw pending sign-in value");
  assert.match(String(raw[0].codeHash), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(raw[0].codeHash === crypto.createHash("sha256").update(code).digest("base64url"), false, "not a plain hash of the code");
  // The model never serialises the hashes.
  const doc = await AuthToken.findOne({ type: "login_code" }).select("+codeHash +credential");
  const json = JSON.stringify(doc?.toJSON());
  assert.ok(!json.includes("codeHash") && !json.includes("credential") && !json.includes("tokenHash"));
});

test("generic action-token helpers can never use up a pending sign-in", async () => {
  const { consumeActionToken, createActionToken } = await import("@/lib/auth/action-tokens");
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const first = await platformLogin(user.email, PASSWORD);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE)!;
  await assert.rejects(() => consumeActionToken(challenge, "login_code" as never), /Unsupported action token type/);
  await assert.rejects(() => createActionToken(user._id, "login_code" as never, 60_000), /Unsupported action token type/);
  for (const type of ["password_reset", "email_verification"] as const) {
    assert.deepEqual(await consumeActionToken(challenge, type), { ok: false, reason: "invalid" });
  }
  assert.equal(await pendingCount(), 1);
});

test("codes are never logged unless development, the flag and a local email provider all hold", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    mock.method(console, method, (...args: unknown[]) => lines.push(args.map(String).join(" ")));
  }
  try {
    await platformLogin(user.email, PASSWORD);
    const code = lastLoginCode(user.email);
    assert.ok(!lines.some((line) => line.includes(code)), "flag unset: no code in any log");

    process.env.AUTH_LOG_OTP = "false";
    clearEmailOutbox();
    await AuthToken.updateMany({}, { $set: { usedAt: new Date() } });
    await platformLogin(user.email, PASSWORD);
    assert.ok(!lines.some((line) => line.includes(lastLoginCode(user.email))), "flag false: no code in any log");

    // The flag alone is not enough outside development (this suite runs with NODE_ENV=test).
    process.env.AUTH_LOG_OTP = "true";
    clearEmailOutbox();
    await platformLogin(user.email, PASSWORD);
    assert.ok(!lines.some((line) => line.includes(lastLoginCode(user.email))), "flag on under NODE_ENV=test: no code in any log");

    // Development, the flag, and an explicitly local provider (this suite uses `memory`).
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    clearEmailOutbox();
    await platformLogin(user.email, PASSWORD);
    const shown = lastLoginCode(user.email);
    const logged = lines.filter((line) => line.includes(shown));
    assert.deepEqual(logged, [`[auth] Development sign-in code for o***@example.com: ${shown}`], "one masked line in development");
    assert.ok(!lines.join("\n").includes(user.email), "the full address is never logged");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    mock.restoreAll();
    delete process.env.AUTH_LOG_OTP;
  }
});

test("rate limits: codes per account, checks and resends per source", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });

  // Codes emailed per account (first codes and resends together): 5 per 15 minutes.
  const sends: number[] = [];
  for (let i = 0; i < 6; i++) sends.push((await platformLogin(user.email, PASSWORD)).status);
  assert.deepEqual(sends, [202, 202, 202, 202, 202, 429]);
  assert.equal(loginCodeEmails(user.email).length, 5);
  assert.equal(sessionSet(), false);

  // Code checks per source: 30 per 15 minutes.
  const ip = freshSourceIp();
  const checks: number[] = [];
  for (let i = 0; i < 31; i++) checks.push((await submitLoginCode(null, "123456", { ip })).status);
  assert.deepEqual([checks.slice(0, 30).every((s) => s === 400), checks[30]], [true, 429]);

  // Resend requests per source: 10 per 15 minutes.
  const resendIp = freshSourceIp();
  const resends: number[] = [];
  for (let i = 0; i < 11; i++) resends.push((await requestNewLoginCode(null, { ip: resendIp })).status);
  assert.deepEqual([resends.slice(0, 10).every((s) => s === 400), resends[10]], [true, 429]);
});

// ---------------------------------------------------------------------------
// Device trust (M1): admin security actions revoke known devices; logout does not
// ---------------------------------------------------------------------------

const REASON = "Responding to a security report (test)";
const pastCooldown = (userId: unknown) =>
  AuthToken.updateOne({ type: "login_code", user: userId, usedAt: null }, { $set: { lastSentAt: new Date(Date.now() - 61_000) } });
const spendAccountBudget = async (userId: unknown, units: number) => {
  for (let i = 0; i < units; i++) {
    await consumeRateLimit({ key: `login-code:fail:account:${String(userId)}`, limit: LOGIN_CODE_FAILURES_PER_ACCOUNT, windowMs: LOGIN_CODE_FAILURE_WINDOW_MS });
  }
};

test("existing markers keep working while the device-trust generation is missing or zero", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const device = await knownDevice(user.email);
  assert.equal((await User.findById(user._id).lean())?.deviceTrustVersion, undefined, "no default is written");

  const missing = await platformLogin(user.email, PASSWORD, { device });
  assert.equal(missing.status, 200);
  await User.updateOne({ _id: user._id }, { $set: { deviceTrustVersion: 0 } });
  resetMockCookieStore();
  const zero = await platformLogin(user.email, PASSWORD, { device });
  assert.equal(zero.status, 200);
  assert.equal(getEmailOutbox().length, 0, "no code for a known device");
});

test("sign-out everywhere, deactivation and both role changes make known devices enter a code again", async () => {
  const admin = await createUser({ email: "admin@example.com", password: PASSWORD, platformRole: "super_admin" });
  const actions: UserAdminAction[] = ["force_signout", "deactivate", "grant_super_admin", "revoke_super_admin"];
  for (const action of actions) {
    await RateLimit.deleteMany({});
    clearEmailOutbox();
    resetMockCookieStore();
    const target = await createUser({
      email: `${action.replace(/_/g, "-")}@example.com`,
      password: PASSWORD,
      platformRole: action === "revoke_super_admin" ? "super_admin" : "user",
    });
    const device = await knownDevice(target.email);
    assert.equal((await platformLogin(target.email, PASSWORD, { device })).status, 200, `${action}: known before`);

    await applyUserAdminAction({ actorId: admin._id.toString(), targetId: target._id.toString(), action, reason: REASON });
    // Reactivating raises nothing itself, so the earlier deactivation alone must have revoked the device.
    if (action === "deactivate") {
      await applyUserAdminAction({ actorId: admin._id.toString(), targetId: target._id.toString(), action: "reactivate", reason: REASON });
    }
    assert.equal((await User.findById(target._id).lean())?.deviceTrustVersion, 1, `${action} raises the generation once`);

    resetMockCookieStore();
    clearEmailOutbox();
    const after = await platformLogin(target.email, PASSWORD, { device });
    assert.equal(after.status, 202, `${action}: the old marker no longer skips the code`);
    assert.equal(sessionSet(), false);

    // The code makes this browser known again, under the new generation.
    const done = await submitLoginCode(cookieFrom(after, LOGIN_CHALLENGE_COOKIE), lastLoginCode(target.email));
    assert.equal(done.status, 200);
    resetMockCookieStore();
    assert.equal((await platformLogin(target.email, PASSWORD, { device: cookieFrom(done, PLATFORM_DEVICE_COOKIE) })).status, 200);
  }
  const audits = await AdminAuditLog.find({ action: "user.force_signout" }).lean();
  assert.equal(audits.length, 1);
  assert.equal((audits[0].after as Record<string, unknown>).trustedDevicesRevoked, true, "the audit entry says so");
});

test("an ordinary logout keeps known devices", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const device = await knownDevice(user.email);
  const before = (await User.findById(user._id).lean())!;
  const headers = await createAuthHeadersForUser(user._id.toString(), "user", before.tokenVersion);

  const out = await callHandler(logoutPOST, makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, headers));
  assert.equal(out.status, 200);
  const stored = (await User.findById(user._id).lean())!;
  assert.equal(stored.tokenVersion, before.tokenVersion + 1, "logout still ends every session");
  assert.equal(stored.deviceTrustVersion, undefined, "but leaves device trust alone");

  resetMockCookieStore();
  clearEmailOutbox();
  const again = await platformLogin(user.email, PASSWORD, { device });
  assert.equal(again.status, 200);
  assert.equal(getEmailOutbox().length, 0);
});

test("pending sign-ins stop working when device trust is revoked", async () => {
  const admin = await createUser({ email: "admin@example.com", password: PASSWORD, platformRole: "super_admin" });
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });

  // The generation alone (no session-version change) is enough.
  const first = await platformLogin(user.email, PASSWORD);
  const code = lastLoginCode(user.email);
  await User.updateOne({ _id: user._id }, { $inc: { deviceTrustVersion: 1 } });
  const refused = await submitLoginCode(cookieFrom(first, LOGIN_CHALLENGE_COOKIE), code);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "login_expired");
  assert.equal(sessionSet(), false);

  // And through the admin action.
  clearEmailOutbox();
  const second = await platformLogin(user.email, PASSWORD);
  const secondCode = lastLoginCode(user.email);
  await applyUserAdminAction({ actorId: admin._id.toString(), targetId: user._id.toString(), action: "force_signout", reason: REASON });
  const refusedAgain = await submitLoginCode(cookieFrom(second, LOGIN_CHALLENGE_COOKIE), secondCode);
  assert.equal(refusedAgain.status, 400);
  assert.equal((await refusedAgain.json()).code, "login_expired");
  assert.equal(sessionSet(), false);
});

// ---------------------------------------------------------------------------
// Guess budget (M3)
// ---------------------------------------------------------------------------

test("a resend keeps the guesses already made: five stay five, and a new code restores none", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(111111, 222222);
  const first = await platformLogin(user.email, PASSWORD);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  for (let i = 0; i < 3; i++) assert.equal((await submitLoginCode(challenge, "000000")).status, 400);

  await pastCooldown(user._id);
  const resent = await requestNewLoginCode(challenge);
  assert.equal(resent.status, 200);
  assert.equal((await resent.json()).attemptsLeft, 2, "the resend did not restore the guesses");
  mock.restoreAll();

  const fourth = await submitLoginCode(challenge, "000000");
  assert.equal(fourth.status, 400);
  assert.match((await fourth.json()).fields.code, /1 try left/);
  const fifth = await submitLoginCode(challenge, "000000");
  assert.equal(fifth.status, 429);
  assert.equal((await fifth.json()).code, "code_attempts_exceeded");

  // Even the newest, right code is refused now, and no further code is sent.
  const right = await submitLoginCode(challenge, "222222");
  assert.equal(right.status, 429);
  await pastCooldown(user._id);
  const noMore = await requestNewLoginCode(challenge);
  assert.equal(noMore.status, 429);
  assert.equal((await noMore.json()).code, "code_attempts_exceeded");
  assert.equal(loginCodeEmails(user.email).length, 2, "the first code and one resend only");
  assert.equal((await AuthToken.findOne({ type: "login_code" }).lean())?.attempts, LOGIN_CODE_MAX_ATTEMPTS);
  assert.equal(sessionSet(), false);
});

test("a resent code still works with the guesses that remain", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(111111, 222222);
  const first = await platformLogin(user.email, PASSWORD);
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  for (let i = 0; i < 4; i++) assert.equal((await submitLoginCode(challenge, "000000")).status, 400);
  await pastCooldown(user._id);
  assert.equal((await requestNewLoginCode(challenge)).status, 200);
  mock.restoreAll();
  const done = await submitLoginCode(challenge, "222222");
  assert.equal(done.status, 200);
  assert.equal(await sessionUser(), user._id.toString());
});

test("the account's daily wrong-code budget holds across pending sign-ins, even under concurrency", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(111111, 222222);
  const guesses = (challenge: string | null) =>
    Promise.all(Array.from({ length: 6 }, (_, i) => submitLoginCode(challenge, String(900000 + i))));

  const one = await platformLogin(user.email, PASSWORD);
  const firstRound = await guesses(cookieFrom(one, LOGIN_CHALLENGE_COOKIE));
  const two = await platformLogin(user.email, PASSWORD);
  const secondRound = await guesses(cookieFrom(two, LOGIN_CHALLENGE_COOKIE));
  mock.restoreAll();
  assert.ok([...firstRound, ...secondRound].every((r) => r.status !== 200));

  const records = await AuthToken.find({ type: "login_code", user: user._id }).lean();
  const compared = records.reduce((sum, r) => sum + (r.attempts ?? 0), 0);
  assert.equal(compared, LOGIN_CODE_FAILURES_PER_ACCOUNT, "exactly the daily budget of wrong codes was compared");

  // A third sign-in gets no code at all: the account has no wrong-code budget left today.
  clearEmailOutbox();
  const third = await platformLogin(user.email, PASSWORD);
  assert.equal(third.status, 429);
  assert.equal((await third.json()).code, "login_code_locked");
  assert.ok(Number(third.headers.get("Retry-After")) > 0);
  assert.equal(third.headers.getSetCookie().length, 0);
  assert.equal(loginCodeEmails(user.email).length, 0);
  assert.equal(sessionSet(), false);
});

test("a used-up account budget refuses even a right code, without comparing it", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  const first = await platformLogin(user.email, PASSWORD);
  const code = lastLoginCode(user.email);
  await spendAccountBudget(user._id, LOGIN_CODE_FAILURES_PER_ACCOUNT);
  const res = await submitLoginCode(cookieFrom(first, LOGIN_CHALLENGE_COOKIE), code);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, "login_code_locked");
  assert.equal(sessionSet(), false);
  assert.equal((await AuthToken.findOne({ type: "login_code" }).lean())?.attempts, 0, "no guess was compared");
});

test("a right code does not spend the account's budget", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  await spendAccountBudget(user._id, LOGIN_CODE_FAILURES_PER_ACCOUNT - 1);
  // One unit left: three sign-ins in a row each borrow it and give it back.
  for (let i = 0; i < 3; i++) {
    resetMockCookieStore();
    const done = await signInWithCode(user.email, PASSWORD);
    assert.equal(done.final.status, 200, `sign-in ${i + 1}`);
  }
});

test("the account lock never changes the password answers, so it reveals no account", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  await spendAccountBudget(user._id, LOGIN_CODE_FAILURES_PER_ACCOUNT + 1);
  const unknown = await platformLogin("nobody@example.com", "a-wrong-password");
  const wrong = await platformLogin(user.email, "a-wrong-password");
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json(), "a locked account answers a wrong password like a missing one");

  // Only the right password reaches the lock, and its answer names no address.
  const right = await platformLogin(user.email, PASSWORD);
  assert.equal(right.status, 429);
  const body = await right.json();
  assert.equal(body.code, "login_code_locked");
  assert.ok(!JSON.stringify(body).includes(user.email));

  // Without a pending sign-in the code routes say nothing about any account.
  const noChallenge = await submitLoginCode(null, "123456");
  assert.equal((await noChallenge.json()).code, "login_expired");
});

test("refused codes reach the admin security counts and the targeted-account alert", async () => {
  const user = await createUser({ email: "owner@example.com", password: PASSWORD });
  forceCodes(123456);
  const first = await platformLogin(user.email, PASSWORD);
  mock.restoreAll();
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  for (let i = 0; i < LOGIN_CODE_MAX_ATTEMPTS; i++) await submitLoginCode(challenge, "000000");

  const summary = await getSecuritySummary();
  assert.equal(summary.failedLoginCodes.lastHour, LOGIN_CODE_MAX_ATTEMPTS);
  assert.equal(summary.failedLoginCodes.last24h, LOGIN_CODE_MAX_ATTEMPTS);
  assert.equal(summary.failedLogins.lastHour, 0, "password failures are counted separately");
  assert.equal(summary.targetedAccounts.length, 1, "5 refused codes in an hour flag the account");
  assert.equal(summary.targetedAccounts[0].scope, "platform");
  assert.equal(summary.targetedAccounts[0].user?.id, user._id.toString());

  const raw = JSON.stringify(await SecurityEvent.collection.find({ type: "login_code_failed" }).toArray());
  assert.ok(!raw.includes(user.email) && !raw.includes("000000") && !raw.includes("123456"), "digests only: no email, no code");
});
