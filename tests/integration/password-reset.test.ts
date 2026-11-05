import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import {
  callHandler,
  createAuthHeadersForUser,
  makeAuthenticatedRequest,
  makeRequest,
} from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { clearEmailOutbox, getEmailOutbox } from "@/lib/email";
import { createActionToken } from "@/lib/auth/action-tokens";
import { verifyPassword } from "@/lib/auth/password";
import { POST as forgotRoute } from "@/app/api/auth/password/forgot/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { POST as resetPOST } from "@/app/api/auth/password/reset/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as meHandler } from "@/app/api/auth/me/route";
import { User } from "@/models/User";
import { AuthToken } from "@/models/AuthToken";

/** The reset email goes out after the response, so these tests wait for it. */
const forgotPOST: typeof forgotRoute = async (request) => {
  const response = await forgotRoute(request);
  await drainAfterResponseTasks();
  return response;
};

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

const FORGOT_URL = "http://localhost/api/auth/password/forgot";
const RESET_URL = "http://localhost/api/auth/password/reset";

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Reads the raw reset token out of the queued in-memory email. */
function lastResetToken(): string {
  const outbox = getEmailOutbox();
  const message = outbox[outbox.length - 1];
  assert.ok(message, "expected a queued reset email");
  const match = message.text.match(/\/reset-password#token=(\S+)/);
  assert.ok(match, "reset email must contain a token link");
  return decodeURIComponent(match[1]);
}

// ---------------------------------------------------------------------------
// Forgot-password: enumeration safety
// ---------------------------------------------------------------------------

test("an existing account receives a generic response and a reset email", async () => {
  const user = await createUser({ email: uniqueEmail("forgot-existing"), password: "old-password" });

  const res = await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const outbox = getEmailOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, user.email);
  assert.ok(lastResetToken().length >= 16);
});

test("an unknown address gets the same response and no email", async () => {
  const res = await callHandler(
    forgotPOST,
    makeRequest(FORGOT_URL, { email: uniqueEmail("forgot-unknown") }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(getEmailOutbox().length, 0);
  assert.equal(await AuthToken.countDocuments({ type: "password_reset" }), 0);
});

test("an inactive account gets the same response and no email", async () => {
  const user = await createUser({ email: uniqueEmail("forgot-inactive"), active: false });

  const res = await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(getEmailOutbox().length, 0);
  assert.equal(
    await AuthToken.countDocuments({ user: user._id, type: "password_reset" }),
    0,
  );
});

test("the forgot response never exposes the raw token and only a hash is stored", async () => {
  const user = await createUser({ email: uniqueEmail("forgot-noleak") });
  const res = await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const body = await res.json();
  const token = lastResetToken();

  assert.ok(!JSON.stringify(body).includes(token));
  assert.ok(!("token" in body));

  const stored = await AuthToken.findOne({
    user: user._id,
    type: "password_reset",
  }).select("+tokenHash");
  assert.ok(stored);
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(stored.tokenHash, token);
});

test("forgot-password is rate limited per email", async () => {
  const email = uniqueEmail("forgot-limit");
  const statuses: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email }));
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429);
});

// ---------------------------------------------------------------------------
// Reset-password: success path
// ---------------------------------------------------------------------------

test("a valid token changes the password, revokes sessions, and bumps tokenVersion once", async () => {
  const email = uniqueEmail("reset-ok");
  const user = await createUser({ email, password: "old-password" });
  const startVersion = user.tokenVersion;
  const authHeaders = await createAuthHeadersForUser(user._id.toString(), "user", startVersion);

  const beforeRes = await callHandler(
    meHandler,
    makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders),
  );
  assert.equal(beforeRes.status, 200);

  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email }));
  const token = lastResetToken();

  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token, password: "new-password" }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.ok(reloaded);
  assert.equal(await verifyPassword("new-password", reloaded.passwordHash), true);
  assert.equal(await verifyPassword("old-password", reloaded.passwordHash), false);
  assert.equal(reloaded.tokenVersion, startVersion + 1, "tokenVersion must bump exactly once");

  // The pre-reset session is revoked.
  const afterRes = await callHandler(
    meHandler,
    makeAuthenticatedRequest("http://localhost/api/auth/me", {}, authHeaders),
  );
  assert.equal(afterRes.status, 401);
  assert.equal((await afterRes.json()).code, "session_revoked");

  // Old password no longer works; the new one does.
  const oldLogin = await callHandler(
    loginPOST,
    makeRequest("http://localhost/api/auth/login", { email, password: "old-password" }),
  );
  assert.equal(oldLogin.status, 401);
  const newLogin = await callHandler(
    loginPOST,
    makeRequest("http://localhost/api/auth/login", { email, password: "new-password" }),
  );
  assert.equal(newLogin.status, 200);
});

// ---------------------------------------------------------------------------
// Reset-password: rejection paths
// ---------------------------------------------------------------------------

test("a short new password is rejected with 422 and applies nothing", async () => {
  const user = await createUser({ email: uniqueEmail("reset-short") });
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const token = lastResetToken();

  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token, password: "short" }),
  );
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, "validation_error");

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.equal(await verifyPassword("short", reloaded!.passwordHash), false);
});

test("an expired token is rejected and changes nothing", async () => {
  const user = await createUser({ email: uniqueEmail("reset-expired") });
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const token = lastResetToken();

  await AuthToken.updateOne(
    { type: "password_reset" },
    { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );

  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token, password: "new-password" }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.equal(await verifyPassword("new-password", reloaded!.passwordHash), false);
});

test("an unknown token is rejected", async () => {
  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token: "a".repeat(43), password: "new-password" }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");
});

test("a token cannot be used twice", async () => {
  const user = await createUser({ email: uniqueEmail("reset-reuse") });
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const token = lastResetToken();

  const first = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token, password: "new-password" }),
  );
  assert.equal(first.status, 200);

  const second = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token, password: "another-password" }),
  );
  assert.equal(second.status, 400);
  assert.equal((await second.json()).code, "invalid_token");

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.equal(await verifyPassword("another-password", reloaded!.passwordHash), false);
});

test("a token of the wrong type is rejected", async () => {
  const user = await createUser();
  const { rawToken } = await createActionToken(
    user._id,
    "email_verification",
    60 * 60 * 1000,
  );

  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token: rawToken, password: "new-password" }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");
});

test("a new reset request invalidates the previous token", async () => {
  const user = await createUser({ email: uniqueEmail("reset-rotate") });
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const firstToken = lastResetToken();

  clearEmailOutbox();
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const secondToken = lastResetToken();
  assert.notEqual(firstToken, secondToken);

  const stale = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token: firstToken, password: "new-password" }),
  );
  assert.equal(stale.status, 400);

  const fresh = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token: secondToken, password: "new-password" }),
  );
  assert.equal(fresh.status, 200);
});

// ---------------------------------------------------------------------------
// Concurrency and inactive accounts
// ---------------------------------------------------------------------------

test("concurrent reset attempts cannot both succeed", async () => {
  const user = await createUser({ email: uniqueEmail("reset-concurrent") });
  await callHandler(forgotPOST, makeRequest(FORGOT_URL, { email: user.email }));
  const token = lastResetToken();

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      callHandler(resetPOST, makeRequest(RESET_URL, { token, password: `new-password-${i}` })),
    ),
  );
  const statuses = results.map((res) => res.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.equal(statuses.filter((status) => status === 400).length, 5);

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.ok(reloaded);
  assert.equal(reloaded.tokenVersion, user.tokenVersion + 1);

  const matches = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      verifyPassword(`new-password-${i}`, reloaded.passwordHash),
    ),
  );
  assert.equal(matches.filter(Boolean).length, 1, "exactly one candidate password must apply");
});

test("an inactive account is never reactivated by a reset", async () => {
  const user = await createUser({ email: uniqueEmail("reset-inactive"), active: false });
  // forgot-password skips inactive accounts, so issue the token directly.
  const { rawToken } = await createActionToken(user._id, "password_reset", 60 * 60 * 1000);

  const res = await callHandler(
    resetPOST,
    makeRequest(RESET_URL, { token: rawToken, password: "new-password" }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_token");

  const reloaded = await User.findById(user._id).select("+passwordHash");
  assert.equal(reloaded?.active, false, "account must stay inactive");
  assert.equal(await verifyPassword("new-password", reloaded!.passwordHash), false);
});
