import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import { clearRequestCookies, setRequestCookiesFromHeader } from "./helpers/mock-next-headers-setup";
import * as businessesRoute from "@/app/api/admin/businesses/route";
import * as plansRoute from "@/app/api/admin/plans/route";
import * as auditRoute from "@/app/api/admin/audit-logs/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";
import { resolveSuperAdminPageAccess } from "@/lib/auth/guards";
import { getPublicStorefront, resolveCommerceBusiness } from "@/lib/tenant";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { Business } from "@/models/Business";
import { Plan } from "@/models/Plan";
import { User } from "@/models/User";

/**
 * Super Admin routes: authorization (anonymous, ordinary user, inactive,
 * revoked, demoted), validation, safe suspend/reactivate, plan edits that
 * preserve omitted fields, and the append-only admin audit log.
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

type Headers = { cookie: string } | undefined;
const BASE = "http://localhost";

async function admin() {
  const user = await createUser({ email: `admin-${Date.now()}-${Math.random()}@test.com`, platformRole: "super_admin" });
  return { user, headers: await createAuthHeadersForUser(String(user._id), "super_admin", user.tokenVersion) };
}

async function ordinary() {
  const user = await createUser();
  return { user, headers: await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion) };
}

function req(method: string, path: string, body?: unknown, headers?: Headers) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(handler: (r: Request) => Promise<Response>, request: Request) {
  const res = (await callHandler(handler, request)) as Response;
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const listBusinesses = (h: Headers) => call(businessesRoute.GET as never, req("GET", "/api/admin/businesses", undefined, h));
const patchBusiness = (id: string, body: unknown, h: Headers) =>
  call(businessesRoute.PATCH, req("PATCH", `/api/admin/businesses?id=${id}`, body, h));
const listPlans = (h: Headers) => call(plansRoute.GET as never, req("GET", "/api/admin/plans", undefined, h));
const postPlan = (body: unknown, h: Headers) => call(plansRoute.POST, req("POST", "/api/admin/plans", body, h));
const listAudit = (h: Headers, query = "") =>
  call(auditRoute.GET, req("GET", `/api/admin/audit-logs${query}`, undefined, h));

async function publishedStore() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, { status: "active", currentPeriodEnd: null });
  const ownerHeaders = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  return { owner, business, ownerHeaders, host: `${business.subdomain}.localhost:3000` };
}

const REASON = "Reported for policy violation";

// ---------------------------------------------------------------------------
// Authorization on every admin route
// ---------------------------------------------------------------------------

test("anonymous callers get 401 on every admin route", async () => {
  const { business } = await publishedStore();
  assert.equal((await listBusinesses(undefined)).status, 401);
  assert.equal((await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, undefined)).status, 401);
  assert.equal((await listPlans(undefined)).status, 401);
  assert.equal((await postPlan({ key: "x", name: "X", price: 0 }, undefined)).status, 401);
  assert.equal((await listAudit(undefined)).status, 401);
});

test("ordinary users (including business owners) get 403 and change nothing", async () => {
  const { business, ownerHeaders } = await publishedStore();
  const { headers } = await ordinary();
  for (const h of [headers, ownerHeaders]) {
    assert.equal((await listBusinesses(h)).status, 403);
    assert.equal((await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, h)).status, 403);
    assert.equal((await listPlans(h)).status, 403);
    assert.equal((await postPlan({ key: "sneaky", name: "Sneaky", price: 0 }, h)).status, 403);
    assert.equal((await listAudit(h)).status, 403);
  }
  assert.equal((await Business.findById(business._id).lean())?.status, "published");
  assert.equal(await Plan.countDocuments({ key: "sneaky" }), 0);
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("inactive, revoked and demoted administrators are refused", async () => {
  const inactive = await createUser({ email: "inactive-admin@test.com", platformRole: "super_admin", active: false });
  const inactiveHeaders = await createAuthHeadersForUser(String(inactive._id), "super_admin", inactive.tokenVersion);
  assert.equal((await listBusinesses(inactiveHeaders)).status, 401);

  const revoked = await admin();
  await User.updateOne({ _id: revoked.user._id }, { $inc: { tokenVersion: 1 } });
  assert.equal((await listPlans(revoked.headers)).status, 401);

  // Token still claims super_admin, but the stored role was removed.
  const demoted = await admin();
  await User.updateOne({ _id: demoted.user._id }, { $set: { platformRole: "user" } });
  assert.equal((await listAudit(demoted.headers)).status, 403);
  assert.equal((await postPlan({ key: "x", name: "X", price: 0 }, demoted.headers)).status, 403);
});

// ---------------------------------------------------------------------------
// Business suspension / reactivation
// ---------------------------------------------------------------------------

test("invalid business requests are rejected without changes or audit records", async () => {
  const { headers } = await admin();
  const { business } = await publishedStore();
  const id = String(business._id);

  assert.equal((await patchBusiness(id, { status: "published" }, headers)).status, 422, "direct status writes are gone");
  assert.equal((await patchBusiness(id, { action: "suspend" }, headers)).status, 422, "reason required");
  assert.equal((await patchBusiness(id, { action: "suspend", reason: "x" }, headers)).status, 422, "reason too short");
  assert.equal((await patchBusiness(id, { action: "publish", reason: REASON }, headers)).status, 422);
  assert.equal(
    (await patchBusiness(id, { action: "suspend", reason: REASON, status: "published" }, headers)).status,
    422,
    "extra fields are rejected",
  );
  assert.equal((await call(businessesRoute.PATCH, req("PATCH", "/api/admin/businesses", { action: "suspend", reason: REASON }, headers))).status, 400);
  assert.equal((await patchBusiness("not-an-id", { action: "suspend", reason: REASON }, headers)).status, 400);
  assert.equal((await patchBusiness("507f1f77bcf86cd799439099", { action: "suspend", reason: REASON }, headers)).status, 404);

  assert.equal((await Business.findById(id).lean())?.status, "published");
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("suspension takes the storefront offline immediately and is audited", async () => {
  const { user, headers } = await admin();
  const { business, host } = await publishedStore();
  assert.ok(await getPublicStorefront(host), "storefront is live before suspension");

  const res = await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, headers);
  assert.equal(res.status, 200);
  assert.equal(res.body.business.status, "suspended");
  assert.equal(await getPublicStorefront(host), null, "storefront is offline");

  const [entry] = await AdminAuditLog.find().lean();
  assert.equal(String(entry.actor), String(user._id));
  assert.equal(entry.action, "business.suspend");
  assert.equal(entry.targetType, "business");
  assert.equal(entry.targetId, String(business._id));
  assert.equal(entry.reason, REASON);
  assert.deepEqual(entry.before, { status: "published" });
  assert.deepEqual(entry.after, { status: "suspended" });
  assert.ok(entry.createdAt instanceof Date);

  // A second suspension is refused and not audited.
  assert.equal((await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, headers)).status, 409);
  assert.equal(await AdminAuditLog.countDocuments(), 1);
});

test("a suspended owner cannot publish; reactivation returns to draft and publishing goes through the normal checks", async () => {
  const { headers } = await admin();
  const { business, ownerHeaders, host } = await publishedStore();
  const id = String(business._id);
  const publish = () =>
    call(
      ((r: Request) => publishPOST(r, { params: Promise.resolve({ id }) })) as never,
      req("POST", `/api/businesses/${id}/publish`, { publish: true }, ownerHeaders),
    );

  await patchBusiness(id, { action: "suspend", reason: REASON }, headers);
  const blocked = await publish();
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "suspended");

  // Reactivating a non-suspended business is refused.
  const other = await publishedStore();
  assert.equal((await patchBusiness(String(other.business._id), { action: "reactivate", reason: REASON }, headers)).status, 409);

  const reactivated = await patchBusiness(id, { action: "reactivate", reason: "Issue resolved by owner" }, headers);
  assert.equal(reactivated.status, 200);
  const stored = await Business.findById(id).lean();
  assert.equal(stored?.status, "draft", "never straight back to published");
  assert.equal(stored?.publishedAt, null);
  assert.equal(await getPublicStorefront(host), null, "still offline until the owner publishes");

  const republished = await publish();
  assert.equal(republished.status, 200);
  assert.equal(republished.body.status, "published");
  assert.ok(await getPublicStorefront(host));

  const actions = (await AdminAuditLog.find().sort({ _id: 1 }).lean()).map((e) => e.action);
  assert.deepEqual(actions, ["business.suspend", "business.reactivate"]);
});

test("admin actions cannot publish a business without an active subscription", async () => {
  const { headers } = await admin();
  const { owner, business } = await createBusinessWithOwner({ status: "suspended" });
  const ownerHeaders = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const id = String(business._id);

  // The old `{ status: "published" }` body is rejected outright.
  assert.equal((await patchBusiness(id, { status: "published" }, headers)).status, 422);

  // Reactivation only returns it to draft...
  assert.equal((await patchBusiness(id, { action: "reactivate", reason: REASON }, headers)).status, 200);
  // ...and the owner's publish still runs the entitlement check (no subscription).
  const publish = await call(
    ((r: Request) => publishPOST(r, { params: Promise.resolve({ id }) })) as never,
    req("POST", `/api/businesses/${id}/publish`, { publish: true }, ownerHeaders),
  );
  assert.notEqual(publish.status, 200);
  assert.equal((await Business.findById(id).lean())?.status, "draft");

  // A draft business cannot be "reactivated" (only suspended -> draft).
  assert.equal((await patchBusiness(id, { action: "reactivate", reason: REASON }, headers)).status, 409);
});

test("a suspended business takes no carts or orders and its owner cannot unpublish it", async () => {
  const { headers } = await admin();
  const { business, ownerHeaders, host } = await publishedStore();
  const id = String(business._id);
  assert.ok(await resolveCommerceBusiness(host), "commerce is open before suspension");

  await patchBusiness(id, { action: "suspend", reason: REASON }, headers);
  assert.equal(await resolveCommerceBusiness(host), null, "carts and orders are refused");

  const unpublish = await call(
    ((r: Request) => publishPOST(r, { params: Promise.resolve({ id }) })) as never,
    req("POST", `/api/businesses/${id}/publish`, { publish: false }, ownerHeaders),
  );
  assert.equal(unpublish.status, 403);
  assert.equal((await Business.findById(id).lean())?.status, "suspended");
});

test("a suspension that lands during the owner's publish is not overwritten", async () => {
  const { business, ownerHeaders } = await publishedStore();
  const id = String(business._id);
  await Business.updateOne({ _id: id }, { $set: { status: "draft" } });

  // Simulate the race: the publish route loads the business (not suspended),
  // then an admin suspends it before the route's final write.
  const originalFindById = Business.findById.bind(Business);
  const spy = mock.method(Business, "findById", async (...args: Parameters<typeof Business.findById>) => {
    const doc = await originalFindById(...args);
    // The route's early "suspended?" check sees this loaded copy, which is
    // still a draft, so only the conditional final write can stop the race.
    assert.equal(doc?.status, "draft");
    await Business.collection.updateOne({ _id: business._id }, { $set: { status: "suspended" } });
    return doc;
  });
  try {
    const res = await call(
      ((r: Request) => publishPOST(r, { params: Promise.resolve({ id }) })) as never,
      req("POST", `/api/businesses/${id}/publish`, { publish: true }, ownerHeaders),
    );
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "suspended");
    assert.equal(spy.mock.callCount(), 1, "the route loaded the business exactly once (the raced read)");
  } finally {
    spy.mock.restore();
  }
  assert.equal((await Business.findById(id).lean())?.status, "suspended", "the suspension wins");
});

test("if the audit record cannot be written, the action is rolled back", async () => {
  const { headers } = await admin();
  const { business, host } = await publishedStore();
  const spy = mock.method(AdminAuditLog, "create", async () => {
    throw new Error("audit store unavailable");
  });
  try {
    const res = await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, headers);
    assert.equal(res.status, 500);
  } finally {
    spy.mock.restore();
  }
  assert.equal((await Business.findById(business._id).lean())?.status, "published", "no unaudited suspension");
  assert.ok(await getPublicStorefront(host));
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

test("creating a plan applies documented defaults and is audited", async () => {
  const { headers } = await admin();
  const res = await postPlan({ key: "Starter", name: "Starter", price: 19 }, headers);
  assert.equal(res.status, 201);
  const plan = await Plan.findOne({ key: "starter" }).lean();
  assert.equal(plan?.currency, "USD");
  assert.equal(plan?.active, true);
  assert.equal(plan?.sort, 0);
  const [entry] = await AdminAuditLog.find().lean();
  assert.equal(entry.action, "plan.create");
  assert.equal(entry.targetId, "starter");
  assert.equal(entry.before, null);
});

test("editing a plan preserves every omitted field, including individual features", async () => {
  const { headers } = await admin();
  await Plan.create({
    key: "pro",
    name: "Pro",
    description: "For growing shops",
    price: 49,
    currency: "EUR",
    interval: "year",
    sort: 7,
    active: false,
    features: { productLimit: 500, staffLimit: 10, customDomain: true, removeBranding: true },
  });

  const res = await postPlan({ key: "pro", name: "Pro Plus", features: { staffLimit: 12 } }, headers);
  assert.equal(res.status, 200);

  const plan = await Plan.findOne({ key: "pro" }).lean();
  assert.equal(plan?.name, "Pro Plus");
  assert.equal(plan?.description, "For growing shops");
  assert.equal(plan?.price, 49);
  assert.equal(plan?.currency, "EUR", "currency is not reset to USD");
  assert.equal(plan?.interval, "year");
  assert.equal(plan?.sort, 7, "sort is not reset to 0");
  assert.equal(plan?.active, false, "a deactivated plan is not re-activated");
  assert.deepEqual(plan?.features, { productLimit: 500, staffLimit: 12, customDomain: true, removeBranding: true });

  const [entry] = await AdminAuditLog.find().lean();
  assert.equal(entry.action, "plan.update");
  assert.deepEqual(entry.before, { name: "Pro", features: { productLimit: 500, staffLimit: 10, customDomain: true, removeBranding: true } });
  assert.deepEqual(entry.after, { name: "Pro Plus", features: { productLimit: 500, staffLimit: 12, customDomain: true, removeBranding: true } });
});

test("explicit activation control is audited; no-op and invalid updates write nothing", async () => {
  const { headers } = await admin();
  await Plan.create({ key: "basic", name: "Basic", price: 0, currency: "USD", sort: 1, active: true });

  const noReason = await postPlan({ key: "basic", active: false }, headers);
  assert.equal(noReason.status, 422, "deactivation needs a reason");
  assert.equal(noReason.body.code, "reason_required");
  assert.equal((await Plan.findOne({ key: "basic" }).lean())?.active, true);

  const deactivated = await postPlan({ key: "basic", active: false, reason: "Retiring the free tier" }, headers);
  assert.equal(deactivated.status, 200);
  assert.equal((await Plan.findOne({ key: "basic" }).lean())?.active, false);
  const activated = await postPlan({ key: "basic", active: true }, headers);
  assert.equal(activated.status, 200);

  const noop = await postPlan({ key: "basic", name: "Basic" }, headers);
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);

  assert.equal((await postPlan({ key: "basic", price: -5 }, headers)).status, 422);
  assert.equal((await postPlan({ key: "basic", currency: "EURO" }, headers)).status, 422);
  assert.equal((await postPlan({ name: "No key" }, headers)).status, 422);
  assert.equal((await postPlan({ key: "brand-new", price: 5 }, headers)).status, 422, "create needs a name");

  const entries = await AdminAuditLog.find().sort({ _id: 1 }).lean();
  assert.deepEqual(entries.map((e) => e.action), ["plan.deactivate", "plan.activate"]);
  assert.equal(entries[0].reason, "Retiring the free tier");
  assert.equal(await Plan.countDocuments({ key: "brand-new" }), 0);
});

test("explicit create/update intent: create never overwrites, update never creates", async () => {
  const { headers } = await admin();
  await Plan.create({ key: "gold", name: "Gold", price: 99, currency: "GBP", sort: 3 });

  const clash = await postPlan({ mode: "create", key: "gold", name: "Overwritten", price: 1 }, headers);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, "plan_exists");
  const stored = await Plan.findOne({ key: "gold" }).lean();
  assert.equal(stored?.name, "Gold");
  assert.equal(stored?.price, 99);

  assert.equal((await postPlan({ mode: "update", key: "ghost", name: "Ghost" }, headers)).status, 404);
  assert.equal(await Plan.countDocuments({ key: "ghost" }), 0);
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("blank or null numbers never zero a plan; no-op updates do not write", async () => {
  const { headers } = await admin();
  await Plan.create({
    key: "paid",
    name: "Paid",
    price: 25,
    features: { productLimit: 50, staffLimit: 3, customDomain: false, removeBranding: false },
  });
  const beforeDoc = await Plan.findOne({ key: "paid" }).lean();

  const res = await postPlan(
    { mode: "update", key: "paid", price: null, sort: "", features: { productLimit: "", staffLimit: null } },
    headers,
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, false);
  const afterDoc = await Plan.findOne({ key: "paid" }).lean();
  assert.equal(afterDoc?.price, 25, "a cleared price does not make the plan free");
  assert.equal(afterDoc?.features.productLimit, 50);
  assert.equal(afterDoc?.features.staffLimit, 3);
  assert.equal(
    (afterDoc as { updatedAt?: Date }).updatedAt?.getTime(),
    (beforeDoc as { updatedAt?: Date }).updatedAt?.getTime(),
    "a no-op does not touch the document",
  );

  assert.equal((await postPlan({ mode: "create", key: "blank", name: "Blank", price: "" }, headers)).status, 422);
  assert.equal(await AdminAuditLog.countDocuments(), 0);
});

test("concurrent creates of the same key produce one plan and one audit record", async () => {
  const { headers } = await admin();
  const results = await Promise.all([
    postPlan({ key: "race", name: "Race A", price: 1 }, headers),
    postPlan({ key: "race", name: "Race B", price: 2 }, headers),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes(201), `one create succeeds (got ${statuses.join(",")})`);
  assert.equal(await Plan.countDocuments({ key: "race" }), 1);
  assert.equal(await AdminAuditLog.countDocuments({ action: "plan.create", targetId: "race" }), 1);
});

test("a legacy plan document without features can still be edited", async () => {
  const { headers } = await admin();
  await Plan.collection.insertOne({ key: "legacy", name: "Legacy", price: 5, active: true });
  const res = await postPlan({ mode: "update", key: "legacy", name: "Legacy renamed" }, headers);
  assert.equal(res.status, 200);
  assert.equal((await Plan.findOne({ key: "legacy" }).lean())?.name, "Legacy renamed");
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

test("the audit log is readable by admins only, newest first, paginated, without sensitive data", async () => {
  const { headers } = await admin();
  for (let i = 0; i < 3; i += 1) {
    const { business } = await publishedStore();
    await patchBusiness(String(business._id), { action: "suspend", reason: `${REASON} #${i}` }, headers);
  }

  const page1 = await listAudit(headers, "?page=1&limit=2");
  assert.equal(page1.status, 200);
  assert.equal(page1.body.total, 3);
  assert.equal(page1.body.entries.length, 2);
  assert.equal(page1.body.entries[0].reason, `${REASON} #2`, "newest first");
  const page2 = await listAudit(headers, "?page=2&limit=2");
  assert.equal(page2.body.entries.length, 1);
  assert.equal((await listAudit(headers, "?limit=1000")).status, 422);

  const serialized = JSON.stringify(page1.body);
  for (const forbidden of ["passwordHash", "tokenVersion", "email", "@test.com"]) {
    assert.equal(serialized.includes(forbidden), false, `audit output must not contain ${forbidden}`);
  }
});

test("audit records have no write API and cannot be modified through the model", async () => {
  assert.equal("POST" in auditRoute, false);
  assert.equal("PATCH" in auditRoute, false);
  assert.equal("DELETE" in auditRoute, false);

  const { headers } = await admin();
  const { business } = await publishedStore();
  await patchBusiness(String(business._id), { action: "suspend", reason: REASON }, headers);

  await assert.rejects(() => AdminAuditLog.updateOne({}, { $set: { reason: "rewritten" } }).exec(), /append-only/);
  await assert.rejects(() => AdminAuditLog.deleteMany({}).exec(), /append-only/);
  const loaded = await AdminAuditLog.findOne();
  assert.ok(loaded);
  loaded.set("targetLabel", "tampered");
  await assert.rejects(() => loaded.save(), /append-only/);
  await assert.rejects(() => loaded.deleteOne(), /append-only/);
  assert.equal((await AdminAuditLog.findOne().lean())?.reason, REASON);
});

// ---------------------------------------------------------------------------
// Admin page access
// ---------------------------------------------------------------------------

test("admin page access: login for missing/revoked/inactive sessions, dashboard for non-admins", async () => {
  clearRequestCookies();
  assert.deepEqual(await resolveSuperAdminPageAccess(), { kind: "login" });

  const { headers: userHeaders } = await ordinary();
  setRequestCookiesFromHeader(userHeaders!.cookie);
  assert.deepEqual(await resolveSuperAdminPageAccess(), { kind: "forbidden" });

  const revoked = await admin();
  await User.updateOne({ _id: revoked.user._id }, { $inc: { tokenVersion: 1 } });
  setRequestCookiesFromHeader(revoked.headers!.cookie);
  assert.deepEqual(await resolveSuperAdminPageAccess(), { kind: "login" });

  const inactive = await admin();
  await User.updateOne({ _id: inactive.user._id }, { $set: { active: false } });
  setRequestCookiesFromHeader(inactive.headers!.cookie);
  assert.deepEqual(await resolveSuperAdminPageAccess(), { kind: "login" });

  // Token still says super_admin, but the stored role was removed.
  const demoted = await admin();
  await User.updateOne({ _id: demoted.user._id }, { $set: { platformRole: "user" } });
  setRequestCookiesFromHeader(demoted.headers!.cookie);
  assert.deepEqual(await resolveSuperAdminPageAccess(), { kind: "forbidden" });

  const ok = await admin();
  setRequestCookiesFromHeader(ok.headers!.cookie);
  const access = await resolveSuperAdminPageAccess();
  assert.equal(access.kind, "allowed");
  clearRequestCookies();
});
