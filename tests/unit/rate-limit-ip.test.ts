import "../helpers/env";

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { HttpError } from "../../lib/api";
import { getClientIp } from "../../lib/rate-limit";

// lib/env.ts caches its parsed configuration on the first env() call, and
// getClientIp() reads env().TRUSTED_IP_HEADER. This file must therefore set the
// trusted header BEFORE any getClientIp() call (env() is first invoked inside
// getClientIp, never at import time). isProduction() reads process.env.NODE_ENV
// live, so it can be toggled per test.
const originalTrustedHeader = process.env.TRUSTED_IP_HEADER;
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string): void {
  (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
}

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/", { headers });
}

before(() => {
  process.env.TRUSTED_IP_HEADER = "x-forwarded-for";
});

after(() => {
  if (originalTrustedHeader === undefined) delete process.env.TRUSTED_IP_HEADER;
  else process.env.TRUSTED_IP_HEADER = originalTrustedHeader;
  if (originalNodeEnv === undefined) {
    delete (process.env as unknown as Record<string, string | undefined>).NODE_ENV;
  } else {
    setNodeEnv(originalNodeEnv);
  }
});

beforeEach(() => {
  setNodeEnv("test");
});

test("uses the right-most X-Forwarded-For entry, not the spoofable left-most", () => {
  const request = requestWithHeaders({
    "x-forwarded-for": "203.0.113.7, 198.51.100.9, 10.0.0.1",
  });
  assert.equal(getClientIp(request), "10.0.0.1");
});

test("ignores blank X-Forwarded-For segments", () => {
  const request = requestWithHeaders({
    "x-forwarded-for": "  203.0.113.7 ,  , 198.51.100.9 ",
  });
  assert.equal(getClientIp(request), "198.51.100.9");
});

test("returns the shared bucket when the trusted header is absent outside production", () => {
  assert.equal(getClientIp(requestWithHeaders({})), "unknown");
});

test("returns the shared bucket for an empty trusted header outside production", () => {
  assert.equal(getClientIp(requestWithHeaders({ "x-forwarded-for": "   " })), "unknown");
});

test("fails closed in production when the trusted header is absent", () => {
  setNodeEnv("production");
  assert.throws(
    () => getClientIp(requestWithHeaders({})),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "rate_limit_misconfigured");
      return true;
    },
  );
});

test("fails closed in production when the header is present but blank", () => {
  setNodeEnv("production");
  assert.throws(
    () => getClientIp(requestWithHeaders({ "x-forwarded-for": " , " })),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "rate_limit_misconfigured");
      return true;
    },
  );
});

test("still resolves the client in production when the header is present", () => {
  setNodeEnv("production");
  assert.equal(
    getClientIp(requestWithHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    "10.0.0.1",
  );
});
