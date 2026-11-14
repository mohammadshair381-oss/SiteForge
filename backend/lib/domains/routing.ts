import { isIPv4 } from "node:net";
import { checkDomainAddressRecords } from "@/lib/domain-dns";

/**
 * Whether a custom domain points at SiteForge (server-only). Where it should point is
 * the operator's setting: SiteForge provides no ingress of its own, so with nothing
 * configured a domain simply cannot pass this check.
 */
export interface DomainRoutingTarget {
  cnameTarget: string | null;
  aRecords: string[];
}

const cleanHost = (value: string | undefined) => (value ?? "").trim().toLowerCase().replace(/\.$/, "");

export function domainRoutingTarget(): DomainRoutingTarget | null {
  const cnameTarget = cleanHost(process.env.CUSTOM_DOMAIN_CNAME_TARGET) || null;
  const aRecords = (process.env.CUSTOM_DOMAIN_A_RECORDS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => isIPv4(part));
  return cnameTarget || aRecords.length > 0 ? { cnameTarget, aRecords } : null;
}

/** The records an owner has to create. Public by nature, so safe to show. */
export function expectedRoutingRecords(domain: string, target: DomainRoutingTarget | null): Array<{ type: "CNAME" | "A"; name: string; value: string }> {
  if (!target) return [];
  return [
    ...(target.cnameTarget ? [{ type: "CNAME" as const, name: domain, value: target.cnameTarget }] : []),
    ...target.aRecords.map((value) => ({ type: "A" as const, name: domain, value })),
  ];
}

/**
 * `ok`: confirmed. `failed`: DNS answered, and it points somewhere else or nowhere.
 * `unknown`: the lookup itself failed, which says nothing about the domain.
 * `not_configured`: there is nothing to compare with.
 */
export type RoutingCheck = { status: "ok" | "failed" | "unknown" | "not_configured"; error: string | null };

export async function checkDomainRouting(domain: string): Promise<RoutingCheck> {
  const target = domainRoutingTarget();
  if (!target) return { status: "not_configured", error: "routing_target_not_configured" };
  const result = await checkDomainAddressRecords(domain, target);
  if (result.kind === "match") return { status: "ok", error: null };
  if (result.kind === "resolver_error") return { status: "unknown", error: "dns_lookup_failed" };
  return { status: "failed", error: result.reason };
}
