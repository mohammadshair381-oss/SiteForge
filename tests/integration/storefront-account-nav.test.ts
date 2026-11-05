import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { store } from "./helpers/customer-accounts";
import { shopperBarProps } from "@/lib/storefront-shopper";
import { CUSTOMER_SESSION_COOKIE, signCustomerSession } from "@/lib/auth/customer-session";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { Customer } from "@/models/Customer";

/**
 * Account entry of the storefront header (lib/storefront-shopper.ts): only a
 * valid session of an active customer of THIS store shows the account menu.
 * Expired, tampered, revoked, other-store and deactivated sessions all show
 * the guest "Sign in" entry, and nothing is shown while accounts are off.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  await clearAllCollections();
});

async function customer(businessId: unknown, over: Record<string, unknown> = {}) {
  return Customer.create({
    business: businessId,
    name: "Ada Lovelace",
    email: `ada-${Math.random().toString(36).slice(2)}@example.test`,
    emailVerifiedAt: new Date(),
    ...over,
  });
}

async function cookieFor(c: { _id: unknown; tokenVersion?: number }, businessId: unknown, options: { expiresAt?: Date } = {}) {
  const token = await signCustomerSession({ customerId: String(c._id), businessId: String(businessId), tokenVersion: c.tokenVersion ?? 0 }, options);
  return `${CUSTOMER_SESSION_COOKIE}=${token}`;
}

async function header(business: { _id: unknown; name: string }, cookie: string | null) {
  const props = await shopperBarProps(business as never, cookie);
  await drainAfterResponseTasks();
  return props;
}

const GUEST = { accountsEnabled: true, signedInName: null, signedInUnverified: false };

test("no account entry while customer accounts are disabled, even with a valid session", async () => {
  const { business } = await store();
  const ada = await customer(business._id);
  const props = await header(business, await cookieFor(ada, business._id));
  assert.deepEqual({ ...props, storeName: undefined }, { storeName: undefined, accountsEnabled: false, signedInName: null, signedInUnverified: false });
});

test("guests see sign-in; a signed-in customer sees their first name; unverified customers see the account menu", async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  const { business } = await store();
  const ada = await customer(business._id);
  const unverified = await customer(business._id, { name: "Grace Hopper", emailVerifiedAt: null });

  assert.deepEqual({ ...(await header(business, null)), storeName: undefined }, { ...GUEST, storeName: undefined });
  assert.equal((await header(business, await cookieFor(ada, business._id))).signedInName, "Ada");
  const pending = await header(business, await cookieFor(unverified, business._id));
  assert.equal(pending.signedInName, null);
  assert.equal(pending.signedInUnverified, true);
});

test("expired, tampered, revoked, other-store and deactivated sessions show the guest entry", async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  const { business } = await store();
  const other = await store();
  const ada = await customer(business._id);
  const guest = async (cookie: string) => {
    const props = await header(business, cookie);
    assert.deepEqual({ ...props, storeName: undefined }, { ...GUEST, storeName: undefined });
  };

  await guest(await cookieFor(ada, business._id, { expiresAt: new Date(Date.now() - 60_000) }));
  await guest(`${(await cookieFor(ada, business._id)).slice(0, -4)}AAAA`);
  await guest(await cookieFor(await customer(other.business._id), other.business._id));

  const valid = await cookieFor(ada, business._id);
  assert.equal((await header(business, valid)).signedInName, "Ada");
  await Customer.updateOne({ _id: ada._id }, { $inc: { tokenVersion: 1 } });
  await guest(valid);

  const bob = await customer(business._id, { name: "Bob" });
  const bobCookie = await cookieFor(bob, business._id);
  assert.equal((await header(business, bobCookie)).signedInName, "Bob");
  await Customer.updateOne({ _id: bob._id }, { $set: { active: false } });
  await guest(bobCookie);
});
