import crypto from "node:crypto";
import { env } from "@/lib/env";
import { getClientIp } from "@/lib/rate-limit";
import { runAfterResponse } from "@/lib/after-response";
import {
  SECURITY_EVENT_RETENTION_DAYS,
  SecurityEvent,
  type SecurityEventReason,
  type SecurityEventScope,
  type SecurityEventType,
} from "@/models/SecurityEvent";

/**
 * Best-effort recording of authentication security events for platform users
 * and storefront customers (server-only). Recording never changes the outcome or the response of the
 * request that triggered it: failures are swallowed and logged with an event
 * name only (no email, IP, password or error message).
 *
 * Emails and client addresses are stored only as keyed HMAC-SHA256 digests
 * (domain-separated from rate-limit keys and JWT signing), so repeated
 * attempts can be grouped without keeping the raw values.
 */

const DIGEST_DOMAIN = "siteforge:security-event:v1";

export function securityDigest(kind: "email" | "source", value: string): string {
  return crypto
    .createHmac("sha256", env().SESSION_SECRET)
    .update(`${DIGEST_DOMAIN}:${kind}:${value}`)
    .digest("hex");
}

function sourceDigestOf(request: Request): string | null {
  try {
    const ip = getClientIp(request);
    return ip && ip !== "unknown" ? securityDigest("source", ip) : null;
  } catch {
    return null;
  }
}

export async function recordSecurityEvent(input: {
  type: SecurityEventType;
  request: Request;
  reason?: SecurityEventReason;
  /** Defaults to "platform". Storefront events must pass the Host-resolved business. */
  scope?: SecurityEventScope;
  userId?: unknown;
  businessId?: unknown;
  customerId?: unknown;
  email?: string;
}): Promise<void> {
  try {
    const now = new Date();
    await SecurityEvent.create({
      type: input.type,
      reason: input.reason ?? null,
      scope: input.scope ?? "platform",
      user: input.userId ?? null,
      business: input.businessId ?? null,
      customer: input.customerId ?? null,
      emailDigest: input.email ? securityDigest("email", input.email.trim().toLowerCase()) : null,
      sourceDigest: sourceDigestOf(input.request),
      expiresAt: new Date(now.getTime() + SECURITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    });
  } catch {
    console.warn("[security] event=security_event_write_failed");
  }
}

/**
 * A revoked customer session can be replayed on every page view, so this is
 * recorded at most once per customer per window in each server instance, and
 * written after the response (it never slows down or changes the request).
 * Instances do not share the throttle, so a few duplicates are possible.
 */
export const REVOKED_SESSION_THROTTLE_MS = 10 * 60 * 1000;
const MAX_THROTTLE_ENTRIES = 5_000;
const revokedSeen = new Map<string, number>();

type RevokedReason = Extract<SecurityEventReason, "token_version_mismatch" | "inactive_account" | "account_missing">;

/** Shared throttle: true when this (scope, account) was not recorded within the window. */
function claimRevokedSlot(key: string, now: number): boolean {
  const last = revokedSeen.get(key);
  if (last !== undefined && now - last < REVOKED_SESSION_THROTTLE_MS) return false;
  if (revokedSeen.size >= MAX_THROTTLE_ENTRIES) revokedSeen.clear();
  revokedSeen.set(key, now);
  return true;
}

export function recordRevokedCustomerSession(input: {
  request: Request;
  businessId: unknown;
  customerId: string;
  reason: RevokedReason;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const key = `storefront:${String(input.businessId)}:${input.customerId}`;
  if (!claimRevokedSlot(key, now)) return false;
  // Only an id that could exist is stored; a forged-but-signed id cannot occur
  // (the token is signed), but stay defensive.
  const customerId = /^[0-9a-f]{24}$/i.test(input.customerId) ? input.customerId : undefined;
  runAfterResponse(
    () =>
      recordSecurityEvent({
        type: "customer_session_revoked",
        scope: "storefront",
        reason: input.reason,
        businessId: input.businessId,
        customerId,
        request: input.request,
      }),
    { operation: "security-event", onError: () => console.warn("[security] event=security_event_write_failed") },
  );
  return true;
}

/**
 * A correctly signed PLATFORM session presented after revocation (sign-out
 * everywhere, role change, password reset, deactivation) or for a removed
 * account. Same throttle and after-response write as customer sessions; the
 * request is rebuilt from the current headers only to derive the source
 * fingerprint. Never changes the 401 the caller returns.
 */
export function recordRevokedPlatformSession(input: { userId: string; reason: RevokedReason; requestHeaders?: Headers | null; now?: number }): boolean {
  const now = input.now ?? Date.now();
  if (!claimRevokedSlot(`platform:${input.userId}`, now)) return false;
  const userId = /^[0-9a-f]{24}$/i.test(input.userId) ? input.userId : undefined;
  const request = new Request("http://platform.invalid/", { headers: input.requestHeaders ?? undefined });
  runAfterResponse(
    () =>
      recordSecurityEvent({
        type: "platform_session_revoked",
        reason: input.reason,
        userId,
        request,
      }),
    { operation: "security-event", onError: () => console.warn("[security] event=security_event_write_failed") },
  );
  return true;
}

/** Test hook: forget the revoked-session throttle. */
export function resetRevokedSessionThrottle(): void {
  revokedSeen.clear();
}
