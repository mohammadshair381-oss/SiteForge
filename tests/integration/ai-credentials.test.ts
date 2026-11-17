import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createUser } from "./helpers/fixtures";
import { DELETE as keyDELETE, GET as keyGET, PUT as keyPUT } from "@/app/api/admin/ai-credentials/route";
import { aiProviderKey, clearAiCredentialCache, loadAiCredentials } from "@/lib/ai-providers/credentials";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { AiProviderCredential } from "@/models/AiProviderCredential";

/** AI provider API keys set by a Super Admin (app/api/admin/ai-credentials): encrypted, never shown, audited. */

const PASSWORD = "admin-password-123";
const KEY = "sk-ant-test-1234567890abcdefghijklmnopWXYZ";
const REASON = "New key from the provider console";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await clearAllCollections();
  clearAiCredentialCache();
  delete process.env.ANTHROPIC_API_KEY;
});

async function adminHeaders(role: "super_admin" | "user" = "super_admin") {
  const user = await createUser({ email: `admin-${crypto.randomUUID()}@test.com`, platformRole: role, password: PASSWORD });
  return createAuthHeadersForUser(String(user._id), role, user.tokenVersion);
}

async function send(handler: (request: Request) => Promise<Response>, method: string, headers: { cookie: string }, body?: unknown) {
  const res = (await callHandler(
    handler,
    new Request("http://localhost/api/admin/ai-credentials", {
      method,
      headers: { "Content-Type": "application/json", host: "localhost", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>, raw: res };
}

test("only a Super Admin can see or change keys", async () => {
  const headers = await adminHeaders("user");
  assert.equal((await send(keyGET, "GET", headers)).status, 403);
  assert.equal((await send(keyPUT, "PUT", headers, { providerId: "claude", apiKey: KEY, currentPassword: PASSWORD, reason: REASON })).status, 403);
  assert.equal(await AiProviderCredential.countDocuments(), 0);
});

test("a key needs the admin's password again, and a wrong one changes nothing", async () => {
  const headers = await adminHeaders();
  const wrong = await send(keyPUT, "PUT", headers, { providerId: "claude", apiKey: KEY, currentPassword: "not-my-password", reason: REASON });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "reauthentication_failed");
  assert.equal(await AiProviderCredential.countDocuments(), 0);
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("a saved key is stored encrypted, used by the adapter, shown only as its last four, and audited without it", async () => {
  const headers = await adminHeaders();
  const saved = await send(keyPUT, "PUT", headers, { providerId: "claude", apiKey: KEY, currentPassword: PASSWORD, reason: REASON });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes(KEY), "the answer never holds the key");
  assert.equal(saved.body.provider.source, "admin");
  assert.equal(saved.body.provider.last4, "WXYZ");

  const stored = await AiProviderCredential.findById("claude").lean();
  assert.ok(stored);
  assert.ok(!JSON.stringify(stored).includes(KEY), "only the encrypted value is in the database");

  clearAiCredentialCache();
  await loadAiCredentials();
  assert.equal(aiProviderKey("claude", "ANTHROPIC_API_KEY"), KEY, "the adapter reads the saved key");

  const listed = await send(keyGET, "GET", headers);
  assert.equal(listed.status, 200);
  assert.ok(!JSON.stringify(listed.body).includes(KEY));
  const claude = listed.body.providers.find((p: { id: string }) => p.id === "claude");
  assert.equal(claude.source, "admin");
  assert.equal(claude.last4, "WXYZ");
  assert.deepEqual(listed.body.providers.map((p: { id: string }) => p.id).sort(), ["claude", "gemini", "openai"]);

  const audit = await AdminAuditLog.find({ action: "platform.ai_credentials" }).lean();
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes(KEY), "the audit entry holds only the last four");
  assert.deepEqual(audit[0].after, { key: "…WXYZ" });
});

test("removing a key falls back to the server setting, and is audited", async () => {
  const headers = await adminHeaders();
  await send(keyPUT, "PUT", headers, { providerId: "claude", apiKey: KEY, currentPassword: PASSWORD, reason: REASON });
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment-000000000000";
  const removed = await send(keyDELETE, "DELETE", headers, { providerId: "claude", currentPassword: PASSWORD, reason: "Back to the server setting" });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);
  assert.equal(removed.body.provider.source, "environment");
  assert.equal(await AiProviderCredential.countDocuments(), 0);
  assert.equal(aiProviderKey("claude", "ANTHROPIC_API_KEY"), "sk-ant-from-the-environment-000000000000");
  assert.equal(await AdminAuditLog.countDocuments({ action: "platform.ai_credentials" }), 2);
});

test("unknown providers and malformed keys are refused", async () => {
  const headers = await adminHeaders();
  assert.equal((await send(keyPUT, "PUT", headers, { providerId: "made-up", apiKey: KEY, currentPassword: PASSWORD, reason: REASON })).status, 404);
  const pasted = await send(keyPUT, "PUT", headers, { providerId: "claude", apiKey: "sk-ant key with spaces and more text", currentPassword: PASSWORD, reason: REASON });
  assert.equal(pasted.status, 422);
  assert.ok(pasted.body.fields?.apiKey);
  assert.equal(await AiProviderCredential.countDocuments(), 0);
});
