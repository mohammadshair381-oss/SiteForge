import crypto from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Protects the endpoints an external scheduler calls (server-only). The secret travels
 * only in the `Authorization` header and is compared without revealing anything through
 * timing. It is never logged or returned, and a secret too short to be safe counts as none.
 */
export const SCHEDULER_SECRET_MIN_LENGTH = 32;

export function schedulerSecret(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length >= SCHEDULER_SECRET_MIN_LENGTH ? value : null;
}

const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

/** The refusal to send, or null when the request may go ahead. */
export function schedulerDenied(request: Request, secretName: string): NextResponse | null {
  const secret = schedulerSecret(secretName);
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return given && safeEqual(given, secret) ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
