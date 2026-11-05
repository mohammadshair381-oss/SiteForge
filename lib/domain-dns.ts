import { resolve4, resolveCname, resolveTxt } from "node:dns/promises";

/**
 * DNS lookup seam for custom-domain ownership verification.
 *
 * `node:dns/promises` exports are read-only bindings, so tests cannot replace
 * `resolveTxt` directly. This module keeps a single indirection that the route
 * always calls through, letting the test suite inject a deterministic resolver
 * without ever performing a live DNS lookup.
 *
 * The override is refused in production so it can never become a runtime
 * bypass.
 */

export type TxtResolver = (name: string) => Promise<string[][]>;

let resolverOverride: TxtResolver | null = null;

export function setTxtResolverForTesting(resolver: TxtResolver | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("DNS resolver overrides are not allowed in production");
  }
  resolverOverride = resolver;
}

function resolveTxtRecord(name: string): Promise<string[][]> {
  return resolverOverride ? resolverOverride(name) : resolveTxt(name);
}

export interface AddressResolvers {
  cname: (name: string) => Promise<string[]>;
  a: (name: string) => Promise<string[]>;
}

let addressOverride: AddressResolvers | null = null;

export function setAddressResolversForTesting(resolvers: AddressResolvers | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("DNS resolver overrides are not allowed in production");
  }
  addressOverride = resolvers;
}

const DNS_NAME_PREFIX = "_siteforge-verification";
const DNS_VALUE_PREFIX = "siteforge-verification=";

export function domainTxtRecordName(domain: string): string {
  return `${DNS_NAME_PREFIX}.${domain}`;
}

export function domainTxtRecordValue(rawToken: string): string {
  return `${DNS_VALUE_PREFIX}${rawToken}`;
}

/** DNS error codes that mean "the record is not there (yet)". */
const MISSING_RECORD_CODES = new Set([
  "ENOTFOUND",
  "ENODATA",
  "NXDOMAIN",
  "EAI_NODATA",
  "EAI_NONAME",
]);

export type DomainAddressCheck =
  | { kind: "match" }
  /** DNS answered: nothing there, or it points somewhere else. */
  | { kind: "not_found"; reason: "dns_not_pointed" | "dns_points_elsewhere" }
  | { kind: "resolver_error"; code: string | null };

const hostOf = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

/**
 * Whether a domain points where it should: a CNAME to the target, or A records that are
 * all ours (one address elsewhere would send some visitors there). Never throws.
 */
export async function checkDomainAddressRecords(
  domain: string,
  target: { cnameTarget: string | null; aRecords: string[] },
): Promise<DomainAddressCheck> {
  const resolvers: AddressResolvers = addressOverride ?? { cname: (name) => resolveCname(name), a: (name) => resolve4(name) };
  let lookupFailed: string | null | undefined;
  let answered = false;

  if (target.cnameTarget) {
    try {
      const names = await resolvers.cname(domain);
      answered = names.length > 0;
      if (names.some((name) => hostOf(name) === target.cnameTarget)) return { kind: "match" };
    } catch (error) {
      const code = errorCode(error);
      if (!code || !MISSING_RECORD_CODES.has(code)) lookupFailed = code;
    }
  }

  if (target.aRecords.length > 0) {
    try {
      const addresses = await resolvers.a(domain);
      answered = answered || addresses.length > 0;
      if (addresses.length > 0 && addresses.every((address) => target.aRecords.includes(address))) return { kind: "match" };
    } catch (error) {
      const code = errorCode(error);
      if (!code || !MISSING_RECORD_CODES.has(code)) lookupFailed = code;
    }
  }

  if (lookupFailed !== undefined) return { kind: "resolver_error", code: lookupFailed };
  return { kind: "not_found", reason: answered ? "dns_points_elsewhere" : "dns_not_pointed" };
}

export type DomainTxtCheck =
  | { kind: "match" }
  /** No record, or a record exists with a different value. Retryable. */
  | { kind: "not_found"; reason: "not_found" | "mismatch" }
  /** The resolver itself failed (timeout, transient network, SERVFAIL...). */
  | { kind: "resolver_error"; code: string | null };

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * Looks up the verification TXT record and classifies the outcome so the caller
 * can distinguish "not propagated yet" from "wrong value" from "resolver is
 * broken". Never throws.
 */
export async function checkDomainTxtRecord(
  domain: string,
  expectedValue: string,
): Promise<DomainTxtCheck> {
  let records: string[][];
  try {
    records = await resolveTxtRecord(domainTxtRecordName(domain));
  } catch (error) {
    const code = errorCode(error);
    if (code && MISSING_RECORD_CODES.has(code)) {
      return { kind: "not_found", reason: "not_found" };
    }
    return { kind: "resolver_error", code };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { kind: "not_found", reason: "not_found" };
  }

  const values = records
    .map((chunks) => (Array.isArray(chunks) ? chunks.join("") : String(chunks)))
    .map((value) => value.trim());

  if (values.includes(expectedValue)) return { kind: "match" };
  return { kind: "not_found", reason: "mismatch" };
}
