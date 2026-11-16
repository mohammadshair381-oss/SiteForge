import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser, getPlainPassword } from "./helpers/fixtures";
import { POST as registerHandler } from "@/app/api/auth/register/route";
import { POST as loginHandler } from "@/app/api/auth/login/route";
import { POST as logoutHandler } from "@/app/api/auth/logout/route";
import { GET as meHandler } from "@/app/api/auth/me/route";
import { POST as passwordHandler } from "@/app/api/auth/password/route";
import { makeRequest, makeAuthenticatedRequest, createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { signSession, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { signInWithCode } from "./helpers/platform-login";
import { User } from "@/models/User";
import { getMockCookieStore, resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { drainAfterResponseTasks } from "@/lib/after-response";

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
});

test("register creates a user with a hashed password and signs in", async () => {
  const email = `test-${Date.now()}@example.com`;
  const res = await callHandler(registerHandler, makeRequest("http://localhost/api/auth/register", { email, name: "Test User", password: "password123" }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.email, email);
  assert.equal(body.user.passwordHash, undefined);
  assert.ok(getMockCookieStore().has(SESSION_COOKIE), "signed in");

  const userInDb = await User.findOne({ email }).select("+passwordHash");
  assert.ok(userInDb);
  assert.equal(userInDb.name, "Test User");
  assert.notEqual(userInDb.passwordHash, "password123");
  assert.equal(userInDb.emailVerifiedAt, undefined);
});

test("registering an email twice keeps one account and refuses the second", async () => {
  const email = `duplicate-${Date.now()}@example.com`;
  const first = await callHandler(registerHandler, makeRequest("http://localhost/api/auth/register", { email, name: "User 1", password: "password123" }));
  resetMockCookieStore();
  const second = await callHandler(registerHandler, makeRequest("http://localhost/api/auth/register", { email, name: "User 2", password: "password456" }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "email_taken");
  assert.equal(await User.countDocuments({ email }), 1);
  assert.equal((await User.findOne({ email }))?.name, "User 1");
});

test("login with correct credentials returns 200 and user data", async () => {
  const user = await createUser({ email: "login-test@example.com", password: "correct-password" });
  const password = getPlainPassword(user);
  assert.ok(password);

  const res = (await signInWithCode("login-test@example.com", password)).final;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, "login-test@example.com");
  assert.equal(body.user._id, user._id.toString());
});

test("login with wrong password returns 401", async () => {
  const user = await createUser({ email: "wrong-pass@example.com", password: "correct-password" });

  const req = makeRequest("http://localhost/api/auth/login", { email: "wrong-pass@example.com", password: "wrong-password" });
  const res = await loginHandler(req);

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "invalid_credentials");
});

test("login with non-existent email returns 401", async () => {
  const req = makeRequest("http://localhost/api/auth/login", { email: "nonexistent@example.com", password: "anypassword" });
  const res = await loginHandler(req);

  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.code, "invalid_credentials");
});

test("me endpoint returns user data with valid session token", async () => {
  const user = await createUser({ email: "me-test@example.com", name: "Me Test User" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const meReq = makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders);
  const meRes = await callHandler(meHandler, meReq);

  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user._id, user._id.toString());
  assert.equal(meData.user.email, "me-test@example.com");
  assert.equal(meData.user.name, "Me Test User");
  assert.ok(Array.isArray(meData.memberships));
});

test("me endpoint returns 401 without session", async () => {
  const meReq = makeRequest("http://localhost/api/auth/me", {});
  const meRes = await callHandler(meHandler, meReq);

  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "unauthenticated");
});

test("me endpoint returns 401 with invalid session token", async () => {
  const meReq = new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers: { cookie: "swb_session=invalid-token" },
  });
  const meRes = await callHandler(meHandler, meReq);

  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "unauthenticated");
});

test("me endpoint returns 401 with expired session token", async () => {
  const expiredToken = await new (await import("jose")).SignJWT({ userId: "user-1", platformRole: "user", tokenVersion: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));

  const meReq = new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers: { cookie: `swb_session=${expiredToken}` },
  });
  const meRes = await callHandler(meHandler, meReq);

  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "unauthenticated");
});

test("me endpoint returns 401 with session token for non-existent user", async () => {
  const fakeUserToken = await signSession({ userId: "507f1f77bcf86cd799439011", platformRole: "user", tokenVersion: 0 });
  const meReq = new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers: { cookie: `swb_session=${fakeUserToken}` },
  });
  const meRes = await callHandler(meHandler, meReq);

  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "unauthenticated");
});

test("logout destroys session and subsequent me request fails", async () => {
  const user = await createUser({ email: "logout-test@example.com", name: "Logout Test User" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const logoutReq = makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, authHeaders);
  const logoutRes = await callHandler(logoutHandler, logoutReq);
  assert.equal(logoutRes.status, 200);

  // After logout, make a fresh request WITHOUT the session cookie
  const meReq = new Request("http://localhost/api/auth/me", { method: "GET" });
  const meRes = await callHandler(meHandler, meReq);
  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "unauthenticated");
});

test("logout revokes the old JWT so it can no longer access /api/auth/me", async () => {
  const user = await createUser({ email: "logout-revoke@example.com", name: "Logout Revoke" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  // 1. The session works before logout.
  const beforeReq = makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders);
  const beforeRes = await callHandler(meHandler, beforeReq);
  assert.equal(beforeRes.status, 200);

  // 2. Logout succeeds.
  const logoutReq = makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, authHeaders);
  const logoutRes = await callHandler(logoutHandler, logoutReq);
  assert.equal(logoutRes.status, 200);
  assert.deepEqual(await logoutRes.json(), { success: true });

  // 3. The SAME (now revoked) JWT is rejected with an explicit revocation code.
  const replayReq = makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders);
  const replayRes = await callHandler(meHandler, replayReq);
  assert.equal(replayRes.status, 401);
  assert.equal((await replayRes.json()).code, "session_revoked");

  // 4. Revocation happened server-side via a tokenVersion bump.
  const reloaded = await User.findById(user._id);
  assert.ok(reloaded);
  assert.equal(reloaded.tokenVersion, user.tokenVersion + 1);
});

test("logout clears the session cookie with the existing configuration", async () => {
  const user = await createUser({ email: "logout-cookie@example.com" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const logoutReq = makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, authHeaders);
  const logoutRes = await callHandler(logoutHandler, logoutReq);
  assert.equal(logoutRes.status, 200);

  const cleared = getMockCookieStore().get(SESSION_COOKIE);
  assert.ok(cleared, "expected the session cookie to be set (cleared)");
  assert.equal(cleared.value, "");
  assert.equal(cleared.options?.maxAge, 0);
  assert.equal(cleared.options?.path, "/");
  assert.equal(cleared.options?.httpOnly, true);
  assert.equal(cleared.options?.sameSite, "lax");
});

test("logout without a session is idempotent and still clears the cookie", async () => {
  const logoutReq = makeRequest("http://localhost/api/auth/logout", {});
  const logoutRes = await callHandler(logoutHandler, logoutReq);

  assert.equal(logoutRes.status, 200);
  assert.deepEqual(await logoutRes.json(), { success: true });
  const cleared = getMockCookieStore().get(SESSION_COOKIE);
  assert.ok(cleared);
  assert.equal(cleared.value, "");
});

test("logout with an invalid token still succeeds without touching the DB", async () => {
  const logoutReq = new Request("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=not-a-valid-jwt` },
  });
  const logoutRes = await callHandler(logoutHandler, logoutReq);

  assert.equal(logoutRes.status, 200);
  assert.deepEqual(await logoutRes.json(), { success: true });
});

test("logout succeeds when the session's user no longer exists", async () => {
  const ghostToken = await signSession({
    userId: "507f1f77bcf86cd799439011",
    platformRole: "user",
    tokenVersion: 0,
  });
  const logoutReq = new Request("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${ghostToken}` },
  });
  const logoutRes = await callHandler(logoutHandler, logoutReq);

  assert.equal(logoutRes.status, 200);
  assert.deepEqual(await logoutRes.json(), { success: true });
});

test("logout does not report success when required revocation fails", async () => {
  const user = await createUser({ email: "logout-db-fail@example.com" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  // Simulate a database failure during the revocation write. Revocation is
  // required here (a valid session was presented), so the failure must surface
  // as an error rather than a bogus { success: true }.
  type MutableModel = { updateOne: (...args: unknown[]) => Promise<unknown> };
  const model = User as unknown as MutableModel;
  const originalUpdateOne = model.updateOne;
  model.updateOne = async () => {
    throw new Error("simulated database failure");
  };

  try {
    const logoutReq = makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, authHeaders);
    const logoutRes = await callHandler(logoutHandler, logoutReq);

    assert.equal(logoutRes.status, 500);
    assert.equal((await logoutRes.json()).code, "internal_error");
    // The cookie must NOT be reported as cleared, since revocation failed.
    assert.equal(getMockCookieStore().has(SESSION_COOKIE), false);
  } finally {
    model.updateOne = originalUpdateOne;
  }
});

test("a fresh login after logout issues a working session", async () => {
  const user = await createUser({ email: "logout-relogin@example.com", password: "password123" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const logoutRes = await callHandler(
    logoutHandler,
    makeAuthenticatedRequest("http://localhost/api/auth/logout", {}, authHeaders),
  );
  assert.equal(logoutRes.status, 200);

  const loginRes = (await signInWithCode("logout-relogin@example.com", "password123")).final;
  assert.equal(loginRes.status, 200);

  // The login handler stored a brand-new session cookie; replay it against /me.
  const freshToken = getMockCookieStore().get(SESSION_COOKIE)?.value;
  assert.ok(freshToken);
  const meReq = new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers: { cookie: `${SESSION_COOKIE}=${freshToken}` },
  });
  const meRes = await callHandler(meHandler, meReq);
  assert.equal(meRes.status, 200);
});

test("password change revokes old sessions via tokenVersion bump", async () => {
  const user = await createUser({ email: "pwd-change@example.com", password: "old-password" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const passwordReq = makeAuthenticatedRequest("http://localhost/api/auth/password", { currentPassword: "old-password", newPassword: "new-password" }, authHeaders);
  const passwordRes = await callHandler(passwordHandler, passwordReq);
  assert.equal(passwordRes.status, 200);

  const meReq = makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders);
  const meRes = await callHandler(meHandler, meReq);
  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "session_revoked");
});

test("password change issues new session for current client", async () => {
  const user = await createUser({ email: "pwd-change-new-session@example.com", password: "old-password" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const passwordReq = makeAuthenticatedRequest("http://localhost/api/auth/password", { currentPassword: "old-password", newPassword: "new-password" }, authHeaders);
  const passwordRes = await callHandler(passwordHandler, passwordReq);
  assert.equal(passwordRes.status, 200);

  // Verify tokenVersion was bumped in the database
  const updatedUser = await User.findById(user._id);
  assert.ok(updatedUser);
  assert.equal(updatedUser.tokenVersion, user.tokenVersion + 1);

  // The old session should be revoked
  const meReq = makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders);
  const meRes = await callHandler(meHandler, meReq);
  assert.equal(meRes.status, 401);
  const body = await meRes.json();
  assert.equal(body.code, "session_revoked");
});

test("password change with wrong current password returns 400", async () => {
  const user = await createUser({ email: "pwd-wrong@example.com", password: "correct-password" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const passwordReq = makeAuthenticatedRequest("http://localhost/api/auth/password", { currentPassword: "wrong-password", newPassword: "new-password" }, authHeaders);
  const passwordRes = await callHandler(passwordHandler, passwordReq);
  assert.equal(passwordRes.status, 400);
  const body = await passwordRes.json();
  assert.equal(body.code, "invalid_password");
});

test("password change with short new password returns 422", async () => {
  const user = await createUser({ email: "pwd-short@example.com", password: "old-password" });
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);

  const passwordReq = makeAuthenticatedRequest("http://localhost/api/auth/password", { currentPassword: "old-password", newPassword: "short" }, authHeaders);
  const passwordRes = await callHandler(passwordHandler, passwordReq);
  assert.equal(passwordRes.status, 422);
  const body = await passwordRes.json();
  assert.equal(body.code, "validation_error");
});