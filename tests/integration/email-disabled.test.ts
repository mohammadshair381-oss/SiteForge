import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createBusinessWithOwner } from "./helpers/tenant";
import { callHandler, makeRequest } from "./helpers/auth";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { platformLogin } from "./helpers/platform-login";
import { clearEmailOutbox, getEmailOutbox, isEmailDisabled } from "@/lib/email";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { createInvitation } from "@/lib/team-invitations";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { POST as forgotPOST } from "@/app/api/auth/password/forgot/route";
import { AuthToken } from "@/models/AuthToken";
import { TeamInvitation } from "@/models/TeamInvitation";

/**
 * The deliberate "no email" mode (EMAIL_PROVIDER=disabled, lib/email.ts). Set before
 * startIntegrationSuite(), whose EMAIL_* assignments use `??=`.
 */
process.env.EMAIL_PROVIDER = "disabled";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await drainAfterResponseTasks();
  await clearAllCollections();
  clearEmailOutbox();
  resetMockCookieStore();
});

const PASSWORD = "password123";

test("the mode is on", () => {
  assert.equal(isEmailDisabled(), true);
});

test("signup and login work without email", async () => {
  const res = await callHandler(registerPOST, makeRequest("http://localhost/api/auth/register", { name: "No Mail", email: "nomail@example.com", password: PASSWORD }));
  assert.equal(res.status, 201);
  resetMockCookieStore();
  assert.equal((await platformLogin("nomail@example.com", PASSWORD)).status, 200);
  assert.equal(getEmailOutbox().length, 0);
});

test("password reset says plainly that it is unavailable, the same for every address", async () => {
  await createUser({ email: "owner@example.com", password: PASSWORD });
  const ask = async (email: string) => {
    const res = await callHandler(forgotPOST, new Request("http://localhost/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.40" },
      body: JSON.stringify({ email }),
    }));
    await drainAfterResponseTasks();
    return { status: res.status, body: await res.json(), cookies: res.headers.getSetCookie() };
  };
  const known = await ask("owner@example.com");
  const unknown = await ask("nobody@example.com");
  assert.equal(known.status, 503);
  assert.equal(known.body.code, "email_disabled");
  assert.deepEqual(known.body, unknown.body, "reveals nothing about accounts");
  assert.equal(known.cookies.length, 0, "no pending code");
  assert.equal(await AuthToken.countDocuments({}), 0);
  assert.equal(getEmailOutbox().length, 0);
});

test("team invitations are refused instead of silently never arriving", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await assert.rejects(
    createInvitation({ businessId: String(business._id), inviter: { _id: owner._id, name: owner.name }, inviterRole: "owner", email: "staff@example.com", role: "staff" }),
    (error: { status?: number; code?: string }) => error.status === 503 && error.code === "email_disabled",
  );
  assert.equal(await TeamInvitation.countDocuments({}), 0, "nothing is stored");
});

test("order emails are skipped quietly: nothing is sent, nothing fails", async () => {
  const errors: string[] = [];
  const spy = mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  try {
    queueOrderEmail("placed", "507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012");
    await drainAfterResponseTasks();
  } finally {
    spy.mock.restore();
  }
  assert.deepEqual(errors, []);
  assert.equal(getEmailOutbox().length, 0);
});
