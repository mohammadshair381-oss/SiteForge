import "../helpers/env";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { mock } from "node:test";
import { decodeJwt } from "jose";
import { NextResponse } from "next/server";

import {
  CUSTOMER_DEVICE_COOKIE,
  CUSTOMER_DEVICE_MAX_AGE_SECONDS,
  appendCustomerDeviceCookie,
  customerCredentialFingerprint,
  newCustomerDeviceId,
  readCustomerDeviceCookie,
  signCustomerDevice,
  verifyCustomerDevice,
} from "../../backend/lib/auth/customer-device";
import {
  CUSTOMER_SESSION_COOKIE,
  readCustomerSessionCookie,
  signCustomerSession,
  verifyCustomerSession,
} from "../../backend/lib/auth/customer-session";

/** Known-device markers: bound to one account and its current password, never a session (pure). */

const BUSINESS = "64b7f0c2a1b2c3d4e5f60719";
const OTHER_BUSINESS = "64b7f0c2a1b2c3d4e5f6071a";
const CUSTOMER = "64b7f0c2a1b2c3d4e5f60718";
// Shaped like bcrypt hashes; only their fingerprints ever reach a marker.
const HASH = "$2a$12$abcdefghijklmnopqrstuuJ0yN7m3V8k5cQ1Zx9wR2sT4uV6wX8yZ";
const NEW_HASH = "$2a$12$zyxwvutsrqponmlkjihgfeK1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT";
const CURRENT = customerCredentialFingerprint(BUSINESS, HASH);
const AFTER_RESET = customerCredentialFingerprint(BUSINESS, NEW_HASH);

function expectedFor(email: string, current: string | null = CURRENT, businessId = BUSINESS) {
  return { businessId, email, currentCredential: async () => current };
}

async function marker(email = "ada@example.com", credential = CURRENT) {
  return signCustomerDevice({ deviceId: newCustomerDeviceId(), businessId: BUSINESS, email, credential });
}

test("a marker verifies only for the same business, email and current password", async () => {
  const deviceId = newCustomerDeviceId();
  const token = await signCustomerDevice({ deviceId, businessId: BUSINESS, email: "ada@example.com", credential: CURRENT });
  assert.deepEqual(await verifyCustomerDevice(token, expectedFor("ada@example.com")), { deviceId });
  assert.equal(await verifyCustomerDevice(token, expectedFor("eve@example.com")), null, "other account");
  assert.equal(await verifyCustomerDevice(token, expectedFor("ada@example.com", CURRENT, OTHER_BUSINESS)), null, "other store");
  assert.equal(await verifyCustomerDevice(token, expectedFor("ada@example.com", AFTER_RESET)), null, "outdated: password changed");
  assert.equal(await verifyCustomerDevice(token, expectedFor("ada@example.com", null)), null, "no usable account");
});

test("the current password is looked up only after the signature and account binding check out", async () => {
  let lookups = 0;
  const expected = (email: string, businessId = BUSINESS) => ({
    businessId,
    email,
    currentCredential: async () => {
      lookups += 1;
      return CURRENT;
    },
  });
  const token = await marker();
  const [header, payload, signature] = token.split(".");
  for (const [bad, email, businessId] of [
    [`${header}.${payload}.${signature.slice(0, -2)}xx`, "ada@example.com", BUSINESS],
    ["not.a.jwt", "ada@example.com", BUSINESS],
    [token, "eve@example.com", BUSINESS],
    [token, "ada@example.com", OTHER_BUSINESS],
  ] as const) {
    assert.equal(await verifyCustomerDevice(bad, expected(email, businessId)), null);
  }
  assert.equal(lookups, 0, "no database read for markers that are not bound to this (store, email)");
  assert.ok(await verifyCustomerDevice(token, expected("ada@example.com")));
  assert.equal(lookups, 1);
});

test("a database error during the password lookup propagates instead of passing as a bad marker", async () => {
  const token = await marker();
  await assert.rejects(
    verifyCustomerDevice(token, {
      businessId: BUSINESS,
      email: "ada@example.com",
      currentCredential: async () => {
        throw new Error("database down");
      },
    }),
    /database down/,
  );
});

test("the marker reveals neither the email nor the password hash", async () => {
  const claims = decodeJwt(await marker());
  const serialized = JSON.stringify(claims);
  assert.ok(!serialized.includes("ada"));
  assert.ok(!serialized.includes(HASH) && !serialized.includes(HASH.slice(7)));
  assert.equal(claims.typ, "customer-device");
  assert.equal(claims.aud, "siteforge:customer-device");
  assert.equal(claims.iss, "siteforge");
  assert.equal(claims.cf, CURRENT);
  assert.equal((claims.exp ?? 0) - (claims.iat ?? 0), CUSTOMER_DEVICE_MAX_AGE_SECONDS);
});

test("the password fingerprint is keyed, per store, and changes with the password", () => {
  assert.match(CURRENT, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(customerCredentialFingerprint(BUSINESS, HASH), CURRENT, "deterministic");
  assert.notEqual(AFTER_RESET, CURRENT, "a new password hash gives a new fingerprint");
  assert.notEqual(customerCredentialFingerprint(OTHER_BUSINESS, HASH), CURRENT, "per store");
  const unkeyed = crypto.createHash("sha256").update(`credential:${BUSINESS}:${HASH}`).digest("base64url");
  assert.notEqual(CURRENT, unkeyed, "not computable without the server secret");
});

test("tampered, malformed, missing and oversized markers are rejected", async () => {
  const token = await marker();
  const [header, payload, signature] = token.split(".");
  const claims = decodeJwt(token);
  const reencode = (changes: Record<string, unknown>) =>
    Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
  for (const bad of [
    `${header}.${reencode({ bid: OTHER_BUSINESS })}.${signature}`,
    `${header}.${reencode({ cf: AFTER_RESET })}.${signature}`, // swap in a newer password fingerprint
    `${header}.${payload}.${signature.slice(0, -2)}xx`,
    `${header}.${payload}`,
    "not.a.jwt",
    "",
    null,
    undefined,
    "a".repeat(2000),
  ]) {
    assert.equal(await verifyCustomerDevice(bad, expectedFor("ada@example.com", AFTER_RESET)), null);
    assert.equal(await verifyCustomerDevice(bad, expectedFor("ada@example.com")), null);
  }
});

test("an expired marker is rejected", async () => {
  const token = await marker();
  const issuedAt = Date.now();
  const day = 24 * 60 * 60 * 1000;
  mock.timers.enable({ apis: ["Date"], now: issuedAt + 89 * day });
  try {
    assert.ok(await verifyCustomerDevice(token, expectedFor("ada@example.com")), "still valid on day 89");
    mock.timers.setTime(issuedAt + 91 * day);
    assert.equal(await verifyCustomerDevice(token, expectedFor("ada@example.com")), null, "expired after 90 days");
  } finally {
    mock.timers.reset();
  }
});

test("a marker is never a session, and a session is never a marker", async () => {
  const token = await marker();
  assert.equal(await verifyCustomerSession(token), null);
  const session = await signCustomerSession({ customerId: CUSTOMER, businessId: BUSINESS, tokenVersion: 0 });
  assert.equal(await verifyCustomerDevice(session, expectedFor("ada@example.com")), null);

  // The cookies are read under different names, so neither stands in for the other.
  const request = new Request("http://shop.localhost:3000/", {
    headers: { cookie: `${CUSTOMER_DEVICE_COOKIE}=${token}` },
  });
  assert.equal(readCustomerSessionCookie(request), null);
  assert.equal(readCustomerDeviceCookie(request), token);
  assert.notEqual(CUSTOMER_DEVICE_COOKIE, CUSTOMER_SESSION_COOKIE);
});

test("device ids are random and the claims are validated at signing", async () => {
  const ids = new Set(Array.from({ length: 50 }, () => newCustomerDeviceId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  const valid = { deviceId: newCustomerDeviceId(), businessId: BUSINESS, email: "a@b.co", credential: CURRENT };
  await assert.rejects(signCustomerDevice({ ...valid, deviceId: "short" }));
  await assert.rejects(signCustomerDevice({ ...valid, businessId: "nope" }));
  await assert.rejects(signCustomerDevice({ ...valid, credential: HASH }), "a raw hash is never accepted");
  await assert.rejects(signCustomerDevice({ ...valid, credential: "" }));
});

test("outside production the marker cookie is host-only, httpOnly and SameSite=Strict", () => {
  const set = appendCustomerDeviceCookie(NextResponse.json({}), "tok").headers.get("set-cookie") ?? "";
  assert.equal(set, "sf_device=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000");
});
