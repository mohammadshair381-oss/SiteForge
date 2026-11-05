import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser, makeAuthenticatedRequest } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { createUser } from "./helpers/fixtures";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import * as plansRoute from "@/app/api/admin/plans/route";
import { getEntitlements, getThemeAccess } from "@/lib/billing";
import { THEME_IDS, type ThemeId } from "@/lib/constants";
import { FREE_THEMES, STARTER_THEMES } from "@/lib/theme-tiers";
import { AdminAuditLog } from "@/models/AdminAuditLog";
import { Business } from "@/models/Business";
import { Plan } from "@/models/Plan";

/**
 * Plan-based theme access (lib/theme-tiers.ts + lib/billing.ts): Free 3,
 * Starter 6, Max/Pro all 9; explicit plan lists from the Super Admin plan
 * manager; enforcement on every route that writes `themeId`; a store keeps its
 * current theme after a downgrade (no silent change).
 */

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
});

type Actor = { _id: unknown; tokenVersion: number };

async function patchBusiness(businessId: string, actor: Actor, body: unknown) {
  const headers = await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion);
  const res = (await callHandler(
    businessPATCH as never,
    new Request(`http://localhost/api/businesses/${businessId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: businessId }) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** The three seeded tiers (no explicit theme lists: defaults by key). */
async function seedTiers() {
  const free = await Plan.create({ key: "free", name: "Free", price: 0, currency: "USD", sort: 0, features: { productLimit: 10, staffLimit: 1 } });
  const starter = await Plan.create({ key: "starter", name: "Starter", price: 19, currency: "USD", sort: 1, features: { productLimit: 100, staffLimit: 3 } });
  const pro = await Plan.create({ key: "pro", name: "Pro", price: 49, currency: "USD", sort: 2, features: { productLimit: 1000, staffLimit: 10 } });
  return { free, starter, pro };
}

async function storeOn(planId: unknown, themeId: ThemeId = "bistro") {
  const ctx = await createBusinessWithOwner();
  await Business.updateOne({ _id: ctx.business._id }, { $set: { themeId } });
  await createSubscription(ctx.business._id, planId as never, { status: "active", currentPeriodEnd: null });
  return { ...ctx, id: String(ctx.business._id) };
}

const storedTheme = async (id: string) => (await Business.findById(id).lean())?.themeId;

test("Free plan: the three Free themes can be selected; every other theme is refused with upgrade information", async () => {
  const { free } = await seedTiers();
  const { owner, id } = await storeOn(free._id);
  for (const themeId of FREE_THEMES) {
    const res = await patchBusiness(id, owner, { themeId });
    assert.equal(res.status, 200, `${themeId}: ${JSON.stringify(res.body)}`);
    assert.equal(await storedTheme(id), themeId);
  }
  const refused = await patchBusiness(id, owner, { themeId: "aurora" });
  assert.equal(refused.status, 402);
  assert.equal(refused.body.code, "theme_not_in_plan");
  assert.match(refused.body.error, /Aurora theme is available on the Starter plan/);
  const max = await patchBusiness(id, owner, { themeId: "volt" });
  assert.equal(max.status, 402);
  assert.match(max.body.error, /Volt theme is available on the Pro plan/);
  assert.equal(await storedTheme(id), "studio", "a refused change leaves the theme as it was");
});

test("Starter plan: six themes; Atelier, Volt and Forma are refused", async () => {
  const { starter } = await seedTiers();
  const { owner, id } = await storeOn(starter._id);
  for (const themeId of STARTER_THEMES) assert.equal((await patchBusiness(id, owner, { themeId })).status, 200, themeId);
  for (const themeId of ["atelier", "volt", "forma"] as const) {
    const res = await patchBusiness(id, owner, { themeId });
    assert.equal(res.status, 402, themeId);
    assert.equal(res.body.code, "theme_not_in_plan");
  }
  assert.equal(await storedTheme(id), "harvest");
});

test("Max (Pro) plan: all nine themes; managers may switch, staff may not", async () => {
  const { pro } = await seedTiers();
  const { owner, business, id } = await storeOn(pro._id);
  for (const themeId of THEME_IDS) assert.equal((await patchBusiness(id, owner, { themeId })).status, 200, themeId);
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  assert.equal((await patchBusiness(id, manager, { themeId: "atelier" })).status, 200);
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await patchBusiness(id, staff, { themeId: "bistro" })).status, 403);
  assert.equal(await storedTheme(id), "atelier");
});

test("an explicit plan list from the plan manager overrides the default tier", async () => {
  const plan = await createPlan({ key: "free", price: 0, themes: ["volt", "bistro"] });
  const { owner, id } = await storeOn(plan._id);
  assert.deepEqual((await getEntitlements(id)).themes, ["bistro", "volt"]);
  assert.equal((await patchBusiness(id, owner, { themeId: "volt" })).status, 200);
  assert.equal((await patchBusiness(id, owner, { themeId: "market" })).status, 402, "not in the explicit list");
});

test("downgrade: the current theme is kept (grandfathered) and other edits still work; switching away is final", async () => {
  const { free } = await seedTiers();
  const { owner, id } = await storeOn(free._id, "forma");
  const access = await getThemeAccess(id);
  assert.equal(access.current, "forma");
  assert.equal(access.grandfathered, true);
  assert.deepEqual(access.allowed, [...FREE_THEMES]);

  // Nothing changes the theme silently: other settings save, the theme stays.
  assert.equal((await patchBusiness(id, owner, { name: "Renamed store" })).status, 200);
  assert.equal(await storedTheme(id), "forma");
  // Re-saving the current theme is allowed (e.g. a form that sends every field).
  assert.equal((await patchBusiness(id, owner, { themeId: "forma" })).status, 200);
  // Moving to an included theme works; moving back needs the plan.
  assert.equal((await patchBusiness(id, owner, { themeId: "market" })).status, 200);
  assert.equal((await patchBusiness(id, owner, { themeId: "forma" })).status, 402);
  assert.equal((await getThemeAccess(id)).grandfathered, false);
});

test("no plan, an expired or a cancelled subscription: Free themes only", async () => {
  await seedTiers();
  const { owner, business } = await createBusinessWithOwner();
  const id = String(business._id);
  await Business.updateOne({ _id: id }, { $set: { themeId: "market" } });
  assert.deepEqual((await getEntitlements(id)).themes, [...FREE_THEMES]);
  assert.equal((await patchBusiness(id, owner, { themeId: "aurora" })).status, 402);

  const pro = await Plan.findOne({ key: "pro" });
  const expired = await createBusinessWithOwner();
  await createSubscription(expired.business._id, pro!._id, { status: "active", currentPeriodEnd: new Date(Date.now() - 86_400_000) });
  assert.deepEqual((await getEntitlements(String(expired.business._id))).themes, [...FREE_THEMES]);
  assert.equal((await patchBusiness(String(expired.business._id), expired.owner, { themeId: "volt" })).status, 402);
});

test("getThemeAccess names the cheapest active plan for each theme", async () => {
  const { free } = await seedTiers();
  const { id } = await storeOn(free._id);
  const access = await getThemeAccess(id);
  assert.equal(access.planName, "Free");
  assert.equal(access.requiredPlan.bistro?.key, "free");
  assert.equal(access.requiredPlan.aurora?.key, "starter");
  assert.equal(access.requiredPlan.forma?.key, "pro");
  // An inactive plan is never offered as the upgrade.
  await Plan.updateOne({ key: "starter" }, { $set: { active: false } });
  assert.equal((await getThemeAccess(id)).requiredPlan.aurora?.key, "pro");
});

test("one business's plan never unlocks themes for another; other businesses cannot change the theme", async () => {
  const { free, pro } = await seedTiers();
  const rich = await storeOn(pro._id);
  const poor = await storeOn(free._id);
  assert.equal((await patchBusiness(poor.id, poor.owner, { themeId: "volt" })).status, 402);
  // The Pro owner is not a member of the Free store.
  const crossed = await patchBusiness(poor.id, rich.owner, { themeId: "volt" });
  assert.ok(crossed.status === 403 || crossed.status === 404, `status ${crossed.status}`);
  assert.equal(await storedTheme(poor.id), "bistro");
});

test("business creation: the default theme is one the free plan includes, and a locked theme is refused", async () => {
  await seedTiers();
  const user = await createUser();
  const headers = await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion);
  const create = async (body: Record<string, unknown>) => {
    const res = (await callHandler(businessesPOST, makeAuthenticatedRequest("http://localhost/api/businesses", body, headers))) as Response;
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  const locked = await create({ name: "Volt Shop", category: "electronics", subdomain: "volt-shop", themeId: "volt" });
  assert.equal(locked.status, 402);
  assert.equal(locked.body.code, "theme_not_in_plan");
  assert.equal(await Business.countDocuments({ subdomain: "volt-shop" }), 0, "nothing is created");

  const electronics = await create({ name: "Gadget Shop", category: "electronics", subdomain: "gadget-shop" });
  assert.equal(electronics.status, 201, JSON.stringify(electronics.body));
  assert.equal((await Business.findOne({ subdomain: "gadget-shop" }).lean())?.themeId, "market", "best Free theme for electronics");

  const chosen = await create({ name: "Studio Shop", category: "clothing", subdomain: "studio-shop", themeId: "studio" });
  assert.equal(chosen.status, 201);
  assert.equal((await Business.findOne({ subdomain: "studio-shop" }).lean())?.themeId, "studio");
});

// ---------------------------------------------------------------------------
// Super Admin plan manager: themes per plan
// ---------------------------------------------------------------------------

async function adminHeaders() {
  const user = await createUser({ email: `admin-${Date.now()}-${Math.random()}@test.com`, platformRole: "super_admin" });
  return createAuthHeadersForUser(String(user._id), "super_admin", user.tokenVersion);
}

async function postPlan(body: unknown, headers: Awaited<ReturnType<typeof createAuthHeadersForUser>>) {
  const res = (await callHandler(
    plansRoute.POST,
    new Request("http://localhost/api/admin/plans", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("plan manager: theme lists are validated, stored in catalogue order and audited", async () => {
  await seedTiers();
  const headers = await adminHeaders();

  for (const themes of [["nope"], ["volt", "volt"], [], "volt"]) {
    const res = await postPlan({ key: "starter", features: { themes } }, headers);
    assert.equal(res.status, 422, `${JSON.stringify(themes)} is refused`);
  }
  assert.equal((await Plan.findOne({ key: "starter" }).lean())?.features?.themes, undefined, "nothing stored after invalid input");
  assert.equal(await AdminAuditLog.countDocuments(), 0);

  const updated = await postPlan({ key: "starter", features: { themes: ["volt", "bistro", "market"] } }, headers);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual((await Plan.findOne({ key: "starter" }).lean())?.features?.themes, ["market", "bistro", "volt"]);
  const [entry] = await AdminAuditLog.find().lean();
  assert.equal(entry.action, "plan.update");
  assert.deepEqual((entry.after as { features: { themes: string[] } }).features.themes, ["market", "bistro", "volt"]);

  // Same list in another order: no change, nothing recorded.
  const noop = await postPlan({ key: "starter", features: { themes: ["bistro", "volt", "market"] } }, headers);
  assert.equal(noop.status, 200);
  assert.equal(noop.body.changed, false);
  assert.equal(await AdminAuditLog.countDocuments(), 1);

  const unknown = await postPlan({ key: "no-such-plan", mode: "update", features: { themes: ["bistro"] } }, headers);
  assert.equal(unknown.status, 404);

  const createdPlan = await postPlan({ key: "max", name: "Max", price: 99, features: { themes: [...THEME_IDS] } }, headers);
  assert.equal(createdPlan.status, 201);
  assert.deepEqual((await Plan.findOne({ key: "max" }).lean())?.features?.themes, [...THEME_IDS]);
});

test("plan manager: only super admins can change plan themes", async () => {
  await seedTiers();
  const { owner } = await createBusinessWithOwner();
  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const res = await postPlan({ key: "free", features: { themes: [...THEME_IDS] } }, headers);
  assert.equal(res.status, 403);
  assert.equal((await Plan.findOne({ key: "free" }).lean())?.features?.themes, undefined);
});

test("a plan change applies at once to every store on it (one source of truth)", async () => {
  const { free } = await seedTiers();
  const { owner, id } = await storeOn(free._id);
  assert.equal((await patchBusiness(id, owner, { themeId: "aurora" })).status, 402);
  const headers = await adminHeaders();
  assert.equal((await postPlan({ key: "free", features: { themes: ["bistro", "aurora"] } }, headers)).status, 200);
  assert.equal((await patchBusiness(id, owner, { themeId: "aurora" })).status, 200);
  assert.equal((await patchBusiness(id, owner, { themeId: "market" })).status, 402, "market was removed from the plan");
});
