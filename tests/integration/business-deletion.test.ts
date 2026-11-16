import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { waitForSafeRateLimitWindow } from "./helpers/rate-limit-window";
import { resetMockCookieStore } from "./helpers/mock-next-headers-setup";
import { hashPassword } from "@/lib/auth/password";
import { getMembershipsForUser } from "@/lib/auth/guards";
import { getPublicStorefront, resolveCommerceBusiness } from "@/lib/tenant";
import { DELETE as businessDELETE, GET as businessGET } from "@/app/api/businesses/[id]/route";
import { PATCH as adminBusinessPATCH } from "@/app/api/admin/businesses/route";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Order } from "@/models/Order";
import { OrderRefund } from "@/models/OrderRefund";
import { PreviewLink } from "@/models/PreviewLink";
import { Product } from "@/models/Product";
import { TeamInvitation } from "@/models/TeamInvitation";
import { User } from "@/models/User";

/** Owner deletion of a business (lib/business-deletion.ts), against an in-memory replica set. */

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

const PASSWORD = "owner-password-1";
const PREVIEW_SCOPE = "site" as const;

async function setup(status: "draft" | "published" = "published") {
  const { owner, business } = await createBusinessWithOwner({ status });
  await User.updateOne({ _id: owner._id }, { $set: { passwordHash: await hashPassword(PASSWORD) } });
  const fresh = (await User.findById(owner._id).lean())!;
  return { owner: fresh, business, id: String(business._id) };
}

async function del(id: string, user: { _id: unknown; tokenVersion: number }, body: Record<string, unknown>, role: "user" | "super_admin" = "user") {
  const headers = await createAuthHeadersForUser(String(user._id), role, user.tokenVersion);
  const res = (await callHandler(
    businessDELETE,
    new Request(`http://localhost/api/businesses/${id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function order(businessId: string, overrides: Record<string, unknown> = {}) {
  const product = await Product.create({ business: businessId, name: "Mug", slug: `mug-${crypto.randomUUID().slice(0, 8)}`, price: 100, stock: 3, status: "active", currency: "INR" });
  return Order.create({
    business: businessId, ownerToken: `t-${crypto.randomUUID()}`, customerName: "Ada", customerEmail: "ada@example.test",
    items: [{ product: String(product._id), productName: "Mug", quantity: 1, unitPrice: 100, currency: "INR" }],
    subtotal: 100, total: 100, status: "paid", currency: "INR", inventoryState: "consumed", paidAt: new Date(), paymentMethod: "online",
    fulfillmentStatus: "delivered", ...overrides,
  });
}

test("the owner deletes the business: offline, gone from every dashboard, records kept", async () => {
  const { owner, business, id } = await setup();
  const manager = await createUser({ email: "manager@example.com" });
  await createMembership(business._id, manager._id, "manager");
  await TeamInvitation.create({ business: business._id, email: "invitee@example.com", role: "staff", tokenHash: crypto.randomBytes(32).toString("hex"), invitedBy: owner._id, expiresAt: new Date(Date.now() + 86_400_000), lastSentAt: new Date() });
  await PreviewLink.create({ business: business._id, tokenHash: crypto.randomBytes(32).toString("hex"), scope: PREVIEW_SCOPE, createdBy: owner._id, expiresAt: new Date(Date.now() + 86_400_000) });
  const kept = await order(id);
  assert.equal(await TeamInvitation.countDocuments({ business: business._id, status: "pending" }), 1, "an invitation to cancel exists");
  assert.equal(await PreviewLink.countDocuments({ business: business._id, revokedAt: null }), 1, "a preview link to revoke exists");

  const res = await del(id, owner, { confirmName: business.name, password: PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { deleted: true });

  const stored = (await Business.findById(id).lean())!;
  assert.equal(stored.status, "deleted");
  assert.equal(stored.publishedAt, null);
  assert.ok(stored.deletedAt instanceof Date);
  assert.equal(String(stored.deletedBy), String(owner._id));
  assert.equal(await Membership.countDocuments({ business: business._id, status: "active" }), 0, "every membership disabled");
  assert.equal(await TeamInvitation.countDocuments({ business: business._id, status: "pending" }), 0);
  assert.equal(await PreviewLink.countDocuments({ business: business._id, revokedAt: null }), 0);
  assert.ok(await Order.exists({ _id: kept._id }), "orders are kept");

  assert.equal(await getPublicStorefront(`${business.subdomain}.localhost:3000`), null, "storefront offline");
  assert.equal(await resolveCommerceBusiness(`${business.subdomain}.localhost:3000`), null);
  assert.equal((await getMembershipsForUser(String(owner._id))).length, 0, "gone from the owner's dashboard");
  assert.equal((await getMembershipsForUser(String(manager._id))).length, 0, "and the team's");

  const headers = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const reopen = (await callHandler(businessGET, new Request(`http://localhost/api/businesses/${id}`, { headers: { cookie: headers.cookie } }), { params: Promise.resolve({ id }) })) as Response;
  assert.equal(reopen.status, 403, "the owner cannot open it again");
  assert.equal((await del(id, owner, { confirmName: business.name, password: PASSWORD })).status, 403);
});

test("a wrong name or password changes nothing, and answers beside the field", async () => {
  const { owner, business, id } = await setup();
  const wrongName = await del(id, owner, { confirmName: `${business.name}x`, password: PASSWORD });
  assert.equal(wrongName.status, 422);
  assert.equal(wrongName.body.code, "confirmation_mismatch");
  assert.ok(wrongName.body.fields.confirmName);
  const wrongPassword = await del(id, owner, { confirmName: business.name, password: "not-the-password" });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.code, "invalid_password");
  assert.ok(wrongPassword.body.fields.password);
  assert.equal((await del(id, owner, { confirmName: business.name })).status, 422, "the password is required");
  assert.equal((await Business.findById(id).lean())?.status, "published");
});

test("only the primary owner can delete: managers, staff and a second owner cannot", async () => {
  const { business, id } = await setup();
  for (const role of ["manager", "staff", "owner"] as const) {
    const member = await createUser({ email: `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD });
    await createMembership(business._id, member._id, role);
    const res = await del(id, member, { confirmName: business.name, password: PASSWORD });
    assert.equal(res.status, 403, role);
  }
  assert.equal((await Business.findById(id).lean())?.status, "published");
});

test("it is refused while orders, refunds or a Razorpay plan still need the business", async () => {
  const { owner, business, id } = await setup();
  const pending = await order(id, { status: "pending", paidAt: null, inventoryState: "reserved", fulfillmentStatus: undefined });
  const undelivered = await order(id, { fulfillmentStatus: "shipped" });
  const paid = await order(id);
  await OrderRefund.create({
    business: id, order: paid._id, provider: "manual", mode: null, providerPaymentId: null,
    idempotencyKey: crypto.randomUUID(), amount: 10, amountMinor: 1000, currency: "INR", status: "pending", reason: "", restock: false, createdBy: owner._id,
  });
  const plan = await createPlan({ price: 499 });
  await createSubscription(business._id, plan._id, { status: "active", provider: "razorpay" });

  const res = await del(id, owner, { confirmName: business.name, password: PASSWORD });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "deletion_blocked");
  for (const word of ["waiting for payment", "not been delivered", "refund", "Razorpay"]) assert.match(res.body.error, new RegExp(word));
  assert.equal((await Business.findById(id).lean())?.status, "published", "nothing changed");
  assert.equal(await Membership.countDocuments({ business: id, status: "active" }), 1);

  // Once everything is settled, it goes through.
  await Order.updateOne({ _id: pending._id }, { $set: { status: "cancelled" } });
  await Order.updateOne({ _id: undelivered._id }, { $set: { fulfillmentStatus: "delivered" } });
  await OrderRefund.updateMany({}, { $set: { status: "processed" } });
  await (await import("@/models/Subscription")).Subscription.updateMany({ business: business._id }, { $set: { status: "canceled" } });
  assert.equal((await del(id, owner, { confirmName: business.name, password: PASSWORD })).status, 200);
});

test("a suspended business cannot be deleted, and a deleted one can never be suspended or reactivated", async () => {
  const { owner, business, id } = await setup();
  await Business.updateOne({ _id: id }, { $set: { status: "suspended" } });
  assert.equal((await del(id, owner, { confirmName: business.name, password: PASSWORD })).body.code, "suspended");
  await Business.updateOne({ _id: id }, { $set: { status: "draft" } });
  assert.equal((await del(id, owner, { confirmName: business.name, password: PASSWORD })).status, 200);

  const admin = await createUser({ email: "admin@example.com", platformRole: "super_admin" });
  const adminHeaders = await createAuthHeadersForUser(String(admin._id), "super_admin", admin.tokenVersion);
  for (const action of ["suspend", "reactivate"]) {
    const res = (await callHandler(
      adminBusinessPATCH,
      new Request(`http://localhost/api/admin/businesses?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", host: "localhost", origin: "http://localhost", ...adminHeaders },
        body: JSON.stringify({ action, reason: "Testing that a deleted store stays deleted." }),
      }),
    )) as Response;
    assert.equal(res.status, 409, action);
  }
  assert.equal((await Business.findById(id).lean())?.status, "deleted");
});

test("password guesses through the delete form are limited", async () => {
  const { owner, business, id } = await setup();
  // The limit is a fixed one-hour window: keep the burst inside one.
  await waitForSafeRateLimitWindow([60 * 60 * 1000]);
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await del(id, owner, { confirmName: business.name, password: `wrong-${i}` })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  assert.equal((await Business.findById(id).lean())?.status, "published");
});

