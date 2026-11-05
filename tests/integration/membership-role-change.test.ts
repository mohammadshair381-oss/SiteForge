import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { Business, Membership } from "@/models";
import type { UserDoc } from "@/models/User";
import { Types } from "mongoose";

// Static imports of the real membership route handlers. The [id]/[memberId]
// path segments resolve through Next.js module resolution at compile time.
import { PATCH as membersPATCH } from "@/app/api/businesses/[id]/members/[memberId]/route";
import { DELETE as membersDELETE } from "@/app/api/businesses/[id]/members/[memberId]/route";

const WEBHOOK_SECRET = "integration-test-webhook-secret-0123456789abcdef";
process.env.PAYMENT_WEBHOOK_SECRET = WEBHOOK_SECRET;

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (
    !uri.startsWith("mongodb://127.0.0.1:")
    && !uri.startsWith("mongodb://localhost:")
  ) {
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
});

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

/**
 * The membership route treats `memberId` as the *Membership* document id
 * (see `Membership.findOne({ _id: memberId, business: id })` and
 * `MembersManager.tsx`, which links to `member._id`). The fixtures therefore
 * capture the created Membership documents, not just the users.
 */
async function createBusinessWithOwner() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const owner = await createUser();
  const business = await Business.create({
    name: `TestBiz-${suffix}`,
    slug: `testbiz-${suffix}`,
    subdomain: `testbiz-${suffix}`,
    category: "services",
    owner,
  });
  const ownerMembership = await Membership.create({
    business,
    user: owner,
    role: "owner",
    status: "active",
  });
  return { owner, business, ownerMembership };
}

async function createBusinessWithOwnerAndStaff() {
  const base = await createBusinessWithOwner();
  const staff = await createUser();
  const staffMembership = await Membership.create({
    business: base.business,
    user: staff,
    role: "staff",
    status: "active",
  });
  return { ...base, staff, staffMembership };
}

async function createBusinessWithTwoOwners() {
  const base = await createBusinessWithOwner();
  const owner2 = await createUser();
  const owner2Membership = await Membership.create({
    business: base.business,
    user: owner2,
    role: "owner",
    status: "active",
  });
  return { ...base, owner2, owner2Membership };
}

/** Signs a session cookie whose tokenVersion matches the persisted user. */
async function authFor(user: UserDoc) {
  return createAuthHeadersForUser(user._id.toString(), "user", user.tokenVersion);
}

function memberRequest(
  businessId: string,
  memberId: string,
  method: "PATCH" | "DELETE",
  cookie: string,
  body?: unknown,
): Request {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", cookie },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(
    `http://localhost/api/businesses/${businessId}/members/${memberId}`,
    init,
  );
}

function memberContext(businessId: string, memberId: string) {
  return { params: Promise.resolve({ id: businessId, memberId }) };
}

interface ApiResponseBody {
  error?: string;
  code?: string;
  membership?: { role?: string; status?: string };
  removed?: boolean;
}

async function apiBody(res: Response): Promise<ApiResponseBody> {
  return (await res.json()) as ApiResponseBody;
}

async function activeOwnerCount(businessId: Types.ObjectId): Promise<number> {
  return Membership.countDocuments({
    business: businessId,
    role: "owner",
    status: "active",
  });
}

// -------------------------------------------------------
// Primary owner protection
// -------------------------------------------------------

test("primary owner cannot be demoted", async () => {
  const { business, ownerMembership, owner2 } = await createBusinessWithTwoOwners();

  const auth = await authFor(owner2);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      ownerMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "staff" },
    ),
    memberContext(business._id.toString(), ownerMembership._id.toString()),
  );

  assert.equal(res.status, 409);
  assert.equal((await apiBody(res)).code, "primary_owner");

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
  assert.equal(unchanged.status, "active");
});

test("primary owner cannot be removed", async () => {
  const { business, ownerMembership, owner2 } = await createBusinessWithTwoOwners();

  const auth = await authFor(owner2);
  const res = await callHandler(
    membersDELETE,
    memberRequest(
      business._id.toString(),
      ownerMembership._id.toString(),
      "DELETE",
      auth.cookie,
    ),
    memberContext(business._id.toString(), ownerMembership._id.toString()),
  );

  assert.equal(res.status, 409);
  assert.equal((await apiBody(res)).code, "primary_owner");

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
  assert.equal(unchanged.status, "active");
});

// -------------------------------------------------------
// Self-protection
// -------------------------------------------------------

test("owner cannot change their own membership role", async () => {
  const { owner, business, ownerMembership } = await createBusinessWithOwner();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      ownerMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "staff" },
    ),
    memberContext(business._id.toString(), ownerMembership._id.toString()),
  );

  assert.equal(res.status, 400);
  assert.equal((await apiBody(res)).code, "cannot_modify_self");

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
});

test("owner cannot remove their own membership", async () => {
  const { owner, business, ownerMembership } = await createBusinessWithOwner();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersDELETE,
    memberRequest(
      business._id.toString(),
      ownerMembership._id.toString(),
      "DELETE",
      auth.cookie,
    ),
    memberContext(business._id.toString(), ownerMembership._id.toString()),
  );

  assert.equal(res.status, 400);
  assert.equal((await apiBody(res)).code, "cannot_modify_self");

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.status, "active");
});

// -------------------------------------------------------
// Missing / malformed memberships
// -------------------------------------------------------

test("missing membership on PATCH returns 404", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const missingId = new Types.ObjectId().toString();

  const auth = await authFor(owner);
  const req = new Request(
    `http://localhost/api/businesses/${business._id}/members/${missingId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: auth.cookie },
      body: JSON.stringify({ role: "staff" }),
    },
  );
  const res = await callHandler(
    membersPATCH,
    req,
    memberContext(business._id.toString(), missingId),
  );

  assert.equal(res.status, 404);
  assert.equal((await apiBody(res)).code, "not_found");
});

test("missing membership on DELETE returns 404", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const missingId = new Types.ObjectId().toString();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersDELETE,
    memberRequest(
      business._id.toString(),
      missingId,
      "DELETE",
      auth.cookie,
    ),
    memberContext(business._id.toString(), missingId),
  );

  assert.equal(res.status, 404);
  assert.equal((await apiBody(res)).code, "not_found");
});

test("malformed member id is rejected with 400", async () => {
  const { owner, business } = await createBusinessWithOwner();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(business._id.toString(), "not-an-object-id", "PATCH", auth.cookie, {
      role: "staff",
    }),
    memberContext(business._id.toString(), "not-an-object-id"),
  );

  assert.equal(res.status, 400);
  assert.equal((await apiBody(res)).code, "invalid_id");
});

// -------------------------------------------------------
// Validation
// -------------------------------------------------------

test("invalid role in PATCH body is rejected", async () => {
  const { owner, business, staffMembership } = await createBusinessWithOwnerAndStaff();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      staffMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "admin" },
    ),
    memberContext(business._id.toString(), staffMembership._id.toString()),
  );

  assert.equal(res.status, 422);

  const unchanged = await Membership.findById(staffMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "staff");
});

test("malformed JSON body is rejected", async () => {
  const { owner, business, staffMembership } = await createBusinessWithOwnerAndStaff();

  const auth = await authFor(owner);
  const req = new Request(
    `http://localhost/api/businesses/${business._id}/members/${staffMembership._id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: auth.cookie },
      body: "not valid json",
    },
  );
  const res = await callHandler(
    membersPATCH,
    req,
    memberContext(business._id.toString(), staffMembership._id.toString()),
  );

  assert.equal(res.status, 400);
  assert.equal((await apiBody(res)).code, "invalid_json");
});

// -------------------------------------------------------
// Successful mutations
// -------------------------------------------------------

test("owner successfully promotes a staff member to owner", async () => {
  const { owner, business, staffMembership } = await createBusinessWithOwnerAndStaff();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      staffMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "owner" },
    ),
    memberContext(business._id.toString(), staffMembership._id.toString()),
  );

  assert.equal(res.status, 200);
  assert.equal((await apiBody(res)).membership?.role, "owner");

  const updated = await Membership.findById(staffMembership._id);
  assert.ok(updated);
  assert.equal(updated.role, "owner");
  assert.equal(await activeOwnerCount(business._id), 2);
});

test("owner successfully demotes a non-primary owner leaving one active owner", async () => {
  const { owner, business, owner2Membership } = await createBusinessWithTwoOwners();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      owner2Membership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "staff" },
    ),
    memberContext(business._id.toString(), owner2Membership._id.toString()),
  );

  assert.equal(res.status, 200);

  const updated = await Membership.findById(owner2Membership._id);
  assert.ok(updated);
  assert.equal(updated.role, "staff");
  assert.equal(await activeOwnerCount(business._id), 1);
});

test("owner successfully removes a staff member", async () => {
  const { owner, business, staffMembership } = await createBusinessWithOwnerAndStaff();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersDELETE,
    memberRequest(
      business._id.toString(),
      staffMembership._id.toString(),
      "DELETE",
      auth.cookie,
    ),
    memberContext(business._id.toString(), staffMembership._id.toString()),
  );

  assert.equal(res.status, 200);
  const body = await apiBody(res);
  assert.equal(body.removed, true);

  const removed = await Membership.findById(staffMembership._id);
  assert.equal(removed, null);
});

// -------------------------------------------------------
// Authorization: non-owner and cross-business
// -------------------------------------------------------

test("non-owner role change is rejected", async () => {
  const { ownerMembership, business, staff } = await createBusinessWithOwnerAndStaff();

  const auth = await authFor(staff);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      ownerMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "staff" },
    ),
    memberContext(business._id.toString(), ownerMembership._id.toString()),
  );

  assert.equal(res.status, 403);
  assert.equal((await apiBody(res)).code, "forbidden");

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
});

test("user with no membership is rejected", async () => {
  const { business, staffMembership } = await createBusinessWithOwnerAndStaff();
  const outsider = await createUser();

  const auth = await authFor(outsider);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      business._id.toString(),
      staffMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "owner" },
    ),
    memberContext(business._id.toString(), staffMembership._id.toString()),
  );

  assert.equal(res.status, 403);
  assert.equal((await apiBody(res)).code, "forbidden");

  const unchanged = await Membership.findById(staffMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "staff");
});

test("cross-business membership modification is rejected", async () => {
  const first = await createBusinessWithTwoOwners();
  const second = await createBusinessWithOwner();

  // The owner of the first business targets the second business in the path.
  const auth = await authFor(first.owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(
      second.business._id.toString(),
      second.ownerMembership._id.toString(),
      "PATCH",
      auth.cookie,
      { role: "staff" },
    ),
    memberContext(
      second.business._id.toString(),
      second.ownerMembership._id.toString(),
    ),
  );

  assert.equal(res.status, 403);
  assert.equal((await apiBody(res)).code, "forbidden");

  const unchanged = await Membership.findById(second.ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
});

// -------------------------------------------------------
// Failed operations leave state unchanged
// -------------------------------------------------------

test("failed PATCH leaves membership and business records unchanged", async () => {
  const { owner, business, ownerMembership } = await createBusinessWithOwner();
  const missingId = new Types.ObjectId().toString();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersPATCH,
    memberRequest(business._id.toString(), missingId, "PATCH", auth.cookie, {
      role: "staff",
    }),
    memberContext(business._id.toString(), missingId),
  );

  assert.equal(res.status, 404);

  const ownerMem = await Membership.findById(ownerMembership._id);
  assert.ok(ownerMem);
  assert.equal(ownerMem.role, "owner");
  assert.equal(ownerMem.status, "active");

  const biz = await Business.findById(business._id);
  assert.ok(biz);
});

test("failed DELETE leaves membership and business records unchanged", async () => {
  const { owner, business, ownerMembership } = await createBusinessWithOwner();
  const missingId = new Types.ObjectId().toString();

  const auth = await authFor(owner);
  const res = await callHandler(
    membersDELETE,
    memberRequest(business._id.toString(), missingId, "DELETE", auth.cookie),
    memberContext(business._id.toString(), missingId),
  );

  assert.equal(res.status, 404);

  const unchanged = await Membership.findById(ownerMembership._id);
  assert.ok(unchanged);
  assert.equal(unchanged.role, "owner");
  assert.equal(unchanged.status, "active");

  const biz = await Business.findById(business._id);
  assert.ok(biz);
});
