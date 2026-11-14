import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import { env, isProduction } from "../env";

/**
 * Storefront "known device" marker (server-only), after the OWASP "device
 * cookies" pattern against account lockout.
 *
 * What it is: a signed, httpOnly cookie issued to a browser that has PROVEN
 * control of one account at one store (a successful password login, or a
 * successful password reset, which proves inbox control). It names a random
 * device id and is bound through keyed hashes to:
 * - (business, normalised email), so the email itself is never in the cookie;
 * - the account's CURRENT password (`customerCredentialFingerprint`), so any
 *   password change makes every older marker of the account outdated. A
 *   login accepts a marker only while its fingerprint still matches.
 *
 * What it is NOT: authentication. It is never read by `requireCustomer`, it
 * uses its own HKDF keys, type and audience (so it can never verify as a
 * session and vice versa), and a login carrying it still needs the correct
 * password. Its only effect is in `reserveCustomerLoginAttempt`: during an
 * account-wide lock, the holder keeps a SEPARATE failure budget per device
 * instead of being refused, so distributed attackers cannot lock the owner out
 * of a browser the owner has already used. A stolen marker grants only that
 * device's small budget (5 failures per hour) of password guesses, and only
 * until the password changes.
 *
 * It survives logout on purpose (it is not a session); a password reset
 * replaces it on the resetting browser and outdates it everywhere else.
 */

export const CUSTOMER_DEVICE_COOKIE = "sf_device";
/** `__Host-` in production: Secure, Path=/, no Domain (no cookie tossing). */
export const CUSTOMER_DEVICE_COOKIE_PRODUCTION = "__Host-sf_device";
export const CUSTOMER_DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

const ALG = "HS256";
const ISSUER = "siteforge";
const AUDIENCE = "siteforge:customer-device";
const TOKEN_TYPE = "customer-device";
/** One HKDF subkey per purpose; none equals the platform or customer-session key. */
const SIGNING_KEY_INFO = "siteforge:customer-device:v1";
const ACCOUNT_KEY_INFO = "siteforge:customer-device:account:v1";
const CREDENTIAL_KEY_INFO = "siteforge:customer-device:credential:v1";
const MAX_TOKEN_LENGTH = 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** base64url of an HMAC-SHA256 digest. */
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

let keySecret: string | null = null;
const keys = new Map<string, Uint8Array>();

/** HKDF-SHA256(SESSION_SECRET, info) subkey, domain-separated by `info`. */
function derivedKey(info: string): Uint8Array {
  const secret = env().SESSION_SECRET;
  if (keySecret !== secret) {
    keys.clear();
    keySecret = secret;
  }
  let key = keys.get(info);
  if (!key) {
    key = new Uint8Array(
      crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from(info, "utf8"), 32),
    );
    keys.set(info, key);
  }
  return key;
}

function keyedHash(info: string, message: string): string {
  return crypto.createHmac("sha256", derivedKey(info)).update(message).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Keyed hash of (business, email): binds the marker without revealing the email. */
function accountHash(businessId: string, email: string): string {
  return keyedHash(ACCOUNT_KEY_INFO, `account:${businessId}:${email}`);
}

/**
 * Keyed fingerprint (HMAC-SHA256 under its own subkey) of an account's current
 * password hash. It reveals nothing about the hash and cannot be computed
 * without the server secret; it changes whenever the password changes (bcrypt
 * hashes are salted). Server-only: never log it.
 */
export function customerCredentialFingerprint(businessId: string, passwordHash: string): string {
  return keyedHash(CREDENTIAL_KEY_INFO, `credential:${businessId}:${passwordHash}`);
}

export function newCustomerDeviceId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export async function signCustomerDevice(claims: {
  deviceId: string;
  businessId: string;
  email: string;
  /** `customerCredentialFingerprint` of the account's password at issue time. */
  credential: string;
}): Promise<string> {
  if (
    !DEVICE_ID.test(claims.deviceId) ||
    !OBJECT_ID.test(claims.businessId) ||
    !FINGERPRINT.test(claims.credential)
  ) {
    throw new Error("Invalid customer device claims");
  }
  return new SignJWT({
    typ: TOKEN_TYPE,
    bid: claims.businessId,
    ah: accountHash(claims.businessId, claims.email),
    cf: claims.credential,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.deviceId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${CUSTOMER_DEVICE_MAX_AGE_SECONDS}s`)
    .sign(derivedKey(SIGNING_KEY_INFO));
}

/** Signature, algorithm, issuer, audience, type, expiry and (business, email) binding; never throws. */
async function readDeviceClaims(
  token: string | null | undefined,
  expected: { businessId: string; email: string },
): Promise<{ deviceId: string; credential: string } | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  try {
    const { payload } = await jwtVerify(token, derivedKey(SIGNING_KEY_INFO), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== TOKEN_TYPE || payload.bid !== expected.businessId) return null;
    if (typeof payload.sub !== "string" || !DEVICE_ID.test(payload.sub)) return null;
    if (typeof payload.ah !== "string" || !safeEqual(payload.ah, accountHash(expected.businessId, expected.email))) {
      return null;
    }
    if (typeof payload.cf !== "string" || !FINGERPRINT.test(payload.cf)) return null;
    return { deviceId: payload.sub, credential: payload.cf };
  } catch {
    return null;
  }
}

/**
 * Returns the device id when the marker is valid, belongs to exactly this
 * (business, email) AND still matches the account's current password; null for
 * anything else (malformed, forged, expired, other store or account, outdated).
 *
 * `currentCredential` (a database read) runs only after every other check has
 * passed, i.e. only for someone already holding a marker issued for this
 * (store, email). It returns null when there is no usable account. Its errors
 * propagate: an infrastructure failure is not a bad marker.
 */
export async function verifyCustomerDevice(
  token: string | null | undefined,
  expected: { businessId: string; email: string; currentCredential: () => Promise<string | null> },
): Promise<{ deviceId: string } | null> {
  const claims = await readDeviceClaims(token, expected);
  if (!claims) return null;
  const current = await expected.currentCredential();
  if (!current || !safeEqual(claims.credential, current)) return null;
  return { deviceId: claims.deviceId };
}

export function customerDeviceCookieName(): string {
  return isProduction() ? CUSTOMER_DEVICE_COOKIE_PRODUCTION : CUSTOMER_DEVICE_COOKIE;
}

export function readCustomerDeviceCookie(request: Request): string | null {
  const expected = customerDeviceCookieName();
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === expected) return rest.join("=") || null;
  }
  return null;
}

/** Host-only, httpOnly, SameSite=Strict (only ever needed by same-origin POSTs). */
export function appendCustomerDeviceCookie(response: NextResponse, token: string): NextResponse {
  const secure = isProduction() ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${customerDeviceCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${CUSTOMER_DEVICE_MAX_AGE_SECONDS}`,
  );
  return response;
}
