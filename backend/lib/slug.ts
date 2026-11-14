export function slugify(input: string): string {
  return input
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export const RESERVED_SUBDOMAINS = new Set([
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

export function isReservedSubdomain(value: string): boolean {
  return RESERVED_SUBDOMAINS.has(value.trim().toLowerCase());
}

export function isValidSubdomain(value: string): boolean {
  if (!value) return false;
  if (isReservedSubdomain(value)) return false;
  return /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/.test(value);
}
