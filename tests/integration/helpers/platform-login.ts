import { POST as loginPOST } from "@/app/api/auth/login/route";
import { getEmailOutbox } from "@/lib/email";
import { callHandler } from "./auth";

/**
 * Platform sign-in for integration tests. Login is email and password only (no emailed code). Each
 * call uses its own source address unless one is given, so tests do not share the per-source limits
 * by accident. Emailed codes remain only for password reset, read from the in-memory outbox.
 */

let lastOctet = 0;
export function freshSourceIp(): string {
  lastOctet = (lastOctet + 1) % 60000;
  return `198.19.${Math.floor(lastOctet / 250)}.${(lastOctet % 250) + 1}`;
}

export interface LoginOptions {
  ip?: string;
  /** Extra cookie header to send (for example a stale cookie that must be ignored). */
  cookie?: string;
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

export const CODE_SUBJECTS = {
  login: "Your SiteForge sign-in code",
  signup: "Your SiteForge confirmation code",
  reset: "Your SiteForge password reset code",
} as const;
export type CodeKind = keyof typeof CODE_SUBJECTS;

/** The newest code of a kind emailed to an address (only password reset sends codes now). */
export function lastLoginCode(to: string, kind: CodeKind = "reset"): string {
  const message = [...getEmailOutbox()].reverse().find((m) => m.to === to && m.subject === CODE_SUBJECTS[kind]);
  const code = message?.text.match(/^ {4}(\d{6})$/m)?.[1];
  if (!code) throw new Error(`no ${kind} code was emailed to ${to}`);
  return code;
}

export function loginCodeEmails(to: string, kind: CodeKind = "reset") {
  return getEmailOutbox().filter((m) => m.to === to && m.subject === CODE_SUBJECTS[kind]);
}

export function platformLogin(email: string, password: string, options: LoginOptions = {}): Promise<Response> {
  return callHandler(
    loginPOST,
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": options.ip ?? freshSourceIp(),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify({ email, password }),
    }),
  );
}

export interface CompletedLogin {
  /** The login answer. */
  first: Response;
  /** The same answer (login has a single step now); kept so existing callers read `final`. */
  final: Response;
}

/** Signs in: email and password, one step. (The name predates the removal of login codes.) */
export async function signInWithCode(email: string, password: string, options: LoginOptions = {}): Promise<CompletedLogin> {
  const first = await platformLogin(email, password, options);
  return { first, final: first };
}
