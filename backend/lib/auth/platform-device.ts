import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { NextResponse } from "next/server";
import { env, isProduction } from "../env";

/**
 * Platform "known device" marker (server-only), after the OWASP "device cookies" pattern against
 * account lockout. The platform's counterpart of lib/auth/customer-device.ts, with its own keys,
 * type, audience and cookie, so neither can ever pass as the other.
 *
 * What it is: a signed, httpOnly cookie issued to a browser that has signed in to one platform
 * account with the correct password. It names a random device id and is bound through keyed hashes
 * to the email (which is never in the cookie) and to the account's CURRENT password and trusted-device
 * generation (`User.deviceTrustVersion`), so a password change, or an admin's sign-out-everywhere,
 * deactivation or role change, outdates every older marker. An ordinary logout does not.
 *
 * What it is NOT: a session. No guard reads it, and a login carrying it still needs the correct
 * password. Its effects are in the login route only: that browser uses its own small failure budget
 * instead of the account-wide one, so people guessing from elsewhere cannot lock the owner out of a
 * browser the owner has already used; and, with the right password, it skips the emailed new-device
 * code (lib/auth/login-challenge.ts), which is the only other way a browser gets one. A stolen marker is
 * worth something only together with the password, and only until the password changes. It survives
 * logout on purpose: it is not a session.
 */
export const PLATFORM_DEVICE_COOKIE = "swb_device";
/** `__Host-` in production: Secure, Path=/, no Domain, so a store's subdomain cannot set it. */
export const PLATFORM_DEVICE_COOKIE_PRODUCTION = "__Host-swb_device";
export const PLATFORM_DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

const ALG = "HS256";
const ISSUER = "siteforge";
const AUDIENCE = "siteforge:platform-device";
const TOKEN_TYPE = "platform-device";
/** One HKDF subkey per purpose; none equals the session key or a customer key. */
const SIGNING_KEY_INFO = "siteforge:platform-device:v1";
const ACCOUNT_KEY_INFO = "siteforge:platform-device:account:v1";
const CREDENTIAL_KEY_INFO = "siteforge:platform-device:credential:v1";
const MAX_TOKEN_LENGTH = 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;
/** base64url of an HMAC-SHA256 digest. */
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

const derivedKey = (info: string): Uint8Array =>
  new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(env().SESSION_SECRET, "utf8"), Buffer.alloc(0), Buffer.from(info, "utf8"), 32));

const keyedHash = (info: string, message: string) => crypto.createHmac("sha256", derivedKey(info)).update(message).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const accountHash = (email: string) => keyedHash(ACCOUNT_KEY_INFO, `account:${email}`);

/**
 * Reveals nothing about the password hash, and changes with the password and with the account's
 * trusted-device generation (`User.deviceTrustVersion`). A missing or zero generation gives exactly
 * the fingerprint used before the generation existed, so markers already issued keep working until
 * an admin action raises it. bcrypt hashes contain no ":", so the two forms cannot collide. Never log it.
 */
export function platformCredentialFingerprint(passwordHash: string, deviceTrustVersion?: number | null): string {
  const generation =
    typeof deviceTrustVersion === "number" && Number.isSafeInteger(deviceTrustVersion) && deviceTrustVersion > 0 ? deviceTrustVersion : 0;
  const message = generation > 0 ? `credential:${passwordHash}:trust:${generation}` : `credential:${passwordHash}`;
  return keyedHash(CREDENTIAL_KEY_INFO, message);
}

export const newPlatformDeviceId = () => crypto.randomBytes(16).toString("base64url");

export async function signPlatformDevice(claims: { deviceId: string; email: string; credential: string }): Promise<string> {
  if (!DEVICE_ID.test(claims.deviceId) || !FINGERPRINT.test(claims.credential)) throw new Error("Invalid platform device claims");
  return new SignJWT({ typ: TOKEN_TYPE, ah: accountHash(claims.email), cf: claims.credential })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.deviceId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${PLATFORM_DEVICE_MAX_AGE_SECONDS}s`)
    .sign(derivedKey(SIGNING_KEY_INFO));
}

/**
 * The device id when the marker is valid, belongs to this email AND still matches the account's current
 * password; null for anything else. `currentCredential` (a database read) runs only after every other check
 * has passed, so only for someone already holding a marker issued for this email: it adds no timing
 * difference an outsider could use. Its errors propagate: a database failure is not a bad marker.
 */
export async function verifyPlatformDevice(token: string | null | undefined, expected: { email: string; currentCredential: () => Promise<string | null> }): Promise<{ deviceId: string } | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  let deviceId: string;
  let credential: string;
  try {
    const { payload } = await jwtVerify(token, derivedKey(SIGNING_KEY_INFO), { algorithms: [ALG], issuer: ISSUER, audience: AUDIENCE });
    if (payload.typ !== TOKEN_TYPE || typeof payload.sub !== "string" || !DEVICE_ID.test(payload.sub)) return null;
    if (typeof payload.ah !== "string" || !safeEqual(payload.ah, accountHash(expected.email))) return null;
    if (typeof payload.cf !== "string" || !FINGERPRINT.test(payload.cf)) return null;
    deviceId = payload.sub;
    credential = payload.cf;
  } catch {
    return null;
  }
  const current = await expected.currentCredential();
  return current && safeEqual(credential, current) ? { deviceId } : null;
}

export const platformDeviceCookieName = () => (isProduction() ? PLATFORM_DEVICE_COOKIE_PRODUCTION : PLATFORM_DEVICE_COOKIE);

export function readPlatformDeviceCookie(request: Request): string | null {
  const expected = platformDeviceCookieName();
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === expected) return rest.join("=") || null;
  }
  return null;
}

/** Host-only, httpOnly, SameSite=Strict: only ever needed by the same-origin sign-in POST. */
export function appendPlatformDeviceCookie(response: NextResponse, token: string): NextResponse {
  const secure = isProduction() ? "; Secure" : "";
  response.headers.append("Set-Cookie", `${platformDeviceCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${PLATFORM_DEVICE_MAX_AGE_SECONDS}`);
  return response;
}
