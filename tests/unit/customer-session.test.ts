import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT, decodeJwt } from "jose";
import { NextResponse } from "next/server";

import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_MAX_AGE_SECONDS,
  appendCustomerSessionCookie,
  clearCustomerSessionCookie,
  readCustomerSessionCookie,
  signCustomerSession,
  verifyCustomerSession,
} from "../../lib/auth/customer-session";
import { SESSION_COOKIE } from "../../lib/auth/session";
import { signSession, verifySession } from "../../lib/auth/tokens";

/** Token-level separation between customer and platform sessions (pure). */

const CUSTOMER = "64b7f0c2a1b2c3d4e5f60718";
const BUSINESS = "64b7f0c2a1b2c3d4e5f60719";
const platformKey = () => new TextEncoder().encode(process.env.SESSION_SECRET);

test("a customer token round-trips with only customer claims", async () => {
  const token = await signCustomerSession({ customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 3 });
  assert.deepEqual(await verifyCustomerSession(token), {
    customerId: CUSTOMER,
    businessId: BUSINESS,
    tokenVersion: 3,
  });
  const payload = decodeJwt(token);
  assert.equal(payload.aud, "siteforge:customer");
  assert.equal(payload.typ, "customer");
  assert.equal("platformRole" in payload, false, "no platform role claim");
  assert.equal("userId" in payload, false, "no platform user claim");
  assert.equal(CUSTOMER_SESSION_MAX_AGE_SECONDS, 60 * 60 * 24 * 7);
});

test("customer and platform tokens never verify in the other system", async () => {
  const customerToken = await signCustomerSession({ customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 0 });
  assert.equal(await verifySession(customerToken), null, "platform verifier rejects customer tokens");

  const platformToken = await signSession({ userId: CUSTOMER, platformRole: "super_admin", tokenVersion: 0 });
  assert.equal(await verifyCustomerSession(platformToken), null, "customer verifier rejects platform tokens");
});

test("a token signed with the platform key but customer-shaped claims is rejected", async () => {
  const forged = await new SignJWT({ typ: "customer", bid: BUSINESS, tv: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(CUSTOMER)
    .setIssuer("siteforge")
    .setAudience("siteforge:customer")
    .setExpirationTime("1h")
    .sign(platformKey());
  assert.equal(await verifyCustomerSession(forged), null);
});

test("expired, malformed, oversized and alg:none tokens are rejected", async () => {
  const expired = await signCustomerSession(
    { customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 0 },
    { expiresAt: new Date(Date.now() - 60_000) },
  );
  assert.equal(await verifyCustomerSession(expired), null);

  for (const bad of [null, undefined, "", "not.a.jwt", "a".repeat(5000)]) {
    assert.equal(await verifyCustomerSession(bad), null);
  }

  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ sub: CUSTOMER, bid: BUSINESS, tv: 0, typ: "customer", aud: "siteforge:customer", iss: "siteforge", exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  assert.equal(await verifyCustomerSession(`${header}.${body}.`), null);

  // A valid token with one character of the signature changed.
  const valid = await signCustomerSession({ customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 0 });
  const tampered = valid.slice(0, -2) + (valid.endsWith("A") ? "BB" : "AA");
  assert.equal(await verifyCustomerSession(tampered), null);
});

test("invalid claims are refused at signing", async () => {
  await assert.rejects(() => signCustomerSession({ customerId: "x", businessId: BUSINESS, tokenVersion: 0 }));
  await assert.rejects(() => signCustomerSession({ customerId: CUSTOMER, businessId: "$ne", tokenVersion: 0 }));
});

test("only the customer cookie is read, never the platform cookie", async () => {
  const token = await signCustomerSession({ customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 0 });
  const withPlatformOnly = new Request("http://shop.localhost:3000/", {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
  assert.equal(readCustomerSessionCookie(withPlatformOnly), null);
  const withCustomer = new Request("http://shop.localhost:3000/", {
    headers: { cookie: `other=1; ${CUSTOMER_SESSION_COOKIE}=${token}` },
  });
  assert.equal(readCustomerSessionCookie(withCustomer), token);
});

test("the customer cookie is host-only, httpOnly and SameSite=Lax", () => {
  const set = appendCustomerSessionCookie(NextResponse.json({}), "tok").headers.get("set-cookie") ?? "";
  assert.match(set, /^sf_customer=tok; Path=\/; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(set, /Domain=/i, "never shared across subdomains");
  assert.match(set, /Max-Age=604800/);
  const cleared = clearCustomerSessionCookie(NextResponse.json({})).headers.get("set-cookie") ?? "";
  assert.match(cleared, /^sf_customer=; .*Max-Age=0/);
});
