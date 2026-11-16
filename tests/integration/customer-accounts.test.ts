import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import {
  PASSWORD,
  call,
  emailsTo,
  freshIp,
  lastToken,
  login,
  me,
  register,
  registerVerified,
  sessionCookie,
  setCookies,
  store,
} from "./helpers/customer-accounts";
import { POST as registerPOST } from "@/app/api/storefront/account/register/route";
import { POST as loginPOST } from "@/app/api/storefront/account/login/route";
import { POST as logoutPOST } from "@/app/api/storefront/account/logout/route";
import { POST as verifyPOST } from "@/app/api/storefront/account/email/verify/route";
import { POST as resendPOST } from "@/app/api/storefront/account/email/resend/route";
import { POST as forgotPOST } from "@/app/api/storefront/account/password/forgot/route";
import { POST as resetPOST } from "@/app/api/storefront/account/password/reset/route";
import { POST as platformLoginPOST } from "@/app/api/auth/login/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { CUSTOMER_AUTH_GENERIC_MESSAGE } from "@/lib/auth/customer-accounts";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/customer-session";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { clearEmailOutbox, getEmailOutbox, setMemoryEmailFailure } from "@/lib/email";
import { Business } from "@/models/Business";
import { Customer } from "@/models/Customer";
import { CustomerActionToken } from "@/models/CustomerActionToken";
import { Membership } from "@/models/Membership";
import { User } from "@/models/User";

/**
 * Storefront customer accounts: registration, login/logout, email
 * verification and password recovery, end to end through the route handlers
 * against the in-memory replica set (indexes exist only there). The feature
 * gate is enabled for this suite; gate, timing, rate-limit and email-failure
 * hardening live in customer-accounts-hardening.test.ts.
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

async function usableTokens(type: "email_verification" | "password_reset") {
  return CustomerActionToken.countDocuments({ type, usedAt: null, expiresAt: { $gt: new Date() } });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registration creates an unverified, business-scoped account and emails a storefront link", async () => {
  const { business, host, origin } = await store();
  const usersBefore = await User.countDocuments();
  const membershipsBefore = await Membership.countDocuments();

  const response = await register(host, "  Ada.Shopper@Example.COM ");
  assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(setCookies(response).length, 0, "registration never signs in");

  const customer = await Customer.findOne({ business: business._id }).select("+passwordHash").lean();
  assert.ok(customer);
  assert.equal(customer.email, "ada.shopper@example.com");
  assert.equal(customer.emailVerifiedAt, null);
  assert.equal(customer.active, true);
  assert.equal(customer.user, null);
  assert.ok(customer.passwordHash && customer.passwordHash !== PASSWORD && customer.passwordHash.startsWith("$2"));

  // No platform user, role or membership is ever created.
  assert.equal(await User.countDocuments(), usersBefore);
  assert.equal(await Membership.countDocuments(), membershipsBefore);

  const [email] = getEmailOutbox();
  assert.equal(email.to, "ada.shopper@example.com");
  assert.ok(email.text.includes(`${origin}/account/verify-email#token=`));
  assert.ok(!email.html.includes("<script"), "template output is escaped");
});

test("registering an existing verified email returns the identical response and changes nothing", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  clearEmailOutbox();

  const again = await register(host, "ADA@example.com", "a different password", "Mallory");
  assert.deepEqual(await again.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
  assert.equal(await Customer.countDocuments(), 1);
  assert.equal((await Customer.findOne().lean())?.name, "Ada Shopper");

  const [notice] = getEmailOutbox();
  assert.equal(notice.to, "ada@example.com");
  assert.match(notice.text, /\/account\/forgot-password/);
  assert.doesNotMatch(notice.text, /token=/, "no token in the account-exists notice");
  assert.doesNotMatch(notice.text, /not confirmed yet/);

  assert.equal((await login(host, "ada@example.com")).status, 200, "original password still works");
  assert.equal((await login(host, "ada@example.com", "a different password")).status, 401);
});

test("re-registering an unverified email never overwrites it and never kills the pending link", async () => {
  const { host } = await store();
  await register(host, "victim@example.com", "victim password 22", "Victoria");
  const victimLink = lastToken("/account/verify-email", "victim@example.com");
  const before = await Customer.findOne().select("+passwordHash name tokenVersion").lean();

  // An attacker re-registers the same email repeatedly, from different IPs.
  for (let i = 0; i < 4; i += 1) {
    await register(host, "victim@example.com", `attacker password ${i}`, "Mallory");
  }

  const after = await Customer.findOne().select("+passwordHash name tokenVersion").lean();
  assert.equal(after?.passwordHash, before?.passwordHash, "password not replaced");
  assert.equal(after?.name, "Victoria", "name not replaced");
  assert.equal(after?.tokenVersion, before?.tokenVersion);
  assert.equal(await usableTokens("email_verification"), 1, "no new tokens were issued");

  // The notices carry no token and tell the owner how to proceed.
  const notices = emailsTo("victim@example.com").slice(1);
  assert.equal(notices.length, 4);
  for (const notice of notices) {
    assert.doesNotMatch(notice.text, /token=/);
    assert.match(notice.text, /not confirmed yet/);
  }

  // The legitimate owner verifies with the original link and password.
  const verified = await call(verifyPOST, host, { token: victimLink, password: "victim password 22" }, { ip: freshIp() });
  assert.equal(verified.status, 200);
  assert.equal((await login(host, "victim@example.com", "attacker password 0")).status, 401);
  assert.equal((await login(host, "victim@example.com", "victim password 22")).status, 200);
});

test("pre-hijacking: the inbox owner cannot activate a password someone else chose", async () => {
  const { host } = await store();
  await register(host, "owner@example.com", "attacker chose this");
  const link = lastToken("/account/verify-email");

  // The real owner clicks the link but does not know the attacker's password.
  const attempt = await call(verifyPOST, host, { token: link, password: "owner password!!" }, { ip: freshIp() });
  assert.equal(attempt.status, 400);
  assert.equal(((await attempt.json()) as { code: string }).code, "invalid_password");
  assert.equal((await Customer.findOne({ email: "owner@example.com" }).lean())?.emailVerifiedAt, null);

  // Registering again does not help the attacker or overwrite anything...
  await register(host, "owner@example.com", "owner password!!");
  assert.equal((await call(verifyPOST, host, { token: link, password: "owner password!!" }, { ip: freshIp() })).status, 400);

  // ...the owner takes over through password recovery (proves inbox control).
  await call(forgotPOST, host, { email: "owner@example.com" }, { ip: freshIp() });
  const reset = await call(resetPOST, host, { token: lastToken("/account/reset-password"), password: "owner password!!" }, { ip: freshIp() });
  assert.equal(reset.status, 200);
  assert.equal((await login(host, "owner@example.com", "attacker chose this")).status, 401);
  assert.equal((await login(host, "owner@example.com", "owner password!!")).status, 200);
});

test("the same email at another business is a separate, unrelated account", async () => {
  const a = await store();
  const b = await store();
  await registerVerified(a.host, "shared@example.com", "password at store A");
  await register(b.host, "shared@example.com", "password at store B");

  assert.equal(await Customer.countDocuments({ email: "shared@example.com" }), 2);
  assert.equal((await login(b.host, "shared@example.com", "password at store A")).status, 401);
  assert.equal((await login(a.host, "shared@example.com", "password at store B")).status, 401);
  // B's account is still unverified; A's verification did not carry over.
  assert.equal((await login(b.host, "shared@example.com", "password at store B")).status, 403);
});

test("an inactive account gets the generic response and no email", async () => {
  const { host } = await store();
  await registerVerified(host, "closed@example.com");
  await Customer.updateOne({ email: "closed@example.com" }, { $set: { active: false } });
  clearEmailOutbox();

  const response = await register(host, "closed@example.com");
  assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
  assert.equal(getEmailOutbox().length, 0);
});

test("concurrent registrations of one email create exactly one account and one usable link", async () => {
  const { business, host } = await store();
  const passwords = ["first password 1", "second password 2", "third password 3", "fourth password 4"];
  const responses = await Promise.all(
    passwords.map((password) =>
      call(registerPOST, host, { name: "Racer", email: "race@example.com", password }, { ip: freshIp() }),
    ),
  );
  for (const response of responses) assert.equal(response.status, 202);
  assert.equal(await Customer.countDocuments({ business: business._id, email: "race@example.com" }), 1);
  assert.equal(await usableTokens("email_verification"), 1);

  const mail = emailsTo("race@example.com");
  assert.equal(mail.filter((m) => m.text.includes("verify-email#token=")).length, 1, "one verification link");
  assert.equal(mail.length, passwords.length, "the others get a notice, not a link");

  // Exactly one of the submitted passwords owns the account; the link needs it.
  const token = lastToken("/account/verify-email");
  const results = [];
  for (const password of passwords) {
    results.push((await call(verifyPOST, host, { token, password }, { ip: freshIp() })).status);
  }
  assert.equal(results.filter((status) => status === 200).length, 1);
});

test("registration racing verification stays consistent", async () => {
  const { host } = await store();
  await register(host, "ada@example.com");
  const token = lastToken("/account/verify-email");
  const [verify, ...again] = await Promise.all([
    call(verifyPOST, host, { token, password: PASSWORD }, { ip: freshIp() }),
    ...[1, 2, 3].map((i) => call(registerPOST, host, { name: "Mallory", email: "ada@example.com", password: `other password ${i}` }, { ip: freshIp() })),
  ]);
  assert.equal(verify.status, 200);
  for (const response of again) assert.equal(response.status, 202);
  assert.equal(await Customer.countDocuments(), 1);
  assert.equal((await login(host, "ada@example.com")).status, 200);
});

test("registration validates input and never echoes secrets", async () => {
  const { host } = await store();
  const cases: unknown[] = [
    { name: "A", email: "a@example.com", password: PASSWORD },
    { name: "Ada", email: "not-an-email", password: PASSWORD },
    { name: "Ada", email: "a@example.com", password: "short" },
    { name: "Ada", email: "a@example.com", password: "x".repeat(201) },
    { email: "a@example.com", password: PASSWORD },
  ];
  for (const body of cases) {
    const response = await call(registerPOST, host, body, { ip: freshIp() });
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /correct horse/);
  }
  const malformed = await call(registerPOST, host, "{not json", { ip: freshIp() });
  assert.equal(malformed.status, 400);
  assert.equal(await Customer.countDocuments(), 0);
});

test("customer auth endpoints refuse platform, unknown and ineligible storefront hosts", async () => {
  const hosts = [
    "localhost:3000",
    "nobody.localhost:3000",
    (await store({ status: "draft" })).host,
    (await store({ status: "suspended" })).host,
    (await store({ entitled: false })).host,
  ];
  const body = { name: "Ada", email: "a@example.com", password: PASSWORD, token: "x".repeat(43) };
  for (const host of hosts) {
    for (const handler of [registerPOST, loginPOST, resendPOST, forgotPOST, verifyPOST, resetPOST]) {
      const response = await call(handler, host, body, { ip: freshIp() });
      assert.equal(response.status, 404, `${host}`);
    }
    assert.equal(await me(host), null);
  }
  assert.equal(await Customer.countDocuments(), 0);
  assert.equal(getEmailOutbox().length, 0);
});

test("state-changing endpoints require JSON and reject cross-site origins", async () => {
  const { host, origin } = await store();
  const body = { name: "Ada", email: "a@example.com", password: PASSWORD };

  const form = await call(registerPOST, host, "name=Ada", { contentType: "application/x-www-form-urlencoded", ip: freshIp() });
  assert.equal(form.status, 415);
  const plain = await call(loginPOST, host, JSON.stringify(body), { contentType: "text/plain", ip: freshIp() });
  assert.equal(plain.status, 415);

  const evil = await call(registerPOST, host, body, { origin: "https://evil.example", ip: freshIp() });
  assert.equal(evil.status, 403);
  assert.equal(((await evil.json()) as { code: string }).code, "csrf_failed");
  const otherStore = await call(logoutPOST, host, {}, { origin: "http://other.localhost:3000", ip: freshIp() });
  assert.equal(otherStore.status, 403);

  assert.equal((await call(registerPOST, host, body, { origin, ip: freshIp() })).status, 202);
});

// ---------------------------------------------------------------------------
// Login / logout / session
// ---------------------------------------------------------------------------

test("login: unknown, wrong password and inactive are the same 401; unverified is 403 only with the right password", async () => {
  const { host } = await store();
  await register(host, "pending@example.com");
  await registerVerified(host, "closed@example.com");
  await Customer.updateOne({ email: "closed@example.com" }, { $set: { active: false } });

  const failures = [
    await login(host, "nobody@example.com"),
    await login(host, "pending@example.com", "wrong password!!"),
    await login(host, "closed@example.com"),
  ];
  for (const response of failures) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid email or password", code: "invalid_credentials" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(setCookies(response).length, 0);
  }

  const unverified = await login(host, "pending@example.com");
  assert.equal(unverified.status, 403);
  assert.equal(((await unverified.json()) as { code: string }).code, "customer_email_unverified");
  assert.equal(setCookies(unverified).length, 0, "an unverified account never gets a session");
});

test("login issues only a host-only, httpOnly customer cookie and exposes only safe fields", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");

  const response = await login(host, "ADA@example.com ");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { customer: { name: "Ada Shopper", emailVerified: true } });

  const cookies = setCookies(response);
  assert.equal(cookies.length, 2, "the session plus the known-device marker");
  assert.equal(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`)), false, "no platform session");
  const raw = cookies.find((c) => c.startsWith(`${CUSTOMER_SESSION_COOKIE}=`)) ?? "";
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Path=\//);
  assert.doesNotMatch(raw, /Domain=/i, "host-only cookie");

  const cookie = sessionCookie(response);
  assert.deepEqual(await me(host, cookie), { name: "Ada Shopper", email: "ada@example.com", emailVerified: true });
  assert.equal(await me(host), null, "signed out without a cookie");
});

test("a customer session is bound to its storefront", async () => {
  const a = await store();
  const b = await store();
  await registerVerified(a.host, "ada@example.com");
  const cookie = sessionCookie(await login(a.host, "ada@example.com"));

  assert.ok(await me(a.host, cookie));
  assert.equal(await me(b.host, cookie), null, "cookie from store A is not accepted at store B");
  assert.equal((await login(b.host, "ada@example.com")).status, 401, "no account at store B");
});

test("logout revokes the session server-side and clears the cookie", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const cookie = sessionCookie(await login(host, "ada@example.com"));
  const second = sessionCookie(await login(host, "ada@example.com"));

  const response = await call(logoutPOST, host, {}, { cookie });
  assert.equal(response.status, 200);
  const cleared = setCookies(response).find((c) => c.startsWith(`${CUSTOMER_SESSION_COOKIE}=`));
  assert.ok(cleared && /Max-Age=0/i.test(cleared));

  assert.equal(await me(host, cookie), null, "a copied cookie stops working");
  assert.equal(await me(host, second), null, "logout ends every session of the account");
  assert.equal((await call(logoutPOST, host, {})).status, 200, "logout without a session is harmless");
});

test("customer credentials and cookies never authenticate on the platform", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const cookie = sessionCookie(await login(host, "ada@example.com"));

  const platform = await call(platformLoginPOST, "localhost:3000", { email: "ada@example.com", password: PASSWORD }, { ip: freshIp() });
  assert.equal(platform.status, 401);
  assert.equal(await User.countDocuments({ email: "ada@example.com" }), 0);

  // A platform user with the same email is unaffected, and a platform session
  // is not a customer session.
  await createUser({ email: "ada@example.com", password: PASSWORD });
  const platformOk = await call(platformLoginPOST, "localhost:3000", { email: "ada@example.com", password: PASSWORD }, { ip: freshIp() });
  // Platform login is email and password only: the platform account signs in.
  assert.equal(platformOk.status, 200);
  assert.equal(await me(host, `${SESSION_COOKIE}=anything`), null);
  assert.ok(await me(host, cookie), "customer session unaffected by platform login");
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

test("verification tokens are stored hashed, single use, and a wrong password does not spend them", async () => {
  const { host } = await store();
  await register(host, "ada@example.com");
  const token = lastToken("/account/verify-email");

  const stored = await CustomerActionToken.find().select("+tokenHash").lean();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, crypto.createHash("sha256").update(token).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(token), "raw token never persisted");

  const wrong = await call(verifyPOST, host, { token, password: "not my password" }, { ip: freshIp() });
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { code: string }).code, "invalid_password");

  const ok = await call(verifyPOST, host, { token, password: PASSWORD }, { ip: freshIp() });
  assert.equal(ok.status, 200);
  assert.doesNotMatch(JSON.stringify(await ok.json()), new RegExp(token));
  assert.equal(setCookies(ok).length, 0, "verification does not sign in");
  assert.ok((await Customer.findOne().lean())?.emailVerifiedAt instanceof Date);

  const reused = await call(verifyPOST, host, { token, password: PASSWORD }, { ip: freshIp() });
  assert.equal(reused.status, 400);
  assert.equal(((await reused.json()) as { code: string }).code, "invalid_token");
});

test("expired, malformed and other-business verification tokens are rejected identically", async () => {
  const a = await store();
  const b = await store();
  await register(a.host, "ada@example.com");
  const token = lastToken("/account/verify-email");

  const crossBusiness = await call(verifyPOST, b.host, { token, password: PASSWORD }, { ip: freshIp() });
  assert.equal(crossBusiness.status, 400);
  for (const bad of ["short", "x".repeat(43), `${token}!`]) {
    const response = await call(verifyPOST, a.host, { token: bad, password: PASSWORD }, { ip: freshIp() });
    assert.equal(response.status, 400);
  }

  await CustomerActionToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call(verifyPOST, a.host, { token, password: PASSWORD }, { ip: freshIp() });
  assert.equal(expired.status, 400);
  assert.deepEqual(await expired.json(), {
    error: "This link is invalid or has expired. Request a new one.",
    code: "invalid_token",
  });
  assert.equal((await Customer.findOne().lean())?.emailVerifiedAt, null);
});

test("concurrent verification attempts succeed exactly once", async () => {
  const { host } = await store();
  await register(host, "ada@example.com");
  const token = lastToken("/account/verify-email");
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => call(verifyPOST, host, { token, password: PASSWORD }, { ip: freshIp() })),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal(responses.filter((r) => r.status === 400).length, 4);
});

test("resend is generic, emails only unverified accounts, and supersedes the old link", async () => {
  const { host } = await store();
  await registerVerified(host, "done@example.com");
  await register(host, "pending@example.com");
  const first = lastToken("/account/verify-email", "pending@example.com");
  clearEmailOutbox();

  for (const email of ["nobody@example.com", "done@example.com"]) {
    const response = await call(resendPOST, host, { email }, { ip: freshIp() });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
  }
  assert.equal(getEmailOutbox().length, 0);

  const response = await call(resendPOST, host, { email: "Pending@Example.com" }, { ip: freshIp() });
  assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
  const second = lastToken("/account/verify-email", "pending@example.com");
  assert.equal((await call(verifyPOST, host, { token: first, password: PASSWORD }, { ip: freshIp() })).status, 400);
  assert.equal((await call(verifyPOST, host, { token: second, password: PASSWORD }, { ip: freshIp() })).status, 200);
});

// ---------------------------------------------------------------------------
// Password recovery
// ---------------------------------------------------------------------------

test("forgot password is generic and emails a storefront reset link only for real accounts", async () => {
  const { host, origin } = await store();
  await registerVerified(host, "ada@example.com");
  clearEmailOutbox();

  const unknown = await call(forgotPOST, host, { email: "nobody@example.com" }, { ip: freshIp() });
  const known = await call(forgotPOST, host, { email: "ADA@example.com" }, { ip: freshIp() });
  assert.equal(unknown.status, 202);
  assert.equal(known.status, 202);
  assert.deepEqual(await unknown.json(), await known.json());

  const outbox = getEmailOutbox();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, "ada@example.com");
  assert.ok(outbox[0].text.includes(`${origin}/account/reset-password#token=`));
});

test("reset changes the password, revokes every session and kills every other link", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const cookie = sessionCookie(await login(host, "ada@example.com"));
  const otherDevice = sessionCookie(await login(host, "ada@example.com"));

  await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() });
  const older = lastToken("/account/reset-password");
  await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() });
  const token = lastToken("/account/reset-password");
  assert.equal((await call(resetPOST, host, { token: older, password: "brand new pass" }, { ip: freshIp() })).status, 400);

  const response = await call(resetPOST, host, { token, password: "brand new pass" }, { ip: freshIp() });
  assert.equal(response.status, 200);
  assert.equal(
    setCookies(response).some((c) => c.startsWith(`${CUSTOMER_SESSION_COOKIE}=`)),
    false,
    "reset does not sign in (it only marks this browser as a known device)",
  );

  assert.equal(await me(host, cookie), null, "existing session revoked");
  assert.equal(await me(host, otherDevice), null, "every session revoked");
  assert.equal((await login(host, "ada@example.com")).status, 401, "old password rejected");
  assert.equal((await login(host, "ada@example.com", "brand new pass")).status, 200);

  const reused = await call(resetPOST, host, { token, password: "another new pass" }, { ip: freshIp() });
  assert.equal(reused.status, 400);
  assert.equal(await CustomerActionToken.countDocuments({ usedAt: null }), 0);
});

test("reset rejects expired, other-business and inactive-account tokens", async () => {
  const a = await store();
  const b = await store();
  await registerVerified(a.host, "ada@example.com");
  await call(forgotPOST, a.host, { email: "ada@example.com" }, { ip: freshIp() });
  const token = lastToken("/account/reset-password");

  assert.equal((await call(resetPOST, b.host, { token, password: "brand new pass" }, { ip: freshIp() })).status, 400);

  await Customer.updateOne({ email: "ada@example.com" }, { $set: { active: false } });
  assert.equal((await call(resetPOST, a.host, { token, password: "brand new pass" }, { ip: freshIp() })).status, 400);
  await Customer.updateOne({ email: "ada@example.com" }, { $set: { active: true } });
  assert.equal(await CustomerActionToken.countDocuments({ usedAt: null }), 1, "rolled back, not spent");

  await CustomerActionToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call(resetPOST, a.host, { token, password: "brand new pass" }, { ip: freshIp() })).status, 400);
  assert.equal((await login(a.host, "ada@example.com")).status, 200, "password unchanged");
});

test("reset proves inbox control, so it verifies an unverified email", async () => {
  const { host } = await store();
  await register(host, "ada@example.com");
  await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() });
  const response = await call(resetPOST, host, { token: lastToken("/account/reset-password"), password: "brand new pass" }, { ip: freshIp() });
  assert.equal(response.status, 200);
  assert.equal((await login(host, "ada@example.com", "brand new pass")).status, 200);
});

// ---------------------------------------------------------------------------
// Regressions
// ---------------------------------------------------------------------------

test("a business-created page can no longer claim the reserved account slug", async () => {
  const { pageSlugSchema } = await import("@/lib/validation");
  for (const slug of ["account", "Account", " account "]) {
    assert.equal(pageSlugSchema.safeParse(slug).success, false, slug);
  }
  // The storefront stays published and unaffected by account activity.
  const { business, host } = await store();
  await registerVerified(host, "ada@example.com");
  assert.equal((await Business.findById(business._id).lean())?.status, "published");
});
