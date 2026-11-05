/**
 * How a store's custom domain is doing, worked out from what the last checks recorded
 * (pure, and safe for client components). It describes a domain and never decides
 * whether it serves: that is `domainMayServeInProduction` and `lib/domains/activation.ts`.
 * It is worked out on reading, so a date passing shows up without another check.
 */
export type DomainHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown" | "not_applicable";

export type DomainWarning =
  | "ownership_stale"
  | "ownership_expiring"
  | "dns_failing"
  | "certificate_failing"
  | "certificate_expired"
  | "certificate_expiring"
  | "renewal_failed"
  | "checks_unavailable"
  | "not_confirmed"
  | "activation_needed"
  | "check_overdue";

export const DOMAIN_WARNING_TEXT: Record<DomainWarning, string> = {
  ownership_stale: "The ownership proof has expired, so this domain does not serve your store until you renew it.",
  ownership_expiring: "The ownership proof expires soon. Renew it to keep this domain working.",
  dns_failing: "This domain does not point at SiteForge. Check its DNS records. If this continues, it will stop being active.",
  certificate_failing: "There is a problem with this domain's certificate. Visitors may see a security warning.",
  certificate_expired: "The certificate on record has expired. If it has been renewed, run a check to confirm that.",
  certificate_expiring: "The certificate expires within 30 days.",
  renewal_failed: "The last certificate renewal request did not work. It is tried again at the next check.",
  checks_unavailable: "The last check could not be completed because a lookup or provider was unavailable. Nothing was changed, and your domain stays as it was.",
  not_confirmed: "This domain was verified before DNS and certificate checks existed. It keeps working as before, but its DNS and certificate have not been confirmed yet. Run a check.",
  activation_needed: "This domain is verified but not active yet. It needs to point at SiteForge with a valid certificate.",
  check_overdue: "This domain has not been checked for over a week.",
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A certificate this close to expiring is due for renewal. */
export const CERTIFICATE_RENEWAL_WINDOW_MS = 30 * DAY_MS;
/** Keep in sync with DOMAIN_OWNERSHIP_WARNING_MS in models/DomainVerification.ts. */
const OWNERSHIP_WARNING_MS = 14 * DAY_MS;
const CHECK_OVERDUE_MS = 7 * DAY_MS;

export function isCertificateRenewalDue(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return Boolean(expiresAt && new Date(expiresAt).getTime() - now.getTime() <= CERTIFICATE_RENEWAL_WINDOW_MS);
}

export interface DomainHealthInput {
  status: "pending" | "verified" | "revoked";
  selected: boolean;
  ownershipFresh: boolean;
  ownershipExpiresAt?: Date | string | null;
  activatedAt?: Date | string | null;
  activationRequired?: boolean | null;
  routingStatus?: string | null;
  certificateStatus?: string | null;
  certificateExpiresAt?: Date | string | null;
  lastHealthCheckAt?: Date | string | null;
  temporaryFailureCount?: number | null;
  renewalStatus?: string | null;
}

export interface DomainHealth {
  status: DomainHealthStatus;
  warnings: DomainWarning[];
}

const time = (value: Date | string | null | undefined) => (value ? new Date(value).getTime() : null);

export function domainHealth(input: DomainHealthInput, now: Date = new Date()): DomainHealth {
  if (input.status !== "verified" || !input.selected) return { status: "not_applicable", warnings: [] };

  const nowMs = now.getTime();
  const warnings: DomainWarning[] = [];
  const active = Boolean(input.activatedAt);
  const ownershipExpires = time(input.ownershipExpiresAt);
  const certificateExpires = time(input.certificateExpiresAt);
  const lastCheck = time(input.lastHealthCheckAt);
  const certificateExpired = certificateExpires !== null && certificateExpires <= nowMs;

  if (!input.ownershipFresh) warnings.push("ownership_stale");
  else if (ownershipExpires !== null && ownershipExpires - nowMs <= OWNERSHIP_WARNING_MS) warnings.push("ownership_expiring");
  if (input.routingStatus === "failed") warnings.push("dns_failing");
  if (input.certificateStatus === "failed") warnings.push("certificate_failing");
  if (certificateExpired) warnings.push("certificate_expired");
  else if (certificateExpires !== null && certificateExpires - nowMs <= CERTIFICATE_RENEWAL_WINDOW_MS) warnings.push("certificate_expiring");
  if (input.renewalStatus === "failed") warnings.push("renewal_failed");
  if ((input.temporaryFailureCount ?? 0) > 0) warnings.push("checks_unavailable");
  if (!active && input.activationRequired !== true) warnings.push("not_confirmed");
  if (!active && input.activationRequired === true) warnings.push("activation_needed");
  if (active && (lastCheck === null || nowMs - lastCheck > CHECK_OVERDUE_MS)) warnings.push("check_overdue");

  const unhealthy = !input.ownershipFresh || certificateExpired || (!active && (input.routingStatus === "failed" || input.certificateStatus === "failed"));
  if (unhealthy) return { status: "unhealthy", warnings };
  if (!active) return { status: "unknown", warnings };
  return { status: warnings.length === 0 ? "healthy" : warnings.every((warning) => warning === "check_overdue") ? "unknown" : "degraded", warnings };
}
