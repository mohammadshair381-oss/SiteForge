import "../helpers/env";

import assert from "node:assert/strict";
import test from "node:test";

import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";

import {
  SESSION_MAX_AGE_SECONDS,
  signSession,
  verifySession,
} from "../../backend/lib/auth/tokens";

const key = () => new TextEncoder().encode(process.env.SESSION_SECRET);

test("SESSION_MAX_AGE_SECONDS is seven days", () => {
  assert.equal(SESSION_MAX_AGE_SECONDS, 60 * 60 * 24 * 7);
});

test("a signed session round-trips with all claims intact", async () => {
  const token = await signSession({
    userId: "user-1",
    platformRole: "super_admin",
    tokenVersion: 3,
  });
  const claims = await verifySession(token);
  assert.deepEqual(claims, {
    userId: "user-1",
    platformRole: "super_admin",
    tokenVersion: 3,
  });
});

test("verifySession rejects garbage and tokens signed with another key", async () => {
  assert.equal(await verifySession("not-a-token"), null);

  const foreign = await new SignJWT({
    userId: "user-1",
    platformRole: "user",
    tokenVersion: 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-different-secret-that-is-long-enough!!"));
  assert.equal(await verifySession(foreign), null);
});

test("verifySession rejects expired tokens", async () => {
  const expired = await new SignJWT({
    userId: "user-1",
    platformRole: "user",
    tokenVersion: 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(key());
  assert.equal(await verifySession(expired), null);
});

test("verifySession defaults a missing tokenVersion to 0", async () => {
  const legacy = await new SignJWT({ userId: "user-1", platformRole: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key());
  const claims = await verifySession(legacy);
  assert.equal(claims?.tokenVersion, 0);
});

test("verifySession coerces unknown platform roles to 'user'", async () => {
  const weird = await new SignJWT({ userId: "user-1", platformRole: "hacker" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key());
  const claims = await verifySession(weird);
  assert.equal(claims?.platformRole, "user");
});

test("a signed session uses the HS256 algorithm", async () => {
  const token = await signSession({
    userId: "user-1",
    platformRole: "user",
    tokenVersion: 0,
  });
  assert.deepEqual(decodeProtectedHeader(token).alg, "HS256");
});

test("a signed session expires exactly SESSION_MAX_AGE_SECONDS after issue", async () => {
  const token = await signSession({
    userId: "user-1",
    platformRole: "user",
    tokenVersion: 0,
  });
  const payload = decodeJwt(token);
  assert.equal(typeof payload.iat, "number");
  assert.equal(typeof payload.exp, "number");
  assert.equal((payload.exp as number) - (payload.iat as number), SESSION_MAX_AGE_SECONDS);
});

test("verifySession rejects an empty token", async () => {
  assert.equal(await verifySession(""), null);
});

test("verifySession rejects a fabricated alg:none (unsigned) token", async () => {
  const base64url = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${base64url({ alg: "none", typ: "JWT" })}.${base64url({
    userId: "user-1",
    platformRole: "super_admin",
    tokenVersion: 0,
  })}.`;
  assert.equal(await verifySession(unsigned), null);
});

test("verifySession rejects a valid token whose signature was stripped", async () => {
  const token = await signSession({
    userId: "user-1",
    platformRole: "user",
    tokenVersion: 0,
  });
  const [header, payload] = token.split(".");
  assert.equal(await verifySession(`${header}.${payload}.`), null);
});
