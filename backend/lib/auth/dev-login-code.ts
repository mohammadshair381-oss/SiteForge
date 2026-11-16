/**
 * Development-only visibility for emailed six-digit codes: sign-in, signup and password reset
 * (server-only).
 *
 * With `EMAIL_PROVIDER=console` nothing is delivered and the console transport deliberately omits
 * every email body, so a developer could never finish signing up, logging in or resetting a password
 * locally. This prints the code in the SERVER terminal, and only when ALL of these hold, checked on
 * every call (anything missing, misspelt or unexpected keeps it off):
 *
 *   - `NODE_ENV` is exactly `"development"` (so never production, test, staging or unset);
 *   - `AUTH_LOG_OTP` is exactly `"true"` (`"1"`, `"TRUE"`, `" true"` or anything else = off);
 *   - `EMAIL_PROVIDER` is explicitly a local transport, `console` or `memory` (empty, which the
 *     email module would treat as console, is NOT enough: real delivery must never coexist with it);
 *   - the process is not on a hosting platform (`VERCEL` / `VERCEL_ENV` unset).
 *
 * It never reaches a browser: it is called only from lib/auth/login-challenge.ts after a code was
 * stored and sent, never from a route's response, and it has no `NEXT_PUBLIC_` form. It logs only
 * six-digit codes: never links, action tokens, passwords or secrets.
 */

const LOCAL_EMAIL_PROVIDERS = new Set(["console", "memory"]);

export type LoggedCodePurpose = "login" | "signup" | "reset";
const LABELS: Record<LoggedCodePurpose, string> = { login: "sign-in code", signup: "sign-up code", reset: "password reset code" };

/** Same masking as the console email transport: first character and the domain. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function developmentLoginCodeLoggingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV !== "development") return false;
  if (environment.AUTH_LOG_OTP !== "true") return false;
  if (environment.VERCEL || environment.VERCEL_ENV) return false;
  const provider = typeof environment.EMAIL_PROVIDER === "string" ? environment.EMAIL_PROVIDER.trim().toLowerCase() : "";
  return LOCAL_EMAIL_PROVIDERS.has(provider);
}

/** Prints the code when allowed; returns whether it did. */
export function logDevelopmentLoginCode(
  email: string,
  code: string,
  environment: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = (line) => console.info(line),
  purpose: LoggedCodePurpose = "login",
): boolean {
  if (!developmentLoginCodeLoggingEnabled(environment)) return false;
  if (!/^\d{6}$/.test(code)) return false;
  write(`[auth] Development ${LABELS[purpose] ?? LABELS.login} for ${maskEmail(email)}: ${code}`);
  return true;
}
