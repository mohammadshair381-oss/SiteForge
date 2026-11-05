import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import {
  PASSWORD,
  call,
  emailsTo,
  freshIp,
  lastToken,
  login,
  register,
  registerVerified,
  sessionCookie,
  setCookies,
  store,
  waitForSafeRateLimitWindow,
  type Handler,
} from "./helpers/customer-accounts";
import { POST as registerPOST } from "@/app/api/storefront/account/register/route";
import { POST as loginPOST } from "@/app/api/storefront/account/login/route";
import { POST as logoutPOST } from "@/app/api/storefront/account/logout/route";
import { GET as meGET } from "@/app/api/storefront/account/me/route";
import { POST as verifyPOST } from "@/app/api/storefront/account/email/verify/route";
import { POST as resendPOST } from "@/app/api/storefront/account/email/resend/route";
import { POST as forgotPOST } from "@/app/api/storefront/account/password/forgot/route";
import { POST as resetPOST } from "@/app/api/storefront/account/password/reset/route";
import {
  drainAfterResponseTasks,
  holdAfterResponseTasks,
  releaseAfterResponseTasks,
} from "@/lib/after-response";
import { HttpError } from "@/lib/api";
import { CUSTOMER_AUTH_GENERIC_MESSAGE } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { consumeCustomerToken, issueCustomerToken } from "@/lib/auth/customer-tokens";
import {
  EmailConfigurationError,
  EmailSendError,
  clearEmailOutbox,
  getEmailOutbox,
  setMemoryEmailFailure,
} from "@/lib/email";
import { consumeRateLimit, releaseRateLimit } from "@/lib/rate-limit";
import { Customer } from "@/models/Customer";
import { CustomerActionToken } from "@/models/CustomerActionToken";
import { RateLimit } from "@/models/RateLimit";

/**
 * Phase 3A hardening: feature gate, after-response email work, email failure
 * observability, rate-limit abuse resistance, token-issuance races and
 * no-store error responses. In-memory replica set only.
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
  setMemoryEmailFailure(null);
  clearRequestCookies();
  await releaseAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  setMemoryEmailFailure(null);
  clearRequestCookies();
  await releaseAfterResponseTasks();
  await drainAfterResponseTasks();
  clearEmailOutbox();
  await clearAllCollections();
});

const ALL_ROUTES: Array<[string, Handler, unknown]> = [
  ["register", registerPOST, { name: "Ada", email: "a@example.com", password: PASSWORD }],
  ["login", loginPOST, { email: "a@example.com", password: PASSWORD }],
  ["logout", logoutPOST, {}],
  ["me", meGET, undefined],
  ["verify", verifyPOST, { token: "x".repeat(43), password: PASSWORD }],
  ["resend", resendPOST, { email: "a@example.com" }],
  ["forgot", forgotPOST, { email: "a@example.com" }],
  ["reset", resetPOST, { token: "x".repeat(43), password: PASSWORD }],
];

function captureConsole(method: "error" | "warn") {
  const lines: string[] = [];
  const spy = mock.method(console, method, (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mock.restore() };
}

// ---------------------------------------------------------------------------
// 1. Feature gate
// ---------------------------------------------------------------------------

test("customer accounts are disabled unless CUSTOMER_ACCOUNTS_ENABLED is exactly true", async () => {
  const { host } = await store();
  for (const value of [undefined, "", "false", "1", "TRUE", "yes", " on "]) {
    if (value === undefined) delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
    else process.env.CUSTOMER_ACCOUNTS_ENABLED = value;
    const response = await call(registerPOST, host, { name: "Ada", email: "a@example.com", password: PASSWORD }, { ip: freshIp() });
    assert.equal(response.status, 404, `value ${JSON.stringify(value)}`);
  }
  process.env.CUSTOMER_ACCOUNTS_ENABLED = " true ";
  assert.equal((await call(registerPOST, host, { name: "Ada", email: "a@example.com", password: PASSWORD }, { ip: freshIp() })).status, 202);
});

test("every account route is a side-effect-free 404 while the gate is off", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  const cookie = sessionCookie(await login(host, "ada@example.com"));
  const before = await Customer.findOne().select("tokenVersion emailVerifiedAt").lean();
  const tokensBefore = await CustomerActionToken.countDocuments();
  await RateLimit.deleteMany({});
  clearEmailOutbox();

  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  const disabledBody = { error: "This store is not available", code: "not_found" };
  for (const [name, handler, body] of ALL_ROUTES) {
    const response = await call(handler, host, body, { cookie, ip: freshIp() });
    assert.equal(response.status, 404, name);
    assert.deepEqual(await response.json(), disabledBody, `${name}: same body as an unknown store`);
    assert.equal(response.headers.get("cache-control"), "no-store", name);
    assert.equal(setCookies(response).length, 0, `${name}: no cookie set or cleared`);
  }

  assert.equal(getEmailOutbox().length, 0, "no email");
  assert.equal(await RateLimit.countDocuments(), 0, "gate runs before rate limiting");
  assert.equal(await Customer.countDocuments(), 1, "no account created");
  assert.equal(await CustomerActionToken.countDocuments(), tokensBefore, "no token issued");
  const afterDoc = await Customer.findOne().select("tokenVersion emailVerifiedAt").lean();
  assert.deepEqual(afterDoc, before, "logout did not revoke; nothing changed");

  // The guard itself is gated too (protects future customer routes).
  await assert.rejects(
    requireCustomer(new Request(`http://${host}/x`, { headers: { host, cookie } })),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );

  // Re-enabling restores the untouched session.
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  const meResponse = await call(meGET, host, undefined, { cookie });
  assert.equal(((await meResponse.json()) as { customer: unknown }).customer !== null, true);
});

// ---------------------------------------------------------------------------
// 2. Account-dependent work happens after the response
// ---------------------------------------------------------------------------

test("register, resend and forgot respond before any account lookup, token or email work", async () => {
  const { host } = await store();
  await registerVerified(host, "known@example.com");
  await register(host, "pending@example.com");
  clearEmailOutbox();
  const customersBefore = await Customer.countDocuments();
  const tokensBefore = await CustomerActionToken.countDocuments();

  holdAfterResponseTasks();
  const responses = [
    await call(registerPOST, host, { name: "New", email: "new@example.com", password: PASSWORD }, { ip: freshIp(), drain: false }),
    await call(registerPOST, host, { name: "Again", email: "known@example.com", password: PASSWORD }, { ip: freshIp(), drain: false }),
    await call(resendPOST, host, { email: "pending@example.com" }, { ip: freshIp(), drain: false }),
    await call(resendPOST, host, { email: "nobody@example.com" }, { ip: freshIp(), drain: false }),
    await call(forgotPOST, host, { email: "known@example.com" }, { ip: freshIp(), drain: false }),
    await call(forgotPOST, host, { email: "nobody@example.com" }, { ip: freshIp(), drain: false }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  // Nothing account-dependent has happened yet: the responses did not wait for it.
  assert.equal(getEmailOutbox().length, 0);
  assert.equal(await Customer.countDocuments(), customersBefore);
  assert.equal(await CustomerActionToken.countDocuments(), tokensBefore);

  await releaseAfterResponseTasks();
  assert.equal(await Customer.countDocuments(), customersBefore + 1);
  assert.deepEqual(
    getEmailOutbox().map((m) => m.to).sort(),
    ["known@example.com", "known@example.com", "new@example.com", "pending@example.com"],
  );
});

// ---------------------------------------------------------------------------
// 5. Email delivery failures are observable but never public
// ---------------------------------------------------------------------------

test("an email delivery failure keeps the generic 202 and logs only a safe category", async () => {
  const { host } = await store();
  const consoleError = captureConsole("error");
  try {
    setMemoryEmailFailure(new EmailSendError("provider said: secret detail for victim@example.com", "memory", 503));
    const response = await register(host, "victim@example.com");
    assert.deepEqual(await response.json(), { message: CUSTOMER_AUTH_GENERIC_MESSAGE });

    setMemoryEmailFailure(new EmailConfigurationError("EMAIL_API_KEY is missing"));
    await call(forgotPOST, host, { email: "victim@example.com" }, { ip: freshIp() });
  } finally {
    consoleError.restore();
    setMemoryEmailFailure(null);
  }

  const lines = consoleError.lines.join("\n");
  assert.match(lines, /\[customer-auth\] event=email_delivery_failed operation=verification category=email_provider_unavailable/);
  assert.match(lines, /\[customer-auth\] event=email_delivery_failed operation=password-reset category=email_configuration/);
  assert.doesNotMatch(lines, /victim@example\.com|secret detail|EMAIL_API_KEY|token|https?:\/\//);
  assert.equal(getEmailOutbox().length, 0);

  // The account exists; the customer can recover once email works again.
  assert.equal(await Customer.countDocuments(), 1);
  await call(resendPOST, host, { email: "victim@example.com" }, { ip: freshIp() });
  assert.ok(lastToken("/account/verify-email", "victim@example.com"));
});

test("an unexpected database error is a generic 500 that logs a category, not the error", async () => {
  const { host } = await store();
  const consoleError = captureConsole("error");
  const spy = mock.method(Customer, "findOne", () => {
    throw Object.assign(new Error("E11000 dup key: { email: \"leak@example.com\" }"), { name: "MongoServerError" });
  });
  try {
    const response = await login(host, "leak@example.com");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Internal server error", code: "internal_error" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    spy.mock.restore();
    consoleError.restore();
  }
  const lines = consoleError.lines.join("\n");
  assert.match(lines, /event=request_failed category=database/);
  assert.doesNotMatch(lines, /leak@example\.com/);
});

// ---------------------------------------------------------------------------
// 7. Error responses are never cacheable
// ---------------------------------------------------------------------------

test("every customer-auth error response carries Cache-Control: no-store", async () => {
  const { host } = await store();
  const responses: Array<[number, Response]> = [
    [404, await call(registerPOST, "nobody.localhost:3000", { email: "a@b.co" }, { ip: freshIp() })],
    [415, await call(loginPOST, host, "x", { contentType: "text/plain", ip: freshIp() })],
    [403, await call(loginPOST, host, {}, { origin: "https://evil.example", ip: freshIp() })],
    [400, await call(loginPOST, host, "{bad", { ip: freshIp() })],
    [422, await call(loginPOST, host, { email: "nope" }, { ip: freshIp() })],
    [401, await login(host, "nobody@example.com")],
    [400, await call(resetPOST, host, { token: "x".repeat(43), password: PASSWORD }, { ip: freshIp() })],
  ];
  for (const [status, response] of responses) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store", `status ${status}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Token issuance races
// ---------------------------------------------------------------------------

test("concurrent token issuance leaves exactly one usable token, and only it can be consumed", async () => {
  const { business, host } = await store();
  await register(host, "ada@example.com");
  const customer = await Customer.findOne().lean();
  assert.ok(customer);

  const issued = await Promise.all(
    Array.from({ length: 6 }, () =>
      issueCustomerToken({ businessId: business._id, customerId: customer._id, type: "password_reset", ttlMs: 60_000 }),
    ),
  );
  assert.ok(issued.every(Boolean));
  assert.equal(await CustomerActionToken.countDocuments({ type: "password_reset", usedAt: null }), 1);

  const consumed = await Promise.all(
    issued.map((token) => consumeCustomerToken({ businessId: business._id, rawToken: token!.rawToken, type: "password_reset" })),
  );
  assert.equal(consumed.filter(Boolean).length, 1, "exactly one token was still usable");
  // Other types are independent: the verification token from registration survives.
  assert.equal(await CustomerActionToken.countDocuments({ type: "email_verification", usedAt: null }), 1);
});

test("concurrent resend requests leave one usable link; issuance refuses inactive accounts", async () => {
  const { business, host } = await store();
  await register(host, "ada@example.com");
  await Promise.all(
    Array.from({ length: 3 }, () => call(resendPOST, host, { email: "ada@example.com" }, { ip: freshIp() })),
  );
  assert.equal(await CustomerActionToken.countDocuments({ type: "email_verification", usedAt: null }), 1);
  // Email order need not match commit order, so try every emailed link.
  const links = emailsTo("ada@example.com").map((m) => /verify-email#token=([A-Za-z0-9_-]+)/.exec(m.text)?.[1]);
  assert.equal(links.length, 4, "registration + 3 resends were emailed");
  const statuses = [];
  for (const token of links) {
    statuses.push((await call(verifyPOST, host, { token, password: PASSWORD }, { ip: freshIp() })).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, 1, "exactly one link still worked");

  await Customer.updateOne({}, { $set: { active: false } });
  const customer = await Customer.findOne().lean();
  const issued = await issueCustomerToken({ businessId: business._id, customerId: customer!._id, type: "password_reset", ttlMs: 60_000 });
  assert.equal(issued, null);
});

// ---------------------------------------------------------------------------
// 4. Rate limits
// ---------------------------------------------------------------------------

test("failed logins from one IP lock only that IP for that account", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  const attacker = freshIp();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login(host, "ada@example.com", "wrong password!!", attacker)).status, 401);
  }
  const blocked = await login(host, "ada@example.com", PASSWORD, attacker);
  assert.equal(blocked.status, 429, "even the right password is refused from the exhausted source");
  assert.ok(blocked.headers.get("retry-after"));
  assert.equal(blocked.headers.get("cache-control"), "no-store");

  // The legitimate customer, from their own IP, is unaffected.
  assert.equal((await login(host, "ada@example.com", PASSWORD, freshIp())).status, 200);
});

test("successful logins do not consume the failure budget", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  const ip = freshIp();
  for (let i = 0; i < 8; i += 1) {
    assert.equal((await login(host, "ada@example.com", PASSWORD, ip)).status, 200);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await login(host, "ada@example.com", "wrong password!!", ip)).status, 401);
  }
  assert.equal((await login(host, "ada@example.com", "wrong password!!", ip)).status, 429);
});

test("parallel guesses from one IP cannot overshoot or spend the account-wide budget", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  const attacker = freshIp();
  const statuses = (
    await Promise.all(Array.from({ length: 12 }, () => login(host, "ada@example.com", "wrong password!!", attacker)))
  ).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 401).length, 5);
  assert.equal(statuses.filter((s) => s === 429).length, 7);
  assert.equal((await login(host, "ada@example.com", PASSWORD, freshIp())).status, 200);
});

test("distributed guessing hits the account-wide cap (a temporary, window-bounded lock)", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  // 10 sources x 5 failures = the 50-failure account-wide budget.
  for (let source = 0; source < 10; source += 1) {
    const ip = freshIp();
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await login(host, "ada@example.com", "wrong password!!", ip)).status, 401);
    }
  }
  const fresh = await login(host, "ada@example.com", "wrong password!!", freshIp());
  assert.equal(fresh.status, 429, "new sources are refused once the account-wide budget is spent");
  const retryAfter = Number(fresh.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 3600, "the lock ends with the window");
  // Documented trade-off: the owner is also refused until the window ends.
  assert.equal((await login(host, "ada@example.com", PASSWORD, freshIp())).status, 429);
  // Other accounts at the store are unaffected.
  assert.equal((await login(host, "other@example.com", "wrong password!!", freshIp())).status, 401);
});

test("registration abuse: per (email, IP) limit, and emails to one address are capped silently", async () => {
  const { host } = await store();
  await waitForSafeRateLimitWindow();
  const ipA = freshIp();
  for (let i = 0; i < 5; i += 1) await register(host, "target@example.com", PASSWORD, "Ada", ipA);
  const blocked = await call(registerPOST, host, { name: "Ada", email: "target@example.com", password: PASSWORD }, { ip: ipA });
  assert.equal(blocked.status, 429);

  const consoleWarn = captureConsole("warn");
  try {
    // Another source is not blocked by A's bucket...
    for (let i = 0; i < 3; i += 1) await register(host, "target@example.com", PASSWORD, "Ada", freshIp());
  } finally {
    consoleWarn.restore();
  }
  // ...but the address receives at most 5 registration emails per hour.
  assert.equal(emailsTo("target@example.com").length, 5);
  assert.match(consoleWarn.lines.join("\n"), /event=email_suppressed operation=register reason=address_rate_limited/);
  assert.doesNotMatch(consoleWarn.lines.join("\n"), /target@example\.com/);
  assert.equal(await Customer.countDocuments(), 1);
});

test("resend and forgot share one per-IP bucket", async () => {
  const { host } = await store();
  await waitForSafeRateLimitWindow();
  const ip = freshIp();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call(resendPOST, host, { email: `r${i}@example.com` }, { ip })).status, 202);
    assert.equal((await call(forgotPOST, host, { email: `f${i}@example.com` }, { ip })).status, 202);
  }
  assert.equal((await call(resendPOST, host, { email: "r9@example.com" }, { ip })).status, 429);
  assert.equal((await call(forgotPOST, host, { email: "f9@example.com" }, { ip })).status, 429);
  assert.equal((await call(forgotPOST, host, { email: "f9@example.com" }, { ip: freshIp() })).status, 202);
});

test("forgot-password flooding cannot lock the owner out of recovery", async () => {
  const { host } = await store();
  await registerVerified(host, "ada@example.com");
  await waitForSafeRateLimitWindow();
  clearEmailOutbox();
  // Attackers on three sources trigger the 3-per-hour address cap.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() })).status, 202);
  }
  const lastLink = lastToken("/account/reset-password", "ada@example.com");
  // More requests (attacker or owner) still get the generic 202 instead of an
  // error, send nothing and, crucially, do not invalidate the latest link.
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(forgotPOST, host, { email: "ada@example.com" }, { ip: freshIp() })).status, 202);
  }
  assert.equal(emailsTo("ada@example.com").length, 3);
  const reset = await call(resetPOST, host, { token: lastLink, password: "brand new pass" }, { ip: freshIp() });
  assert.equal(reset.status, 200);
});

test("verify and reset submissions are limited per IP", async () => {
  const { host } = await store();
  await waitForSafeRateLimitWindow();
  const ip = "192.0.2.99";
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await call(resetPOST, host, { token: "x".repeat(43), password: "brand new pass" }, { ip })).status, 400);
  }
  assert.equal((await call(resetPOST, host, { token: "x".repeat(43), password: "brand new pass" }, { ip })).status, 429);
  assert.equal((await call(verifyPOST, host, { token: "x".repeat(43), password: PASSWORD }, { ip: freshIp() })).status, 400);
});

test("fixed windows reset at the boundary and allow at most one extra burst across it", async () => {
  const windowMs = 2000;
  const key = `boundary-${Date.now()}`;
  const waitUntil = async (predicate: (offset: number) => boolean) => {
    while (!predicate(Date.now() % windowMs)) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  // Late in a window: use the whole budget.
  await waitUntil((offset) => offset > 1500 && offset < 1700);
  assert.equal((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
  assert.equal((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
  const denied = await consumeRateLimit({ key, limit: 2, windowMs });
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 500);

  // Right after the boundary the budget is fresh: up to 2x the limit can pass
  // within a short span. This is the documented fixed-window trade-off.
  await waitUntil((offset) => offset < 300);
  assert.equal((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, true);
  const second = await consumeRateLimit({ key, limit: 2, windowMs });
  assert.equal(second.allowed, true);
  assert.equal((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, false);

  // Releasing gives back exactly one unit and never goes negative.
  await releaseRateLimit(second.bucketKey);
  assert.equal((await consumeRateLimit({ key, limit: 2, windowMs })).allowed, false, "the denied attempt still counts");
  for (let i = 0; i < 5; i += 1) await releaseRateLimit(second.bucketKey);
  const counter = await RateLimit.findOne({ key: second.bucketKey }).lean();
  assert.equal(counter?.count, 0);
});
