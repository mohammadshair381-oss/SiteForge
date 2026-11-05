import { HttpError } from "@/lib/api";
import { assertCanAddCustomDomain } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { Business } from "@/models/Business";
import { DomainVerification, domainOwnershipExpiry, domainStatusOf, isDomainOwnershipFresh, type DomainVerificationDoc } from "@/models/DomainVerification";
import { certificateProvider, isManagedCertificateProvider, type CertificateState } from "./certificates";
import { notifyDomain } from "@/lib/notification-events";
import { recordDomainEvent } from "./events";
import { domainHealth, isCertificateRenewalDue, type DomainHealth } from "./health";
import { domainLifecycleState, type DomainLifecycleState } from "./lifecycle";
import { checkDomainRouting, type RoutingCheck } from "./routing";

/**
 * How long a definite DNS or certificate failure may last before an active domain stops
 * being active. Owners get time to fix a mistake, and the failure has to be seen again
 * after this long, so no single reading can take a store offline.
 */
export const DOMAIN_FAILURE_GRACE_MS = 72 * 60 * 60 * 1000;

export interface DomainActivationResult {
  domain: string;
  state: DomainLifecycleState;
  health: DomainHealth;
  routingStatus: string;
  routingError: string | null;
  certificateStatus: string;
  certificateError: string | null;
  renewalStatus: string;
  active: boolean;
  /** Whether this check made the domain active, or stopped it being active. */
  activeChanged: boolean;
}

interface CertificateCheck {
  configured: boolean;
  managed: boolean;
  /** False when no answer could be had, which says nothing about the certificate. */
  answered: boolean;
  state: CertificateState | null;
  ref: string | null;
  expiresAt: Date | null;
  error: string | null;
  renewalAttempted: boolean;
}

/** Asks the configured provider about a domain's certificate, and never throws. */
async function checkCertificate(record: DomainVerificationDoc, now: Date): Promise<CertificateCheck> {
  const provider = certificateProvider();
  if (!provider) {
    return { configured: false, managed: false, answered: false, state: null, ref: null, expiresAt: null, error: "certificate_provider_not_configured", renewalAttempted: false };
  }
  const ref = record.certificateRef ?? null;
  const managed = isManagedCertificateProvider(provider);
  const renewalAttempted = managed && ref !== null && isCertificateRenewalDue(record.certificateExpiresAt, now);
  try {
    let check;
    if (isManagedCertificateProvider(provider)) {
      check = ref === null ? await provider.issue(record.domain) : renewalAttempted ? await provider.renew(record.domain, ref) : await provider.status(record.domain, ref);
    } else {
      check = await provider.status(record.domain, ref);
    }
    return {
      configured: true,
      managed,
      answered: check.state !== "unavailable",
      state: check.state,
      ref: check.ref ?? null,
      expiresAt: check.expiresAt ?? null,
      error: check.error ?? null,
      renewalAttempted,
    };
  } catch {
    console.error("[domain-activation] the certificate provider could not be reached");
    return { configured: true, managed, answered: false, state: "unavailable", ref: null, expiresAt: null, error: "certificate_provider_error", renewalAttempted };
  }
}

interface RenewalUpdate {
  fields: {
    renewalStatus: string;
    renewalLastAttemptAt: Date | null;
    renewalLastSuccessAt: Date | null;
    renewalFailureCount: number;
    renewalLastError: string | null;
  };
  event: "certificate_renewal_started" | "certificate_renewed" | "certificate_renewal_failed" | null;
}

/** What this check means for renewal. It only records: `checkCertificate` made any request. */
function nextRenewal(record: DomainVerificationDoc, certificate: CertificateCheck | null, status: string, expiresAt: Date | null, now: Date): RenewalUpdate {
  const previousExpiry = record.certificateExpiresAt ? new Date(record.certificateExpiresAt).getTime() : null;
  const extended = previousExpiry !== null && expiresAt !== null && expiresAt.getTime() > previousExpiry;
  const fields: RenewalUpdate["fields"] = {
    renewalStatus: record.renewalStatus ?? "not_applicable",
    renewalLastAttemptAt: record.renewalLastAttemptAt ?? null,
    renewalLastSuccessAt: extended ? now : record.renewalLastSuccessAt ?? null,
    renewalFailureCount: extended ? 0 : record.renewalFailureCount ?? 0,
    renewalLastError: extended ? null : record.renewalLastError ?? null,
  };
  const provider = certificateProvider();
  if (!provider) return { fields: { ...fields, renewalStatus: "not_configured" }, event: null };
  if (!isManagedCertificateProvider(provider)) {
    // Renewed elsewhere, if at all. All SiteForge can see is a later expiry date.
    return { fields: { ...fields, renewalStatus: "external" }, event: extended ? "certificate_renewed" : null };
  }
  if (certificate?.renewalAttempted) {
    fields.renewalLastAttemptAt = now;
    if (!certificate.answered || status === "failed") {
      return { fields: { ...fields, renewalStatus: "failed", renewalFailureCount: fields.renewalFailureCount + 1, renewalLastError: certificate.error ?? "renewal_failed" }, event: "certificate_renewal_failed" };
    }
    if (extended) return { fields: { ...fields, renewalStatus: "renewed" }, event: "certificate_renewed" };
    return { fields: { ...fields, renewalStatus: "in_progress" }, event: record.renewalStatus === "in_progress" ? null : "certificate_renewal_started" };
  }
  if (extended) return { fields: { ...fields, renewalStatus: "renewed" }, event: "certificate_renewed" };
  return { fields: { ...fields, renewalStatus: isCertificateRenewalDue(expiresAt, now) ? "due" : "not_due" }, event: null };
}

/**
 * Checks DNS and the certificate for a store's chosen domain. Callers authorise first.
 *
 * - Becoming active needs both genuinely confirmed.
 * - A lookup or provider that is merely unavailable changes nothing but the record of it.
 * - A definite failure leaves an active domain active for `DOMAIN_FAILURE_GRACE_MS`, with
 *   a warning, and only ends that if it is still failing at a later check.
 * - A domain verified before these checks existed keeps working by the same rule.
 */
export async function checkDomainActivation(input: { businessId: string; domain: string; now?: Date }): Promise<DomainActivationResult> {
  await dbConnect();
  const now = input.now ?? new Date();
  const business = await Business.findById(input.businessId).select("customDomain status").lean<{ customDomain?: string | null; status: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  await assertCanAddCustomDomain(input.businessId);

  const record = await DomainVerification.findOne({ business: input.businessId, domain: input.domain }).lean<DomainVerificationDoc>();
  if (!record || domainStatusOf(record) !== "verified") throw new HttpError(409, "Verify that you own this domain first.", "domain_not_verified");
  if (!isDomainOwnershipFresh(record, now)) throw new HttpError(409, "Ownership of this domain must be re-verified first.", "ownership_stale");
  if (business.customDomain !== input.domain) throw new HttpError(409, "Choose this domain for your store first.", "domain_not_selected");

  const routing: RoutingCheck = await checkDomainRouting(input.domain);
  // No certificate is requested for a domain that does not point here yet.
  const certificate = routing.status === "ok" ? await checkCertificate(record, now) : null;

  const expiresAt = certificate?.expiresAt ?? (record.certificateExpiresAt ? new Date(record.certificateExpiresAt) : null);
  const previousCertificate = record.certificateStatus ?? "not_started";
  const expiredOnArrival = certificate?.state === "issued" && expiresAt !== null && expiresAt.getTime() <= now.getTime();
  const certificateStatus = !certificate
    ? previousCertificate
    : !certificate.configured
      ? "not_configured"
      : !certificate.answered
        ? previousCertificate === "not_configured"
          ? "pending"
          : previousCertificate
        : expiredOnArrival
          ? "failed"
          : (certificate.state as string);
  const certificateError = expiredOnArrival ? "certificate_expired" : certificate?.error ?? null;

  const ready = routing.status === "ok" && certificateStatus === "issued";
  const definiteFailure = routing.status === "failed" || (certificate?.answered === true && certificateStatus === "failed");
  const temporaryFailure = routing.status === "unknown" || (certificate !== null && certificate.configured && !certificate.answered);
  const failingSince = definiteFailure ? record.failingSince ?? now : ready ? null : record.failingSince ?? null;
  const graceOver = definiteFailure && now.getTime() - new Date(failingSince as Date).getTime() >= DOMAIN_FAILURE_GRACE_MS;

  const activatedAt = ready ? record.activatedAt ?? now : graceOver ? null : record.activatedAt ?? null;
  const renewal = nextRenewal(record, certificate, certificateStatus, expiresAt, now);

  const updated = await DomainVerification.findOneAndUpdate(
    { _id: record._id, business: input.businessId, domain: input.domain, status: { $nin: ["pending", "revoked"] } },
    {
      $set: {
        // "Unknown" says nothing about the domain, so the last real answer stands.
        ...(routing.status === "ok" || routing.status === "failed" ? { routingStatus: routing.status } : {}),
        routingCheckedAt: now,
        routingError: routing.error,
        ...(routing.status === "ok" ? { lastDnsOkAt: now } : {}),
        certificateStatus,
        certificateCheckedAt: certificate ? now : record.certificateCheckedAt ?? null,
        certificateRef: certificate?.ref ?? record.certificateRef ?? null,
        certificateExpiresAt: expiresAt,
        certificateError,
        ...(certificateStatus === "issued" && certificate?.answered ? { lastCertificateOkAt: now } : {}),
        activatedAt,
        // From a first confirmed result or a confirmed failure on, the normal rule applies.
        ...(ready || graceOver ? { activationRequired: true } : {}),
        failingSince,
        lastHealthCheckAt: now,
        temporaryFailureCount: temporaryFailure ? (record.temporaryFailureCount ?? 0) + 1 : 0,
        ...(temporaryFailure ? { lastTemporaryFailureAt: now } : {}),
        ...renewal.fields,
      },
    },
    { new: true },
  ).lean<DomainVerificationDoc>();
  if (!updated) throw new HttpError(409, "This domain changed while it was being checked. Reload and try again.", "conflict");

  await recordChanges(input.businessId, record, updated, routing.error, certificateError, renewal.event);

  const servedBefore = Boolean(record.activatedAt) || record.activationRequired !== true;
  const servesNow = Boolean(updated.activatedAt) || updated.activationRequired !== true;
  return {
    domain: input.domain,
    state: domainLifecycleState({ status: "verified", ownershipFresh: true, selected: true, activatedAt: updated.activatedAt, routingStatus: updated.routingStatus, certificateStatus: updated.certificateStatus }, now),
    health: domainHealth({ ...updated, status: "verified", selected: true, ownershipFresh: true, ownershipExpiresAt: domainOwnershipExpiry(updated) }, now),
    routingStatus: routing.status === "not_configured" ? "not_configured" : updated.routingStatus ?? "unchecked",
    routingError: routing.error,
    certificateStatus,
    certificateError,
    renewalStatus: renewal.fields.renewalStatus,
    active: Boolean(updated.activatedAt),
    activeChanged: Boolean(record.activatedAt) !== Boolean(updated.activatedAt) || servedBefore !== servesNow,
  };
}

/** Only changes go into the history, so checking twice does not add noise. */
async function recordChanges(businessId: string, before: DomainVerificationDoc, after: DomainVerificationDoc, routingError: string | null, certificateError: string | null, renewalEvent: RenewalUpdate["event"]): Promise<void> {
  const base = { businessId, domain: before.domain };
  if (before.routingStatus !== after.routingStatus) {
    if (after.routingStatus === "ok") await recordDomainEvent({ ...base, type: "routing_ok" });
    if (after.routingStatus === "failed") await recordDomainEvent({ ...base, type: "routing_failed", detail: routingError ?? "" });
  }
  if (before.certificateStatus !== after.certificateStatus) {
    if (after.certificateStatus === "pending") await recordDomainEvent({ ...base, type: "certificate_pending", detail: certificateError ?? "" });
    if (after.certificateStatus === "issued") await recordDomainEvent({ ...base, type: "certificate_issued" });
    if (after.certificateStatus === "failed") await recordDomainEvent({ ...base, type: "certificate_failed", detail: certificateError ?? "" });
  }
  if (renewalEvent) await recordDomainEvent({ ...base, type: renewalEvent, detail: after.renewalLastError ?? "" });
  if (!before.temporaryFailureCount && after.temporaryFailureCount) await recordDomainEvent({ ...base, type: "check_unavailable", detail: routingError ?? certificateError ?? "" });
  if (before.failingSince && !after.failingSince) await recordDomainEvent({ ...base, type: "recovered" });
  if (!before.activatedAt && after.activatedAt) await recordDomainEvent({ ...base, type: "activated" });
  const servedBefore = Boolean(before.activatedAt) || before.activationRequired !== true;
  const servesNow = Boolean(after.activatedAt) || after.activationRequired !== true;
  if (servedBefore && !servesNow) await recordDomainEvent({ ...base, type: "deactivated", detail: routingError ?? certificateError ?? "" });
  notifyDomain(businessId);
}

/**
 * The domains checked least recently, for a scheduler. A domain that cannot be checked
 * for a reason of its own (stale ownership, plan change, suspension) is skipped and moved
 * to the back of the queue, unchanged. One failure never stops the rest.
 */
export async function checkDueDomains(input: { limit: number; minGapMs: number; timeBudgetMs: number }) {
  await dbConnect();
  const startedAt = Date.now();
  const due = await DomainVerification.find({
    verifiedAt: { $ne: null },
    status: { $ne: "revoked" },
    $or: [{ lastHealthCheckAt: null }, { lastHealthCheckAt: { $lt: new Date(startedAt - input.minGapMs) } }],
  })
    .sort({ lastHealthCheckAt: 1 })
    .limit(Math.min(input.limit, 50))
    .select("business domain")
    .lean();
  const counts = { checked: 0, changed: 0, failed: 0, skipped: 0, stoppedEarly: false };
  for (const row of due) {
    if (Date.now() - startedAt >= input.timeBudgetMs) {
      counts.stoppedEarly = true;
      break;
    }
    try {
      const result = await checkDomainActivation({ businessId: String(row.business), domain: row.domain });
      counts.checked += 1;
      if (result.activeChanged) counts.changed += 1;
    } catch (error) {
      if (error instanceof HttpError) {
        counts.skipped += 1;
        await DomainVerification.updateOne({ _id: row._id }, { $set: { lastHealthCheckAt: new Date() } }).catch(() => undefined);
      } else {
        counts.failed += 1;
        console.error("[domain-health] a domain could not be checked");
      }
    }
  }
  return counts;
}
