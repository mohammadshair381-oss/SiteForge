import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { decodeJwt } from "jose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import {
  PASSWORD,
  call,
  deviceCookie,
  freshIp,
  lastToken,
  me,
  register,
  registerVerified,
  sessionCookie,
  setCookies,
  store,
  waitForSafeRateLimitWindow,
} from "./helpers/customer-accounts";
import { POST as loginPOST } from "@/app/api/storefront/account/login/route";
import { POST as logoutPOST } from "@/app/api/storefront/account/logout/route";
import { POST as forgotPOST } from "@/app/api/storefront/account/password/forgot/route";
import { POST as resetPOST } from "@/app/api/storefront/account/password/reset/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { CUSTOMER_DEVICE_COOKIE } from "@/lib/auth/customer-device";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/customer-session";
import { clearEmailOutbox, setMemoryEmailFailure } from "@/lib/email";
import { RateLimit } from "@/models/RateLimit";

/**
 * Rate-limit sources (IPv4 / IPv6 /64 / shared buckets) and the known-device
 * marker that keeps distributed attackers from locking the owner out of
 * browsers the owner has already used. Markers are bound to the account's
 * current password, so a reset outdates every older one. In-memory replica set
 * only. (Expired markers are covered in tests/unit/customer-device.test.ts:
 * moving the clock here would also move the rate-limit windows.)
 */

before(async () => {
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
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  setMemoryEmailFailure(null);
  clearRequestCookies();
  await drainAfterResponseTasks();
  clearEmailOutbox();
  await clearAllCollections();
});

const WRONG = "wrong password!!";

function attempt(host: string, password: string, options: { ip?: string | null; cookie?: string; email?: string } = {}) {
  return call(loginPOST, host, { email: options.email ?? "ada@example.com", password }, {
    ip: options.ip === undefined ? freshIp() : options.ip,
    cookie: options.cookie,
  });
}

/** Spends the whole 50-failure account-wide budget from 10 distinct sources. */
async function lockAccount(host: string, email = "ada@example.com") {
  for (let source = 0; source < 10; source += 1) {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await attempt(host, WRONG, { ip, email })).status, 401);
    }
  }
  assert.equal((await attempt(host, WRONG, { email })).status, 429, "account-wide budget spent");
}

async function ownerDevice(host: string) {
  const response = await attempt(host, PASSWORD);
  assert.equal(response.status, 200);
  const cookie = deviceCookie(response);
  assert.ok(cookie, "a successful login marks the browser as a known device");
  return cookie;
}

const deviceIdOf = (cookie: string) => decodeJwt(cookie.slice(cookie.indexOf("=") + 1)).sub;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

test("IPv6 clients are limited per /64: rotating addresses inside one /64 is one source", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  for (let i = 1; i <= 5; i += 1) {
    assert.equal((await attempt(host, WRONG, { ip: `2001:db8:1:2::${i}` })).status, 401);
  }
  assert.equal((await attempt(host, PASSWORD, { ip: "2001:db8:1:2:dead:beef:0:1" })).status, 429);
  assert.equal((await attempt(host, PASSWORD, { ip: "[2001:db8:1:2::99]:443" })).status, 429);
  // A different /64 (another subscriber) is unaffected.
  assert.equal((await attempt(host, PASSWORD, { ip: "2001:db8:1:3::1" })).status, 200);
});

test("an IPv4-mapped IPv6 address is the same source as the IPv4 address", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(host, WRONG, { ip: i % 2 ? "203.0.113.50" : "::ffff:203.0.113.50" })).status, 401);
  }
  assert.equal((await attempt(host, PASSWORD, { ip: "203.0.113.50:6000" })).status, 429);
  assert.equal((await attempt(host, PASSWORD, { ip: "203.0.113.51" })).status, 200);
});

test("malformed and missing client addresses share one bucket each and cannot mint sources", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  // Varying garbage in the trusted header all lands in the "unparseable" bucket.
  for (const garbage of ["garbage-1", "garbage-2", "1.2.3.999", "::::", "zz"]) {
    assert.equal((await attempt(host, WRONG, { ip: garbage })).status, 401);
  }
  assert.equal((await attempt(host, WRONG, { ip: "garbage-6" })).status, 429);
  // No header at all (outside production: the shared "unknown" bucket; in
  // production getClientIp refuses with 503, see tests/unit/rate-limit-ip).
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(host, WRONG, { ip: i % 2 ? null : "" })).status, 401);
  }
  assert.equal((await attempt(host, WRONG, { ip: null })).status, 429);
  // A real client is unaffected by either shared bucket.
  assert.equal((await attempt(host, PASSWORD)).status, 200);
});

// ---------------------------------------------------------------------------
// Known devices vs distributed lockout
// ---------------------------------------------------------------------------

test("distributed attackers cannot lock the owner out of a known device, even when they renew the lock", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const device = await ownerDevice(host);
  await waitForSafeRateLimitWindow();

  await lockAccount(host);
  assert.equal((await attempt(host, PASSWORD)).status, 429, "a new browser is locked out (residual risk)");
  const ok = await attempt(host, PASSWORD, { cookie: device });
  assert.equal(ok.status, 200, "the owner's known browser still signs in");
  assert.equal(deviceIdOf(deviceCookie(ok)!), deviceIdOf(device), "the marker is refreshed, same device");

  // Simulate the hourly window boundary (fixed windows reset together) by
  // clearing the counters, then let the attackers renew the lock.
  await RateLimit.deleteMany({});
  await lockAccount(host);
  assert.equal((await attempt(host, PASSWORD, { cookie: device })).status, 200, "renewing the lock changes nothing");
  assert.equal((await attempt(host, PASSWORD)).status, 429);
});

test("a known device has its own small failure budget and never spends the account-wide one", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const device = await ownerDevice(host);
  await waitForSafeRateLimitWindow();

  // Correct passwords never count.
  for (let i = 0; i < 6; i += 1) {
    assert.equal((await attempt(host, PASSWORD, { cookie: device })).status, 200);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(host, WRONG, { cookie: device })).status, 401);
  }
  assert.equal((await attempt(host, WRONG, { cookie: device })).status, 429, "per-device budget spent");
  assert.equal((await attempt(host, PASSWORD, { cookie: device })).status, 429, "even with the right password");
  // Those device failures did not touch the account-wide or per-source budgets.
  assert.equal((await attempt(host, PASSWORD)).status, 200);
});

test("a marker for another account or store, or a forged one, does not bypass the lock", async () => {
  const a = await store();
  const b = await store();
  await registerVerified(a.host, "ada@example.com");
  await registerVerified(a.host, "mallory@example.com");
  await registerVerified(b.host, "ada@example.com");
  const malloryResponse = await attempt(a.host, PASSWORD, { email: "mallory@example.com" });
  const malloryDevice = deviceCookie(malloryResponse)!;
  const otherStoreDevice = deviceCookie(await attempt(b.host, PASSWORD))!;
  await waitForSafeRateLimitWindow();

  await lockAccount(a.host);
  for (const cookie of [
    malloryDevice, // the attacker's own account at the same store
    otherStoreDevice, // the victim's email, but another store
    `${CUSTOMER_DEVICE_COOKIE}=forged.token.value`,
    `${CUSTOMER_DEVICE_COOKIE}=`,
  ]) {
    assert.equal((await attempt(a.host, PASSWORD, { cookie })).status, 429, cookie.slice(0, 20));
  }
});

test("a known-device marker is never a session", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const device = await ownerDevice(host);
  assert.equal(await me(host, device), null, "the marker alone does not authenticate");
  const marker = device.slice(device.indexOf("=") + 1);
  assert.equal(await me(host, `sf_customer=${marker}`), null, "nor when presented as the session cookie");
  // A wrong password with the marker is still a plain 401, with no cookies.
  const wrong = await attempt(host, WRONG, { cookie: device });
  assert.equal(wrong.status, 401);
  assert.equal(setCookies(wrong).length, 0);
});

test("a password reset makes the browser a known device, so the owner can recover during a lock", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  await lockAccount(host);

  await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() });
  const reset = await call(resetPOST, host, { token: lastToken("/account/reset-password"), password: "brand new pass" }, { ip: freshIp() });
  assert.equal(reset.status, 200);
  const device = deviceCookie(reset);
  assert.ok(device, "reset proved inbox control: this browser is now known");
  assert.equal(setCookies(reset).some((c) => c.startsWith("sf_customer=")), false, "still not signed in");

  assert.equal((await attempt(host, "brand new pass", { cookie: device })).status, 200);
  assert.equal((await attempt(host, "brand new pass")).status, 429, "other browsers remain locked until the window ends");
});

// ---------------------------------------------------------------------------
// Markers are bound to the current password
// ---------------------------------------------------------------------------

const NEW_PASSWORD = "brand new pass";

async function resetPassword(host: string, password = NEW_PASSWORD) {
  await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() });
  const response = await call(resetPOST, host, { token: lastToken("/account/reset-password"), password }, { ip: freshIp() });
  assert.equal(response.status, 200);
  const device = deviceCookie(response);
  assert.ok(device, "the reset issues a marker for the new password");
  return device;
}

test("a password reset outdates every older marker, including harvested ones", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  // Someone who knows the current password signs in from several "browsers"
  // and keeps every marker (each login without a marker mints a new device).
  const logins = [await attempt(host, PASSWORD), await attempt(host, PASSWORD), await attempt(host, PASSWORD)];
  const harvested = logins.map((response) => deviceCookie(response)!);
  const sessionBeforeReset = sessionCookie(logins[0]);
  await waitForSafeRateLimitWindow();
  await lockAccount(host);
  for (const cookie of harvested) {
    assert.equal((await attempt(host, PASSWORD, { cookie })).status, 200, "before the reset, each marker gets its own budget");
  }

  const fresh = await resetPassword(host);
  assert.ok(!harvested.map(deviceIdOf).includes(deviceIdOf(fresh)), "the reset browser gets a new device id");
  for (const cookie of harvested) {
    assert.equal((await attempt(host, NEW_PASSWORD, { cookie })).status, 429, "outdated marker: normal (locked) limits");
    assert.equal((await attempt(host, PASSWORD, { cookie })).status, 429);
  }
  assert.equal((await attempt(host, NEW_PASSWORD, { cookie: fresh })).status, 200, "the marker issued by the reset works");
  assert.equal(await me(host, sessionBeforeReset), null, "the reset still revokes every session");
});

test("an outdated marker falls back to the normal limits of its source", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const outdated = await ownerDevice(host);
  const fresh = await resetPassword(host);
  await waitForSafeRateLimitWindow();

  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await attempt(host, WRONG, { ip, cookie: outdated })).status, 401);
  }
  // Those failures were counted against this source like any other client's...
  assert.equal((await attempt(host, NEW_PASSWORD, { ip })).status, 429);
  assert.equal((await attempt(host, NEW_PASSWORD, { ip, cookie: outdated })).status, 429);
  // ...while a current marker keeps its own budget on the same source.
  assert.equal((await attempt(host, NEW_PASSWORD, { ip, cookie: fresh })).status, 200);
});

test("the per-source limit applies to known devices too", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const device = await ownerDevice(host);
  await waitForSafeRateLimitWindow();

  const ip = freshIp();
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await attempt(host, PASSWORD, { ip, cookie: device })).status, 200);
  }
  const blocked = await attempt(host, PASSWORD, { ip, cookie: device });
  assert.equal(blocked.status, 429, "20 attempts per 15 minutes per source, marker or not");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(setCookies(blocked).length, 0);
  assert.equal((await attempt(host, PASSWORD, { cookie: device })).status, 200, "another source is unaffected");
});

test("logout ends every session; the marker neither authenticates nor is revoked by it", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const signedIn = await attempt(host, PASSWORD);
  const session = sessionCookie(signedIn);
  const device = deviceCookie(signedIn)!;

  const out = await call(logoutPOST, host, {}, { ip: freshIp(), cookie: `${session}; ${device}` });
  assert.equal(out.status, 200);
  assert.ok(setCookies(out).some((c) => c.startsWith(`${CUSTOMER_SESSION_COOKIE}=;`)), "session cookie cleared");
  assert.ok(!setCookies(out).some((c) => c.startsWith(`${CUSTOMER_DEVICE_COOKIE}=`)), "marker untouched");
  assert.equal(await me(host, session), null);
  assert.equal(await me(host, `${session}; ${device}`), null, "the marker does not keep a session alive");
  assert.equal(await me(host, device), null);

  // The marker still selects its own budget (by design), and still needs the password.
  await waitForSafeRateLimitWindow();
  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt(host, WRONG, { ip })).status, 401);
  assert.equal((await attempt(host, PASSWORD, { ip })).status, 429);
  assert.equal((await attempt(host, WRONG, { ip, cookie: device })).status, 401);
  assert.equal((await attempt(host, PASSWORD, { ip, cookie: device })).status, 200);
});

test("failed logins never issue a device marker", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await register(host, "pending@example.com");
  const pending = await call(loginPOST, host, { email: "pending@example.com", password: PASSWORD }, { ip: freshIp() });
  assert.equal(pending.status, 403, "correct password, unconfirmed email");
  assert.equal(setCookies(pending).length, 0, "neither a session nor a marker");
  for (const response of [await attempt(host, WRONG), await attempt(host, PASSWORD, { email: "nobody@example.com" })]) {
    assert.equal(response.status, 401);
    assert.equal(setCookies(response).length, 0);
  }
});
