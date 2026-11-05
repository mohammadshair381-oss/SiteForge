import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose, { type Types } from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner } from "./helpers/tenant";
import { clearRequestCookies, setRequestCookiesFromHeader } from "./helpers/mock-next-headers-setup";
import { HttpError } from "@/lib/api";
import { hashPassword } from "@/lib/auth/password";
import { requireBusinessRole, requireSuperAdmin, requireUser } from "@/lib/auth/guards";
import { getCustomer, requireCustomer, revokeCustomerSessions } from "@/lib/auth/customer-guards";
import { CUSTOMER_SESSION_COOKIE, signCustomerSession } from "@/lib/auth/customer-session";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { Customer } from "@/models/Customer";
import { User } from "@/models/User";

/**
 * Customer session foundation: business-scoped customer accounts, isolated
 * from platform-user sessions in both directions.
 */

before(async () => {
  // Customer accounts are gated (default off); these tests exercise the guard itself.
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

async function store() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  return { owner, business, host: `${business.subdomain}.localhost:3000` };
}

async function createCustomer(
  businessId: Types.ObjectId,
  overrides: Partial<{ email: string; active: boolean; emailVerifiedAt: Date | null }> = {},
) {
  return Customer.create({
    business: businessId,
    name: "Ada Shopper",
    email: overrides.email ?? `ada-${new mongoose.Types.ObjectId()}@example.com`,
    passwordHash: await hashPassword("correct horse battery"),
    active: overrides.active ?? true,
    emailVerifiedAt: overrides.emailVerifiedAt ?? null,
  });
}

async function tokenFor(customer: { _id: Types.ObjectId; business: Types.ObjectId; tokenVersion: number }, businessId?: Types.ObjectId) {
  return signCustomerSession({
    customerId: String(customer._id),
    businessId: String(businessId ?? customer.business),
    tokenVersion: customer.tokenVersion,
  });
}

function storefrontRequest(host: string, cookie?: string) {
  return new Request(`http://${host}/account`, { headers: { host, ...(cookie ? { cookie } : {}) } });
}

async function expect401(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 401);
    return true;
  });
}

test("a valid customer session on its own storefront resolves the customer, without secrets", async () => {
  const { business, host } = await store();
  const customer = await createCustomer(business._id);
  const token = await tokenFor(customer);

  const context = await requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${token}`));
  assert.equal(context.customer.id, String(customer._id));
  assert.equal(context.customer.businessId, String(business._id));
  assert.equal(String(context.business._id), String(business._id));
  assert.equal(context.customer.emailVerified, false);
  const serialized = JSON.stringify(context.customer);
  for (const secret of ["passwordHash", "tokenVersion", "$2"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be exposed`);
  }

  // Default queries and JSON never carry the hash or the token version.
  const loaded = await Customer.findById(customer._id);
  assert.equal(loaded?.passwordHash, undefined);
  const json = JSON.stringify(customer.toJSON());
  assert.equal(json.includes("passwordHash"), false);
  assert.equal(json.includes("tokenVersion"), false);
});

test("a session from business A is refused on business B's storefront", async () => {
  const a = await store();
  const b = await store();
  const customer = await createCustomer(a.business._id);

  // A's token presented to B's host.
  await expect401(requireCustomer(storefrontRequest(b.host, `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(customer)}`)));

  // A token claiming business B for an A customer: no such customer in B.
  const relabelled = await tokenFor(customer, b.business._id);
  await expect401(requireCustomer(storefrontRequest(b.host, `${CUSTOMER_SESSION_COOKIE}=${relabelled}`)));

  // Unknown host and platform host.
  await expect401(requireCustomer(storefrontRequest("nobody.localhost:3000", `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(customer)}`)));
  await expect401(requireCustomer(storefrontRequest("localhost:3000", `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(customer)}`)));
});

test("the same email at two businesses is two independent accounts", async () => {
  const a = await store();
  const b = await store();
  const atA = await createCustomer(a.business._id, { email: "same@example.com" });
  const atB = await createCustomer(b.business._id, { email: "same@example.com" });
  assert.notEqual(String(atA._id), String(atB._id));

  const tokenA = await tokenFor(atA);
  assert.equal((await requireCustomer(storefrontRequest(a.host, `${CUSTOMER_SESSION_COOKIE}=${tokenA}`))).customer.id, String(atA._id));
  await expect401(requireCustomer(storefrontRequest(b.host, `${CUSTOMER_SESSION_COOKIE}=${tokenA}`)));
});

test("inactive accounts, revoked sessions and password changes are refused", async () => {
  const { business, host } = await store();

  const inactive = await createCustomer(business._id, { active: false });
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(inactive)}`)));

  const revoked = await createCustomer(business._id);
  const oldToken = await tokenFor(revoked);
  assert.equal(await revokeCustomerSessions(String(business._id), String(revoked._id)), true);
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${oldToken}`)));
  const fresh = await Customer.findById(revoked._id).lean();
  assert.ok(fresh);
  const newToken = await signCustomerSession({ customerId: String(revoked._id), businessId: String(business._id), tokenVersion: fresh.tokenVersion });
  assert.ok(await requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${newToken}`)));

  const changer = await createCustomer(business._id);
  const beforeChange = await tokenFor(changer);
  const doc = await Customer.findById(changer._id).select("+passwordHash");
  assert.ok(doc);
  doc.passwordHash = await hashPassword("a brand new password");
  await doc.save();
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${beforeChange}`)));
});

test("revocation is scoped to the business", async () => {
  const a = await store();
  const b = await store();
  const customer = await createCustomer(a.business._id);
  assert.equal(await revokeCustomerSessions(String(b.business._id), String(customer._id)), false);
  assert.equal(await revokeCustomerSessions(String(b.business._id), "not-an-id"), false);
  assert.equal((await Customer.findById(customer._id).lean())?.tokenVersion, 0);
});

test("expired, malformed, missing and platform tokens never pass the customer guard", async () => {
  const { owner, business, host } = await store();
  const customer = await createCustomer(business._id);

  const expired = await signCustomerSession(
    { customerId: String(customer._id), businessId: String(business._id), tokenVersion: 0 },
    { expiresAt: new Date(Date.now() - 1000) },
  );
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${expired}`)));
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=garbage`)));
  await expect401(requireCustomer(storefrontRequest(host)));
  assert.equal(await getCustomer(storefrontRequest(host)), null);

  // A platform owner session, in either cookie, is not a customer session.
  const platform = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const platformToken = platform.cookie.split("=").slice(1).join("=");
  await expect401(requireCustomer(storefrontRequest(host, platform.cookie)));
  await expect401(requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${platformToken}`)));
});

test("a customer token never passes platform or business-role guards", async () => {
  const { business } = await store();
  const customer = await createCustomer(business._id);
  const token = await tokenFor(customer);
  // Even a super admin whose id equals the customer id gains nothing: the
  // platform verifier rejects the customer token before any id lookup.
  const admin = await createUser({ email: "cust-iso-admin@test.com", platformRole: "super_admin" });
  await User.collection.insertOne({ ...(await User.collection.findOne({ _id: admin._id })), _id: customer._id, email: "same-id-admin@test.com" });
  assert.ok(await User.exists({ _id: customer._id, platformRole: "super_admin" }));

  for (const cookie of [`${SESSION_COOKIE}=${token}`, `${CUSTOMER_SESSION_COOKIE}=${token}`]) {
    setRequestCookiesFromHeader(cookie);
    await expect401(requireUser());
    await expect401(requireSuperAdmin());
    await expect401(requireBusinessRole(String(business._id), ["owner", "manager", "staff"]));
  }
  clearRequestCookies();
});

test("sensitive features can require a verified email", async () => {
  const { business, host } = await store();
  const unverified = await createCustomer(business._id);
  await assert.rejects(
    requireCustomer(storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(unverified)}`), { requireVerifiedEmail: true }),
    (error: unknown) => error instanceof HttpError && error.status === 403 && error.code === "customer_email_unverified",
  );
  const verified = await createCustomer(business._id, { emailVerifiedAt: new Date() });
  const context = await requireCustomer(
    storefrontRequest(host, `${CUSTOMER_SESSION_COOKIE}=${await tokenFor(verified)}`),
    { requireVerifiedEmail: true },
  );
  assert.equal(context.customer.emailVerified, true);
});
