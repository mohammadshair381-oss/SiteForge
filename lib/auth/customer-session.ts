import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import { env, isProduction } from "../env";

/**
 * Storefront CUSTOMER sessions. Completely separate from platform-user
 * sessions (`lib/auth/session.ts`, cookie `swb_session`):
 *
 * - Different cookie: `sf_customer`, host-only (no Domain attribute), so it is
 *   only ever sent to the storefront host that set it.
 * - Different signing key: derived from SESSION_SECRET with HKDF-SHA256 and a
 *   customer-specific `info` label. The platform signs with the raw secret, so
 *   a token from one system can never verify in the other.
 * - Different claims: `aud`, `iss` and `typ` identify a customer token; the
 *   subject is a Customer id (never a User id) and `bid` is the business the
 *   account belongs to. There is no role claim at all.
 *
 * Server-only (Node runtime): uses `node:crypto`. Never import from
 * middleware or client components. Callers decide authorization through
 * `lib/auth/customer-guards.ts`.
 */

/** Cookie name outside production (plain http on *.localhost is allowed). */
export const CUSTOMER_SESSION_COOKIE = "sf_customer";
/**
 * Cookie name in production. The `__Host-` prefix makes browsers accept the
 * cookie only when it is Secure, Path=/ and has NO Domain attribute, so a
 * sibling tenant subdomain can never plant or overwrite it ("cookie tossing").
 */
export const CUSTOMER_SESSION_COOKIE_PRODUCTION = "__Host-sf_customer";

/** The customer session cookie name for the current environment. */
export function customerSessionCookieName(): string {
  return isProduction() ? CUSTOMER_SESSION_COOKIE_PRODUCTION : CUSTOMER_SESSION_COOKIE;
}
export const CUSTOMER_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

const ALG = "HS256";
const ISSUER = "siteforge";
const AUDIENCE = "siteforge:customer";
const TOKEN_TYPE = "customer";
const KEY_INFO = "siteforge:customer-session:v1";
const MAX_TOKEN_LENGTH = 2048;

export interface CustomerSessionClaims {
  /** Customer document id. */
  customerId: string;
  /** Business the customer account belongs to. */
  businessId: string;
  /** Must equal the customer's current tokenVersion. */
  tokenVersion: number;
}

let cachedKey: { secret: string; key: Uint8Array } | null = null;

/** HKDF-derived key, domain-separated from the platform session key. */
function customerKey(): Uint8Array {
  const secret = env().SESSION_SECRET;
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = new Uint8Array(
    crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from(KEY_INFO, "utf8"), 32),
  );
  cachedKey = { secret, key };
  return key;
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export async function signCustomerSession(
  claims: CustomerSessionClaims,
  options: { expiresAt?: Date } = {},
): Promise<string> {
  if (!OBJECT_ID.test(claims.customerId) || !OBJECT_ID.test(claims.businessId)) {
    throw new Error("Invalid customer session claims");
  }
  return new SignJWT({ typ: TOKEN_TYPE, bid: claims.businessId, tv: claims.tokenVersion })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.customerId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(
      options.expiresAt
        ? Math.floor(options.expiresAt.getTime() / 1000)
        : `${CUSTOMER_SESSION_MAX_AGE_SECONDS}s`,
    )
    .sign(customerKey());
}

/**
 * Verifies signature, algorithm, issuer, audience, expiry and token type.
 * Returns null for anything else (never throws).
 */
export async function verifyCustomerSession(
  token: string | null | undefined,
): Promise<CustomerSessionClaims | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, customerKey(), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== TOKEN_TYPE) return null;
    const customerId = payload.sub;
    const businessId = payload.bid;
    const tokenVersion = payload.tv;
    if (typeof customerId !== "string" || !OBJECT_ID.test(customerId)) return null;
    if (typeof businessId !== "string" || !OBJECT_ID.test(businessId)) return null;
    if (typeof tokenVersion !== "number" || !Number.isInteger(tokenVersion) || tokenVersion < 0) {
      return null;
    }
    return { customerId, businessId, tokenVersion };
  } catch {
    return null;
  }
}

/** Reads the customer session cookie from a request (never the platform cookie). */
export function readCustomerSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie") || "";
  const expected = customerSessionCookieName();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === expected) {
      const value = rest.join("=");
      return value || null;
    }
  }
  return null;
}

function cookieAttributes(maxAge: number): string {
  const secure = isProduction() ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

/** Appends a host-only customer session cookie (does not overwrite other cookies). */
export function appendCustomerSessionCookie(response: NextResponse, token: string): NextResponse {
  response.headers.append(
    "Set-Cookie",
    `${customerSessionCookieName()}=${token}; ${cookieAttributes(CUSTOMER_SESSION_MAX_AGE_SECONDS)}`,
  );
  return response;
}

/** Appends an expired customer session cookie (client-side logout). */
export function clearCustomerSessionCookie(response: NextResponse): NextResponse {
  response.headers.append("Set-Cookie", `${customerSessionCookieName()}=; ${cookieAttributes(0)}`);
  return response;
}
