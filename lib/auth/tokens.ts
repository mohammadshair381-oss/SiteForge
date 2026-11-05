import { SignJWT, jwtVerify } from "jose";
import { env } from "../env";
import type { PlatformRole } from "../constants";

const ALG = "HS256";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionClaims {
  userId: string;
  platformRole: PlatformRole;
  /** Must match the user's current tokenVersion or the session is rejected. */
  tokenVersion: number;
}

function getKey(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getKey());
}

export async function verifySession(
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getKey(), { algorithms: [ALG] });
    if (typeof payload.userId !== "string") return null;
    const platformRole = payload.platformRole === "super_admin" ? "super_admin" : "user";
    // Tokens issued before revocation existed have no version; treat them as 0
    // so they keep working until the account's password changes.
    const tokenVersion =
      typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0;
    return { userId: payload.userId, platformRole, tokenVersion };
  } catch {
    return null;
  }
}
