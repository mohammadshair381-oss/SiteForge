/**
 * Edge-safe host utilities. This file must NOT import mongoose or any
 * Node-only module, because it is used from middleware.
 */

/**
 * One configured address reduced to a bare host (with its port, if any). Settings are
 * often pasted as a full address, so `https://`, quotes, a path and a trailing slash
 * or dot are dropped: "https://app.example.com/" means "app.example.com".
 */
export function cleanRootDomain(value: string): string {
  return value
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
}

/** The host of `APP_URL`, which names the platform's own address; null when unset or unusable. */
function appUrlHost(): string | null {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * The platform's own addresses. `ROOT_DOMAINS` (or else `NEXT_PUBLIC_ROOT_DOMAIN`, or
 * else `localhost:3000`) come first, in their order. The host of `APP_URL` and, on
 * Vercel, the project's production address (`VERCEL_PROJECT_PRODUCTION_URL`) are
 * added after them, so the platform never mistakes its own address for a store's.
 */
export function getRootDomains(): string[] {
  const raw =
    process.env.ROOT_DOMAINS ||
    process.env.NEXT_PUBLIC_ROOT_DOMAIN ||
    "localhost:3000";
  const configured = raw.split(",").map(cleanRootDomain);
  const own = [appUrlHost(), cleanRootDomain(process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "")];
  return [...new Set([...configured, ...own].filter((value): value is string => Boolean(value)))];
}

export function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase();
}

/**
 * In development the server may not get the port in ROOT_DOMAINS (Next.js moves
 * to another one when it is busy), so `localhost` hosts are compared without the
 * port. Otherwise the platform would treat itself as a tenant store. Production
 * always compares the exact host.
 */
function comparableHost(host: string): string {
  if (process.env.NODE_ENV === "production") return host;
  return host.replace(/^((?:.+\.)?localhost):\d+$/, "$1");
}

function comparableRootDomains(): string[] {
  return getRootDomains().map(comparableHost);
}

/**
 * Whether a state-changing API request may proceed. A browser sends `Origin` on
 * every cross-site write, including form posts, which can carry JSON as plain text
 * past a `Content-Type` check. No `Origin` means a server caller, such as a webhook.
 */
export function isAllowedApiOrigin(origin: string | null, host: string | null, production: boolean): boolean {
  if (!origin) return true;
  const expected = (host ?? "").toLowerCase();
  if (!expected) return false;
  const value = origin.toLowerCase();
  return value === `https://${expected}` || (!production && value === `http://${expected}`);
}

export function isRootHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  return comparableRootDomains().includes(comparableHost(normalized));
}

/**
 * The root domain for store links shown on the platform itself. Production
 * always uses the configured domain. In development Next.js may run on another
 * port than ROOT_DOMAINS says, and a link to that port would open whatever else
 * is running there, so a `localhost` platform request keeps its own port.
 */
export function storeLinkRoot(requestHost: string | null | undefined): string {
  const root = getRootDomains()[0] ?? "localhost:3000";
  if (process.env.NODE_ENV === "production") return root;
  const host = normalizeHost(requestHost);
  return /^localhost:\d+$/.test(host) && isRootHost(host) ? host : root;
}

/**
 * Returns the storefront subdomain for a host, or null when the host is the
 * apex/root domain (or not a storefront host at all).
 *
 *   demo.example.com   -> "demo"      (root = example.com)
 *   example.com        -> null
 *   127.0.0.1:3000     -> null
 */
export function extractSubdomain(host: string | null | undefined): string | null {
  const normalized = comparableHost(normalizeHost(host));
  if (!normalized) return null;

  for (const root of comparableRootDomains()) {
    if (normalized === root) return null;
    if (normalized.endsWith(`.${root}`)) {
      const prefix = normalized.slice(0, -(root.length + 1));
      if (!prefix || prefix.includes(".")) {
        // Only treat a single label as a tenant subdomain.
        return prefix || null;
      }
      return prefix;
    }
  }

  return null;
}
