/**
 * Domain validation and normalization for custom domain support.
 *
 * These helpers are pure and side-effect free: they validate hostname syntax,
 * normalize casing and trailing dots, and reject reserved or reserved-platform
 * hostnames. They do NOT perform network lookups.
 */

import { getRootDomains, normalizeHost } from "./host";

/**
 * Platform-owned hostnames that must never be claimable as custom domains.
 * Includes the root domains themselves and common platform subdomains.
 */
const RESERVED_PLATFORM_SUBDOMAINS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "dashboard",
  "mail",
  "static",
  "assets",
  "cdn",
  "support",
  "help",
  "blog",
  "docs",
  "status",
  "store",
  "account",
  "login",
  "signup",
  "root",
  "system",
]);

/**
 * Normalizes a domain for comparison and storage:
 * - trims whitespace
 * - lowercases
 * - removes a single trailing dot (fully qualified domain name form)
 * - removes the scheme (http:// / https://) if present
 * - removes any path, query, or fragment
 */
export function normalizeDomain(domain: string | null | undefined): string {
  if (!domain) return "";
  let value = domain.trim().toLowerCase();

  // Strip scheme if present (e.g. https://example.com)
  value = value.replace(/^https?:\/\//i, "");

  // Strip any path/query/fragment that might remain
  const slashIndex = value.indexOf("/");
  if (slashIndex !== -1) value = value.slice(0, slashIndex);
  const questionIndex = value.indexOf("?");
  if (questionIndex !== -1) value = value.slice(0, questionIndex);
  const hashIndex = value.indexOf("#");
  if (hashIndex !== -1) value = value.slice(0, hashIndex);

  // Remove a single trailing dot (FQDN form)
  if (value.endsWith(".") && value.length > 1) {
    value = value.slice(0, -1);
  }

  return value;
}

/**
 * Whether a value looks like an IPv4 or IPv6 address. Custom domains must be
 * hostnames, not bare IP addresses, unless an explicitly supported use case is
 * established later.
 */
export function isIpAddress(value: string): boolean {
  // IPv4: four dot-separated octets 0-255
  const ipv4Regex =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = value.match(ipv4Regex);
  if (ipv4Match) {
    return ipv4Match.slice(1).every((octet) => {
      const num = Number(octet);
      return num >= 0 && num <= 255 && String(num) === octet;
    });
  }

  // IPv6: contains colons (very rough check, sufficient to reject)
  if (value.includes(":")) return true;

  return false;
}

/**
 * Internal / non-public suffixes that must never be accepted as a custom
 * domain. Resolving TXT records for them can only probe the server's own
 * resolver, and they can never be served over the public internet.
 */
const INTERNAL_DOMAIN_SUFFIXES = [
  ".local",
  ".localdomain",
  ".localhost",
  ".internal",
  ".intranet",
  ".home.arpa",
  ".lan",
  ".corp",
];

/**
 * Whether a normalized domain is a platform-owned domain that must never be
 * claimable as a custom domain. This includes the root domains themselves,
 * reserved platform subdomains on any root domain, and any host under a
 * configured platform root (those are shadowed by tenant subdomain resolution
 * and could never route as a custom domain).
 */
export function isReservedPlatformDomain(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return true;

  const rootDomains = getRootDomains();

  // The root domain itself is reserved.
  if (rootDomains.includes(normalized)) return true;

  // Any subdomain of a root domain whose first label is reserved.
  const firstLabel = normalized.split(".")[0];
  if (RESERVED_PLATFORM_SUBDOMAINS.has(firstLabel)) return true;

  // Any host under a configured root domain. Tenant subdomain resolution
  // handles those first, so a custom domain there would verify but never route.
  for (const root of rootDomains) {
    const apex = root.split(":")[0];
    if (!apex) continue;
    if (normalized === apex || normalized.endsWith(`.${apex}`)) return true;
  }

  return false;
}

/**
 * Whether a normalized domain is a single label (`localhost`, `intranet`).
 * Custom domains must be fully qualified names.
 */
export function isSingleLabelDomain(domain: string): boolean {
  return !normalizeDomain(domain).includes(".");
}

/** Whether a normalized domain ends with an internal-only suffix. */
export function isInternalDomain(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  return INTERNAL_DOMAIN_SUFFIXES.some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
  );
}

/**
 * Whether a single DNS label is valid: 1-63 chars, starts and ends with
 * alphanumeric, contains only alphanumeric or hyphen.
 */
function isValidLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  const c0 = label[0];
  const cl = label[label.length - 1];
  if (
    !(c0 >= "a" && c0 <= "z") &&
    !(c0 >= "0" && c0 <= "9")
  ) {
    return false;
  }
  if (
    !(cl >= "a" && cl <= "z") &&
    !(cl >= "0" && cl <= "9")
  ) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (
      (c < "a" || c > "z") &&
      (c < "0" || c > "9") &&
      c !== "-"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Full domain validation. Returns the normalized domain when valid, or throws
 * an HttpError with a descriptive message when invalid.
 */
import { HttpError } from "./api";

export function validateDomain(domain: string | null | undefined): string {
  const normalized = normalizeDomain(domain);

  if (!normalized) {
    throw new HttpError(400, "A domain is required", "domain_required");
  }

  // Reject scheme/path/query/fragment remnants that normalization couldn't fully
  // strip (defensive; normalizeDomain handles the common cases).
  if (/[\s/?#]/.test(normalized)) {
    throw new HttpError(
      400,
      "Domain must be a bare hostname without scheme, path, or query",
      "invalid_domain",
    );
  }

  // Reject labels that are too long or contain invalid characters.
  const labels = normalized.split(".");
  for (const label of labels) {
    if (!isValidLabel(label)) {
      throw new HttpError(
        400,
        "Domain labels must be 1-63 characters, start and end with alphanumeric, and contain only alphanumeric characters or hyphens",
        "invalid_domain",
      );
    }
  }

  // Reject IP addresses.
  if (isIpAddress(normalized)) {
    throw new HttpError(400, "IP addresses are not supported as custom domains", "invalid_domain");
  }

  // Reject total length > 253 octets (DNS max).
  if (normalized.length > 253) {
    throw new HttpError(400, "Domain is too long", "invalid_domain");
  }

  // Reject single-label and internal-only hostnames: they are not publicly
  // resolvable and are only useful for probing the server's resolver.
  if (isSingleLabelDomain(normalized)) {
    throw new HttpError(
      400,
      "Enter a full domain name including its top-level domain (e.g. example.com)",
      "invalid_domain",
    );
  }
  if (isInternalDomain(normalized)) {
    throw new HttpError(
      400,
      "Internal domain names cannot be used as a custom domain",
      "invalid_domain",
    );
  }

  // Reject reserved platform domains.
  if (isReservedPlatformDomain(normalized)) {
    throw new HttpError(
      400,
      "That domain is reserved and cannot be used as a custom domain",
      "reserved_domain",
    );
  }

  return normalized;
}
