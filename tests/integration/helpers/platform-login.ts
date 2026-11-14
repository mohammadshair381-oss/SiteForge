import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as codePOST } from "@/app/api/auth/login/code/route";
import { POST as resendPOST } from "@/app/api/auth/login/code/resend/route";
import { getEmailOutbox } from "@/lib/email";
import { LOGIN_CHALLENGE_COOKIE } from "@/lib/auth/login-challenge";
import { PLATFORM_DEVICE_COOKIE } from "@/lib/auth/platform-device";
import { callHandler } from "./auth";

/**
 * Platform sign-in for integration tests: the password step, then (on a new device) the emailed
 * code read from the in-memory outbox. Each call uses its own source address unless one is given,
 * so tests do not share the per-source limits by accident.
 */

let lastOctet = 0;
export function freshSourceIp(): string {
  lastOctet = (lastOctet + 1) % 60000;
  return `198.19.${Math.floor(lastOctet / 250)}.${(lastOctet % 250) + 1}`;
}

export interface LoginOptions {
  ip?: string;
  /** Raw known-device marker to present. */
  device?: string | null;
}

/** The value a response sets for a cookie, or null (also null when it clears it). */
export function cookieFrom(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) return header.slice(name.length + 1).split(";")[0] || null;
  }
  return null;
}

/** The raw Set-Cookie header for a cookie, or null. */
export function setCookieHeader(response: Response, name: string): string | null {
  return response.headers.getSetCookie().find((header) => header.startsWith(`${name}=`)) ?? null;
}

/** The newest sign-in code emailed to an address. */
export function lastLoginCode(to: string): string {
  const message = [...getEmailOutbox()].reverse().find((m) => m.to === to && m.subject === "Your SiteForge sign-in code");
  const code = message?.text.match(/^ {4}(\d{6})$/m)?.[1];
  if (!code) throw new Error(`no sign-in code was emailed to ${to}`);
  return code;
}

export function loginCodeEmails(to: string) {
  return getEmailOutbox().filter((m) => m.to === to && m.subject === "Your SiteForge sign-in code");
}

function headers(options: { ip?: string; cookie?: string | null }): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-forwarded-for": options.ip ?? freshSourceIp(),
    ...(options.cookie ? { cookie: options.cookie } : {}),
  };
}

export function platformLogin(email: string, password: string, options: LoginOptions = {}): Promise<Response> {
  const cookie = options.device ? `${PLATFORM_DEVICE_COOKIE}=${options.device}` : null;
  return callHandler(
    loginPOST,
    new Request("http://localhost/api/auth/login", { method: "POST", headers: headers({ ip: options.ip, cookie }), body: JSON.stringify({ email, password }) }),
  );
}

export function submitLoginCode(challenge: string | null, code: string, options: { ip?: string } = {}): Promise<Response> {
  const cookie = challenge ? `${LOGIN_CHALLENGE_COOKIE}=${challenge}` : null;
  return callHandler(
    codePOST,
    new Request("http://localhost/api/auth/login/code", { method: "POST", headers: headers({ ip: options.ip, cookie }), body: JSON.stringify({ code }) }),
  );
}

export function requestNewLoginCode(challenge: string | null, options: { ip?: string } = {}): Promise<Response> {
  const cookie = challenge ? `${LOGIN_CHALLENGE_COOKIE}=${challenge}` : null;
  return callHandler(
    resendPOST,
    new Request("http://localhost/api/auth/login/code/resend", { method: "POST", headers: headers({ ip: options.ip, cookie }), body: "{}" }),
  );
}

export interface CompletedLogin {
  /** The password step: 200 on a known device, 202 when a code was emailed. */
  first: Response;
  /** The response that finished (or refused) the sign-in. */
  final: Response;
  challenge: string | null;
  code: string | null;
  /** The known-device marker the final response set, if any. */
  device: string | null;
}

/** Signs in the whole way: the password, then the emailed code when this device is new. */
export async function signInWithCode(email: string, password: string, options: LoginOptions = {}): Promise<CompletedLogin> {
  const first = await platformLogin(email, password, options);
  if (first.status !== 202) {
    return { first, final: first, challenge: null, code: null, device: cookieFrom(first, PLATFORM_DEVICE_COOKIE) };
  }
  const challenge = cookieFrom(first, LOGIN_CHALLENGE_COOKIE);
  const code = lastLoginCode(email.trim().toLowerCase());
  const final = await submitLoginCode(challenge, code, { ip: options.ip });
  return { first, final, challenge, code, device: cookieFrom(final, PLATFORM_DEVICE_COOKIE) };
}
