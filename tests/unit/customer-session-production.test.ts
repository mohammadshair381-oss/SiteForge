import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";

import { HttpError } from "../../lib/api";
import { assertSameOriginJsonRequest } from "../../lib/auth/customer-accounts";
import {
  CUSTOMER_DEVICE_COOKIE,
  appendCustomerDeviceCookie,
  customerDeviceCookieName,
  readCustomerDeviceCookie,
} from "../../lib/auth/customer-device";
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_COOKIE_PRODUCTION,
  appendCustomerSessionCookie,
  clearCustomerSessionCookie,
  customerSessionCookieName,
  readCustomerSessionCookie,
} from "../../lib/auth/customer-session";

// Production cookie/origin rules. These helpers read NODE_ENV at call time.
// Self-contained config (safe dummies only); node --test runs each file in its
// own process, so this does not leak into other tests.
process.env.MONGODB_URI = "mongodb://dummy-host:27017/dummy_db";
process.env.SESSION_SECRET = "p".repeat(40);
(process.env as unknown as Record<string, string | undefined>).NODE_ENV = "production";

test("production uses a __Host- cookie: Secure, Path=/, no Domain, httpOnly, SameSite=Lax", () => {
  assert.equal(customerSessionCookieName(), "__Host-sf_customer");
  const set = appendCustomerSessionCookie(NextResponse.json({}), "tok").headers.get("set-cookie") ?? "";
  assert.equal(set, "__Host-sf_customer=tok; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800");
  assert.doesNotMatch(set, /Domain=/i);

  const cleared = clearCustomerSessionCookie(NextResponse.json({})).headers.get("set-cookie") ?? "";
  assert.equal(cleared, "__Host-sf_customer=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
});

test("production reads only the __Host- cookie (a planted plain cookie is ignored)", () => {
  const read = (cookie: string) => readCustomerSessionCookie(new Request("https://shop.example.com/", { headers: { cookie } }));
  assert.equal(read(`${CUSTOMER_SESSION_COOKIE}=planted`), null);
  assert.equal(read(`${CUSTOMER_SESSION_COOKIE}=planted; ${CUSTOMER_SESSION_COOKIE_PRODUCTION}=real`), "real");
});

test("production accepts only an https Origin for the storefront host", () => {
  const request = (origin: string) =>
    new Request("https://shop.example.com/api/storefront/account/login", {
      method: "POST",
      headers: { host: "shop.example.com", origin, "content-type": "application/json" },
    });
  assert.doesNotThrow(() => assertSameOriginJsonRequest(request("https://shop.example.com")));
  for (const origin of ["http://shop.example.com", "https://evil.example", "null"]) {
    assert.throws(
      () => assertSameOriginJsonRequest(request(origin)),
      (error: unknown) => error instanceof HttpError && error.status === 403,
      origin,
    );
  }
});

test("production uses a __Host- device marker: Secure, Path=/, no Domain, SameSite=Strict", () => {
  assert.equal(customerDeviceCookieName(), "__Host-sf_device");
  const set = appendCustomerDeviceCookie(NextResponse.json({}), "dev").headers.get("set-cookie") ?? "";
  assert.equal(set, "__Host-sf_device=dev; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=7776000");
  const read = (cookie: string) => readCustomerDeviceCookie(new Request("https://shop.example.com/", { headers: { cookie } }));
  assert.equal(read(`${CUSTOMER_DEVICE_COOKIE}=planted`), null, "a plain-named marker is ignored in production");
  assert.equal(read(`__Host-sf_device=real`), "real");
});
