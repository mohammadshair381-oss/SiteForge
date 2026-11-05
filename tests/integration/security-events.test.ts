import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as securityGET } from "@/app/api/admin/security-events/route";
import { PATCH as userPATCH } from "@/app/api/admin/users/[id]/route";
import { getSecuritySummary, listSecurityEvents, securityQuerySchema } from "@/lib/admin/security";
import { securityDigest } from "@/lib/security-events";
import { SecurityEvent } from "@/models/SecurityEvent";

/** Platform sign-in security events: minimisation, accuracy, isolation from login outcome. */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

async function login(email: string, password: string, ip = freshIp()) {
  const res = (await callHandler(
    loginPOST,
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }),
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("failed sign-ins are recorded with a reason and fingerprints only, never the password or raw email", async () => {
  const user = await createUser({ email: "known@example.com", password: "right-password-1" });
  const inactive = await createUser({ email: "gone@example.com", active: false });

  const unknown = await login("Nobody@Example.com", "secret-guess-1");
  const wrong = await login("known@example.com", "secret-guess-2");
  const off = await login("gone@example.com", "password123");
  assert.deepEqual([unknown.status, wrong.status, off.status], [401, 401, 401]);
  assert.deepEqual(unknown.body, wrong.body, "responses do not reveal whether the account exists");

  const events = await SecurityEvent.find().sort({ _id: 1 }).lean();
  assert.deepEqual(events.map((e) => [e.type, e.reason]), [
    ["login_failed", "unknown_account"],
    ["login_failed", "wrong_password"],
    ["login_failed", "inactive_account"],
  ]);
  assert.equal(events[0].user, null);
  assert.equal(String(events[1].user), String(user._id));
  assert.equal(String(events[2].user), String(inactive._id));
  assert.equal(events[0].emailDigest, securityDigest("email", "nobody@example.com"), "email normalised before hashing");
  assert.ok(events.every((e) => typeof e.sourceDigest === "string" && e.sourceDigest.length === 64));
  // Retention: expiresAt is set ~90 days after the event (computed just before the insert).
  assert.ok(events.every((e) => Math.abs(e.expiresAt.getTime() - e.createdAt.getTime() - 90 * 86_400_000) < 5_000));

  const raw = JSON.stringify(await SecurityEvent.collection.find().toArray());
  for (const secret of ["nobody@example.com", "Nobody@Example.com", "known@example.com", "secret-guess", "right-password", "198.18."]) {
    assert.ok(!raw.toLowerCase().includes(secret.toLowerCase()), `stored data must not contain ${secret}`);
  }
});

test("successful ordinary sign-ins are not recorded; super-admin sign-ins are", async () => {
  await createUser({ email: "user@example.com", password: "pw-123456" });
  await createUser({ email: "boss@example.com", password: "pw-123456", platformRole: "super_admin" });
  assert.equal((await login("user@example.com", "pw-123456")).status, 200);
  assert.equal(await SecurityEvent.countDocuments(), 0);
  assert.equal((await login("boss@example.com", "pw-123456")).status, 200);
  const events = await SecurityEvent.find().lean();
  assert.deepEqual(events.map((e) => e.type), ["admin_login"]);
  assert.equal(events[0].emailDigest, null);
});

test("a recording failure never changes the sign-in result", async () => {
  await createUser({ email: "known@example.com", password: "right-password-1" });
  const create = mock.method(SecurityEvent, "create", async () => {
    throw new Error("database down");
  });
  const warn = mock.method(console, "warn", () => {});
  try {
    const failed = await login("known@example.com", "wrong");
    assert.equal(failed.status, 401);
    assert.equal(failed.body.code, "invalid_credentials");
    assert.equal((await login("known@example.com", "right-password-1")).status, 200);
    assert.ok(create.mock.callCount() >= 1);
    const logged = JSON.stringify(warn.mock.calls.map((c) => c.arguments));
    assert.ok(logged.includes("security_event_write_failed"));
    assert.ok(!logged.includes("known@example.com") && !logged.includes("database down"), "no email or error detail in logs");
  } finally {
    create.mock.restore();
    warn.mock.restore();
  }
});

test("rate-limited attempts are not recorded, which bounds event volume", async () => {
  await createUser({ email: "target@example.com", password: "right-password-1" });
  const results = [];
  const source = freshIp();
  for (let i = 0; i < 7; i++) results.push((await login("target@example.com", `guess-${i}`, source)).status);
  assert.deepEqual(results, [401, 401, 401, 401, 401, 429, 429]);
  assert.equal(await SecurityEvent.countDocuments({ type: "login_failed" }), 5);
  // That source has not locked the person out: they sign in from somewhere else.
  assert.equal((await login("target@example.com", "right-password-1")).status, 200);
});

test("rotating sources still run into a limit per account", async () => {
  await createUser({ email: "target@example.com", password: "right-password-1" });
  // Limits use fixed time windows, so a slow run can cross into a new one: at most twice the limit.
  const results: number[] = [];
  for (let i = 0; i < 101 && !results.includes(429); i++) results.push((await login("target@example.com", `guess-${i}`)).status);
  assert.equal(results.at(-1), 429);
  assert.ok(results.length >= 51);
});

test("summary flags targeted accounts and busy sources; events past retention are hidden", async () => {
  const user = await createUser({ email: "target@example.com" });
  const now = new Date();
  const docs = [];
  for (let i = 0; i < 6; i++) {
    docs.push({ type: "login_failed", reason: "wrong_password", user: user._id, emailDigest: "e".repeat(64), sourceDigest: "s".repeat(64), createdAt: now, expiresAt: now });
  }
  for (let i = 0; i < 15; i++) {
    docs.push({ type: "login_failed", reason: "unknown_account", user: null, emailDigest: `${i}`.padStart(64, "a"), sourceDigest: "s".repeat(64), createdAt: now, expiresAt: now });
  }
  docs.push({ type: "admin_reauth_failed", reason: null, user: user._id, emailDigest: null, sourceDigest: null, createdAt: now, expiresAt: now });
  docs.push({ type: "login_failed", reason: "wrong_password", user: user._id, emailDigest: "x", sourceDigest: null, createdAt: new Date(now.getTime() - 100 * 86_400_000), expiresAt: now });
  await SecurityEvent.collection.insertMany(docs);

  const summary = await getSecuritySummary(now);
  assert.equal(summary.failedLogins.lastHour, 21);
  assert.equal(summary.adminReauthFailures24h, 1);
  // Events inserted without a scope are platform events (pre-scope documents).
  assert.deepEqual(summary.targetedAccounts, [
    { digest: "eeeeeeeeee", failures: 6, scope: "platform", user: { id: String(user._id), name: user.name, email: user.email }, business: null },
  ]);
  assert.deepEqual(summary.busySources, [{ digest: "ssssssssss", failures: 21, distinctAccounts: 16 }]);

  const list = await listSecurityEvents(securityQuerySchema.parse({}), now);
  assert.equal(list.total, 22, "the 100-day-old event is outside retention");
  assert.equal((await listSecurityEvents(securityQuerySchema.parse({ type: "admin_reauth_failed" }), now)).total, 1);
  assert.equal((await listSecurityEvents(securityQuerySchema.parse({ reason: "unknown_account" }), now)).total, 15);
  assert.equal((await listSecurityEvents(securityQuerySchema.parse({ user: String(user._id) }), now)).total, 7);
  const withAccount = list.events.find((e) => e.account !== null);
  assert.equal(withAccount?.account?.length, 10, "digests are shortened in views");
});

test("the security API is super-admin only; a failed admin password confirmation is recorded", async () => {
  const admin = await createUser({ platformRole: "super_admin", password: "admin-pw-1" });
  const plain = await createUser();
  const adminHeaders = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  const plainHeaders = await createAuthHeadersForUser(String(plain._id), "user", plain.tokenVersion);
  const get = async (headers?: { cookie: string }) =>
    ((await callHandler(securityGET, new Request("http://localhost/api/admin/security-events", { headers: { ...(headers ?? {}) } }))) as Response).status;
  assert.equal(await get(), 401);
  assert.equal(await get(plainHeaders), 403);
  assert.equal(await get(adminHeaders), 200);

  const target = await createUser();
  const res = (await callHandler(
    userPATCH,
    new Request(`http://localhost/api/admin/users/${target._id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...adminHeaders },
      body: JSON.stringify({ action: "grant_super_admin", reason: "Testing re-auth", currentPassword: "wrong" }),
    }),
    { params: Promise.resolve({ id: String(target._id) }) },
  )) as Response;
  assert.equal(res.status, 403);
  const events = await SecurityEvent.find({ type: "admin_reauth_failed" }).lean();
  assert.equal(events.length, 1);
  assert.equal(String(events[0].user), String(admin._id));
});

test("security events are append-only through the application", async () => {
  await SecurityEvent.create({ type: "admin_login", expiresAt: new Date() });
  await assert.rejects(() => SecurityEvent.updateOne({}, { $set: { type: "login_failed" } }), /append-only/);
  const doc = await SecurityEvent.findOne();
  doc!.set("reason", "wrong_password");
  await assert.rejects(() => doc!.save(), /append-only/);
});
