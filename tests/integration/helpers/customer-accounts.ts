import assert from "node:assert/strict";

import { createBusinessWithOwner, createPlan, createSubscription } from "./tenant";
import { POST as registerPOST } from "@/app/api/storefront/account/register/route";
import { POST as loginPOST } from "@/app/api/storefront/account/login/route";
import { GET as meGET } from "@/app/api/storefront/account/me/route";
import { POST as verifyPOST } from "@/app/api/storefront/account/email/verify/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { CUSTOMER_DEVICE_COOKIE } from "@/lib/auth/customer-device";
import { CUSTOMER_SESSION_COOKIE } from "@/lib/auth/customer-session";
import { getEmailOutbox } from "@/lib/email";

/**
 * Shared helpers for the storefront customer-account integration suites.
 * Route handlers are invoked directly (outside a Next request scope), so
 * after-response work runs through the tracked fallback in
 * lib/after-response.ts; `call()` waits for it unless `drain: false`.
 */

export const PASSWORD = "correct horse battery";
export type Handler = (request: Request) => Promise<Response>;

export async function store(options: { status?: "draft" | "published" | "suspended"; entitled?: boolean } = {}) {
  const { owner, business } = await createBusinessWithOwner({ status: options.status ?? "published" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, {
    status: options.entitled === false ? "past_due" : "active",
    currentPeriodEnd: null,
  });
  const host = `${business.subdomain}.localhost:3000`;
  return { owner, business, host, origin: `http://${host}` };
}

let ipCounter = 0;
/** A distinct client IP per call (TRUSTED_IP_HEADER is x-forwarded-for in the harness). */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}`;
}

export async function call(
  handler: Handler,
  host: string,
  body?: unknown,
  options: { ip?: string | null; cookie?: string; origin?: string; contentType?: string; drain?: boolean } = {},
): Promise<Response> {
  // `ip: null` omits the trusted header entirely (a missing client address).
  const headers: Record<string, string> = { host };
  if (options.ip !== null) headers["x-forwarded-for"] = options.ip ?? "198.51.100.7";
  if (body !== undefined) headers["content-type"] = options.contentType ?? "application/json";
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  const response = await handler(
    new Request(`http://${host}/api/storefront/account`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  if (options.drain !== false) await drainAfterResponseTasks();
  return response;
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

export function sessionCookie(response: Response): string {
  const raw = setCookies(response).find((c) => c.startsWith(`${CUSTOMER_SESSION_COOKIE}=`));
  assert.ok(raw, "expected a customer session cookie");
  return raw.split(";")[0];
}

/** The known-device marker set by a response, as a `name=value` cookie pair (or null). */
export function deviceCookie(response: Response): string | null {
  const raw = setCookies(response).find((c) => c.startsWith(`${CUSTOMER_DEVICE_COOKIE}=`));
  return raw ? raw.split(";")[0] : null;
}

export function emailsTo(address: string) {
  return getEmailOutbox().filter((m) => m.to === address);
}

export function lastToken(path: "/account/verify-email" | "/account/reset-password", to?: string): string {
  const messages = getEmailOutbox().filter((m) => (!to || m.to === to) && m.text.includes(`${path}#token=`));
  const message = messages[messages.length - 1];
  assert.ok(message, `expected an email with a ${path} link`);
  const match = message.text.match(new RegExp(`${path}#token=([A-Za-z0-9_-]+)`));
  assert.ok(match);
  return match[1];
}

export async function register(host: string, email: string, password = PASSWORD, name = "Ada Shopper", ip = freshIp()) {
  const response = await call(registerPOST, host, { name, email, password }, { ip });
  assert.equal(response.status, 202);
  return response;
}

export async function registerVerified(host: string, email: string, password = PASSWORD) {
  await register(host, email, password);
  const verify = await call(verifyPOST, host, { token: lastToken("/account/verify-email", email), password }, { ip: freshIp() });
  assert.equal(verify.status, 200);
}

export async function login(host: string, email: string, password = PASSWORD, ip = freshIp()) {
  return call(loginPOST, host, { email, password }, { ip });
}

export async function me(host: string, cookie?: string) {
  const response = await call(meGET, host, undefined, { cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return ((await response.json()) as { customer: Record<string, unknown> | null }).customer;
}

const RATE_LIMIT_WINDOWS_MS = [15 * 60 * 1000, 60 * 60 * 1000];
const WINDOW_SAFETY_MARGIN_MS = 45_000;

/** Fixed-window limits: never start a burst right before a window boundary. */
export async function waitForSafeRateLimitWindow(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const shortest = Math.min(...RATE_LIMIT_WINDOWS_MS.map((w) => w - (now % w)));
    if (shortest >= WINDOW_SAFETY_MARGIN_MS) return;
    await new Promise((resolve) => setTimeout(resolve, WINDOW_SAFETY_MARGIN_MS - shortest + 50));
  }
}
