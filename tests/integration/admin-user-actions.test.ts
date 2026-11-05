import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { PATCH as userPATCH } from "@/app/api/admin/users/[id]/route";
import { GET as overviewGET } from "@/app/api/admin/overview/route";
import { GET as meGET } from "@/app/api/auth/me/route";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { Membership } from "@/models/Membership";
import { User } from "@/models/User";
import { HttpError } from "@/lib/api";
import { applyUserAdminAction } from "@/lib/admin/user-actions";

/**
 * Super Admin user management: authorization, validation, session
 * revocation, lock-out protection, concurrency and auditing.
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
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

const PASSWORD = "admin-password-1";
const REASON = "Security review ticket 42";

async function admin(name = "Admin") {
  const user = await createUser({ email: `admin-${crypto.randomUUID()}@test.com`, name, platformRole: "super_admin", password: PASSWORD });
  return { user, headers: await headersFor(user) };
}

async function headersFor(user: { _id: unknown }) {
  const fresh = await User.findById(user._id).lean();
  return createAuthHeadersForUser(String(user._id), fresh!.platformRole, fresh!.tokenVersion);
}

async function act(headers: { cookie: string } | undefined, targetId: string, body: unknown, origin?: string) {
  const res = (await callHandler(
    userPATCH,
    new Request(`http://localhost/api/admin/users/${targetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", host: "localhost", ...(origin ? { origin } : {}), ...(headers ?? {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: targetId }) },
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function canUseSession(headers: { cookie: string }) {
  const res = (await callHandler(meGET as never, new Request("http://localhost/api/auth/me", { headers }))) as Response;
  return res.status === 200;
}

test("only super admins can manage accounts; business owners cannot escalate", async () => {
  const { owner } = await createBusinessWithOwner();
  const ownerHeaders = await headersFor(owner);
  const target = await createUser();
  const body = { action: "deactivate", reason: REASON };
  assert.equal((await act(undefined, String(target._id), body)).status, 401);
  assert.equal((await act(ownerHeaders, String(target._id), body)).status, 403);
  // Self-promotion by a business owner is refused.
  const self = await act(ownerHeaders, String(owner._id), { action: "grant_super_admin", reason: REASON, currentPassword: "password123" });
  assert.equal(self.status, 403);
  assert.equal((await User.findById(owner._id).lean())?.platformRole, "user");
  assert.equal((await User.findById(target._id).lean())?.active, true);
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("input is validated strictly", async () => {
  const { headers } = await admin();
  const target = await createUser();
  const id = String(target._id);
  assert.equal((await act(headers, id, { action: "delete", reason: REASON })).status, 422);
  assert.equal((await act(headers, id, { action: "deactivate", reason: "no" })).status, 422);
  assert.equal((await act(headers, id, { action: "deactivate", reason: REASON, platformRole: "super_admin" })).status, 422, "unknown keys");
  assert.equal((await act(headers, "not-an-id", { action: "deactivate", reason: REASON })).status, 404);
  assert.equal((await act(headers, String(new mongoose.Types.ObjectId()), { action: "deactivate", reason: REASON })).status, 404);
  assert.equal((await act(headers, id, { action: "deactivate", reason: REASON }, "https://evil.example")).status, 403);
  assert.equal((await User.findById(id).lean())?.active, true);
});

test("deactivation ends every session and blocks sign-in; reactivation restores access; memberships untouched", async () => {
  const { headers, user: actor } = await admin();
  const { owner, business } = await createBusinessWithOwner();
  const ownerHeaders = await headersFor(owner);
  assert.equal(await canUseSession(ownerHeaders), true);

  const res = await act(headers, String(owner._id), { action: "deactivate", reason: REASON });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { id: String(owner._id), name: owner.name, email: owner.email, platformRole: "user", active: false });
  assert.equal(await canUseSession(ownerHeaders), false, "existing session revoked");
  assert.equal((await act(headers, String(owner._id), { action: "deactivate", reason: REASON })).body.code, "already_inactive");
  assert.equal((await act(headers, String(owner._id), { action: "force_signout", reason: REASON })).status, 409);

  assert.equal((await act(headers, String(owner._id), { action: "reactivate", reason: REASON })).status, 200);
  assert.equal(await canUseSession(ownerHeaders), false, "old session stays revoked after reactivation");
  assert.equal(await canUseSession(await headersFor(owner)), true, "a new sign-in works");
  const membership = await Membership.findOne({ business: business._id, user: owner._id }).lean();
  assert.equal(membership?.role, "owner");
  assert.equal(membership?.status, "active");

  const audit = await AdminAuditLog.find({ targetId: String(owner._id) }).sort({ _id: 1 }).lean();
  assert.deepEqual(audit.map((a) => a.action), ["user.deactivate", "user.reactivate"]);
  assert.equal(String(audit[0].actor), String(actor._id));
  assert.equal(audit[0].reason, REASON);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes(owner.email) && !text.includes("passwordHash") && !text.includes(PASSWORD));
});

test("forced sign-out revokes sessions but keeps the account active", async () => {
  const { headers } = await admin();
  const target = await createUser();
  const targetHeaders = await headersFor(target);
  assert.equal((await act(headers, String(target._id), { action: "force_signout", reason: REASON })).status, 200);
  assert.equal(await canUseSession(targetHeaders), false);
  assert.equal((await User.findById(target._id).lean())?.active, true);
});

test("role changes need the acting admin's password, revoke sessions, and never touch business roles", async () => {
  const { headers } = await admin();
  const { owner } = await createBusinessWithOwner();
  const ownerHeaders = await headersFor(owner);
  const id = String(owner._id);

  assert.equal((await act(headers, id, { action: "grant_super_admin", reason: REASON })).body.code, "reauthentication_required");
  const wrong = await act(headers, id, { action: "grant_super_admin", reason: REASON, currentPassword: "nope" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "reauthentication_failed");
  assert.equal((await User.findById(id).lean())?.platformRole, "user");

  const granted = await act(headers, id, { action: "grant_super_admin", reason: REASON, currentPassword: PASSWORD });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.user.platformRole, "super_admin");
  assert.equal(await canUseSession(ownerHeaders), false, "re-sign-in required after a role change");
  assert.equal((await callHandler(overviewGET as never, new Request("http://localhost/api/admin/overview", { headers: { ...(await headersFor(owner)) } })) as Response).status, 200);
  assert.equal((await Membership.findOne({ user: owner._id }).lean())?.role, "owner");

  assert.equal((await act(headers, id, { action: "grant_super_admin", reason: REASON, currentPassword: PASSWORD })).body.code, "not_promotable");
  assert.equal((await act(headers, id, { action: "revoke_super_admin", reason: REASON, currentPassword: PASSWORD })).status, 200);
  assert.equal((await User.findById(id).lean())?.platformRole, "user");
  const inactive = await createUser({ active: false });
  assert.equal((await act(headers, String(inactive._id), { action: "grant_super_admin", reason: REASON, currentPassword: PASSWORD })).body.code, "not_promotable");
});

test("admins cannot act on themselves and the last active super admin cannot be removed", async () => {
  const a = await admin("A");
  for (const action of ["deactivate", "revoke_super_admin", "force_signout"]) {
    const res = await act(a.headers, String(a.user._id), { action, reason: REASON, currentPassword: PASSWORD });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "self_action");
  }
  const b = await admin("B");
  // A deactivated admin does not count as remaining access.
  await User.updateOne({ _id: b.user._id }, { $set: { active: false } });
  const res = await act(a.headers, String(b.user._id), { action: "revoke_super_admin", reason: REASON, currentPassword: PASSWORD });
  assert.equal(res.status, 200, "revoking an already inactive admin is allowed while A remains");

  const c = await admin("C");
  // C demotes A: allowed because C remains.
  assert.equal((await act(c.headers, String(a.user._id), { action: "revoke_super_admin", reason: REASON, currentPassword: PASSWORD })).status, 200);
  assert.equal(await User.countDocuments({ platformRole: "super_admin", active: true }), 1);
});

test("two admins demoting or deactivating each other at the same time leave at least one admin", async () => {
  // Called at the service layer: the route-level cookie mock is process-global,
  // so concurrent route calls could mix sessions and hide the real behaviour.
  for (const action of ["revoke_super_admin", "deactivate"] as const) {
    for (let round = 0; round < 3; round++) {
      await clearAllCollections();
      const a = await admin("A");
      const b = await admin("B");
      const results = await Promise.allSettled([
        applyUserAdminAction({ actorId: String(a.user._id), targetId: String(b.user._id), action, reason: REASON }),
        applyUserAdminAction({ actorId: String(b.user._id), targetId: String(a.user._id), action, reason: REASON }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assert.equal(fulfilled.length, 1, `${action}: exactly one change applies`);
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof HttpError);
      assert.equal((rejected[0].reason as HttpError).code, "last_super_admin");
      assert.equal(await User.countDocuments({ platformRole: "super_admin", active: true }), 1);
      assert.equal(await AdminAuditLog.countDocuments({ action: `user.${action}` }), 1, "only the applied change is audited");
    }
  }
});
