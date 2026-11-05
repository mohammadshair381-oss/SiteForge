import crypto from "node:crypto";
import type { NextResponse } from "next/server";

import { isProduction } from "@/lib/env";

export const ORDER_ACCESS_COOKIE = "order-access";

/**
 * Guest ownership-proof lifetime/recovery policy for this phase:
 * - The raw proof is returned at creation and stored in a host-only HttpOnly
 *   cookie for 30 days. Only its SHA-256 digest is persisted.
 * - No server-side proof-expiry field exists and this phase may not change the
 *   schema. The proof therefore remains valid until it is rotated; applying an
 *   invented createdAt-based cutoff would silently break existing keyed replay
 *   contracts. A cookie-authenticated replay can rotate it, and rotation
 *   invalidates the previous proof.
 * - There is no cross-device recovery flow in this phase. A guest must retain
 *   the proof cookie or the raw proof returned by the creation request.
 */
export const ORDER_ACCESS_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const MAX_PROOF_LENGTH = 512;

/** Generate a 256-bit guest ownership proof (43-char base64url). */
export function generateOrderProof(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 hex digest persisted at rest. */
export function hashOrderProof(proof: string): string {
  return crypto.createHash("sha256").update(proof, "utf8").digest("hex");
}

/** Timing-safe comparison of a presented proof against the stored digest. */
export function orderProofMatches(
  providedProof: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!providedProof || !storedHash) return false;
  if (!/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const provided = Buffer.from(hashOrderProof(providedProof), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (provided.length !== stored.length) return false;
  return crypto.timingSafeEqual(provided, stored);
}

export function orderProofMatchesAny(
  providedProofs: Array<string | null | undefined>,
  storedHash: string | null | undefined,
): boolean {
  return providedProofs.some((proof) => orderProofMatches(proof, storedHash));
}

/** Read the order-access cookie without trusting any other cookie as proof. */
export function readOrderAccessCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)order-access=([^;]+)/);
  return match && match[1] ? match[1] : null;
}

/**
 * Return every proof transport the request actually carries. The header is
 * preferred for API clients; the HttpOnly cookie is the browser transport.
 * Proofs are never accepted from query parameters.
 */
export function readOrderProofCandidates(request: Request): string[] {
  const candidates = [
    request.headers.get("x-order-proof")?.trim() || null,
    readOrderAccessCookie(request),
  ].filter(
    (value): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_PROOF_LENGTH,
  );

  return [...new Set(candidates)];
}

/** Append a host-only order-access cookie without overwriting other cookies. */
export function appendOrderAccessCookie(
  response: NextResponse,
  proof: string,
): NextResponse {
  const secure = isProduction() ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${ORDER_ACCESS_COOKIE}=${proof}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${ORDER_ACCESS_MAX_AGE_SECONDS}`,
  );
  return response;
}
