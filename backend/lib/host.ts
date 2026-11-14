/**
 * Edge-safe host utilities. This file must NOT import mongoose or any
 * Node-only module, because it is used from middleware.
 */

export function getRootDomains(): string[] {
  const raw =
    process.env.ROOT_DOMAINS ||
    process.env.NEXT_PUBLIC_ROOT_DOMAIN ||
    "localhost:3000";
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
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
