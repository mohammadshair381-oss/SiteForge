import crypto from "node:crypto";
import { env } from "../env";

/**
 * The keyed fingerprint of an account's password hash (server-only). A pending emailed code
 * (lib/auth/login-challenge.ts) keeps the fingerprint seen when it was started, so a password change
 * or a revocation in the meantime cancels it.
 *
 * Known-device markers ("remembered browsers") no longer exist: every login needs an emailed code.
 * `User.deviceTrustVersion` is still part of the fingerprint, so raising it (forced sign-out,
 * deactivation, role changes: lib/admin/user-actions.ts) cancels every pending code of the account.
 */

const CREDENTIAL_KEY_INFO = "siteforge:platform-device:credential:v1";

const derivedKey = (info: string): Uint8Array =>
  new Uint8Array(crypto.hkdfSync("sha256", Buffer.from(env().SESSION_SECRET, "utf8"), Buffer.alloc(0), Buffer.from(info, "utf8"), 32));

const keyedHash = (info: string, message: string) => crypto.createHmac("sha256", derivedKey(info)).update(message).digest("base64url");

/**
 * Keyed fingerprint of a password hash and the account's trusted-device generation. A missing or zero
 * generation gives exactly the fingerprint used before the generation existed (unchanged formula).
 */
export function platformCredentialFingerprint(passwordHash: string, deviceTrustVersion?: number | null): string {
  const generation =
    typeof deviceTrustVersion === "number" && Number.isSafeInteger(deviceTrustVersion) && deviceTrustVersion > 0 ? deviceTrustVersion : 0;
  const message = generation > 0 ? `credential:${passwordHash}:trust:${generation}` : `credential:${passwordHash}`;
  return keyedHash(CREDENTIAL_KEY_INFO, message);
}
