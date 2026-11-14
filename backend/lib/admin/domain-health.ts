import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { domainHealth, CERTIFICATE_RENEWAL_WINDOW_MS, type DomainHealth } from "@/lib/domains/health";
import { domainLifecycleState, type DomainLifecycleState } from "@/lib/domains/lifecycle";
import { Business } from "@/models/Business";
import { DomainVerification, domainOwnershipExpiry, domainStatusOf, isDomainOwnershipFresh, type DomainVerificationDoc } from "@/models/DomainVerification";

/**
 * Read-only custom domain data for the Super Admin (server-only). Callers pass
 * `requireSuperAdmin()` or `requireSuperAdminPage()` first. States, dates and short codes
 * only: the token hashes are never read, and no certificate material is held at all.
 */
const PAGE_SIZE = 25;
const SAFE_FIELDS =
  "business domain status expiresAt usedAt verifiedAt revokedAt ownershipCheckedAt attempts lastError routingStatus routingError certificateStatus certificateError certificateExpiresAt activatedAt activationRequired lastDnsOkAt lastCertificateOkAt lastHealthCheckAt failingSince temporaryFailureCount lastTemporaryFailureAt renewalStatus renewalLastAttemptAt renewalLastSuccessAt renewalFailureCount renewalLastError";

export const DOMAIN_FILTERS = ["all", "attention"] as const;
export const domainQuerySchema = z.object({
  filter: z.enum(DOMAIN_FILTERS).prefault("all").catch("all"),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type DomainQuery = z.infer<typeof domainQuerySchema>;

export interface AdminDomainRow {
  id: string;
  businessId: string;
  businessName: string;
  domain: string;
  selected: boolean;
  lifecycle: DomainLifecycleState;
  health: DomainHealth;
  routingStatus: string;
  routingError: string | null;
  certificateStatus: string;
  certificateError: string | null;
  certificateExpiresAt: Date | null;
  lastDnsOkAt: Date | null;
  lastCertificateOkAt: Date | null;
  lastHealthCheckAt: Date | null;
  failingSince: Date | null;
  activatedAt: Date | null;
  renewalStatus: string;
  renewalLastAttemptAt: Date | null;
  renewalFailureCount: number;
  renewalLastError: string | null;
}

function toRow(record: DomainVerificationDoc, business: { name: string; customDomain?: string | null } | undefined): AdminDomainRow {
  const status = domainStatusOf(record);
  const selected = business?.customDomain === record.domain;
  const ownershipFresh = status === "verified" && isDomainOwnershipFresh(record);
  return {
    id: String(record._id),
    businessId: String(record.business),
    businessName: business?.name ?? "Unknown business",
    domain: record.domain,
    selected,
    lifecycle: domainLifecycleState({ status, ownershipFresh, selected, expiresAt: record.expiresAt, attempts: record.attempts, lastError: record.lastError, activatedAt: record.activatedAt, routingStatus: record.routingStatus, certificateStatus: record.certificateStatus }),
    health: domainHealth({ ...record, status, selected, ownershipFresh, ownershipExpiresAt: domainOwnershipExpiry(record) }),
    routingStatus: record.routingStatus ?? "unchecked",
    routingError: record.routingError ?? null,
    certificateStatus: record.certificateStatus ?? "not_started",
    certificateError: record.certificateError ?? null,
    certificateExpiresAt: record.certificateExpiresAt ?? null,
    lastDnsOkAt: record.lastDnsOkAt ?? null,
    lastCertificateOkAt: record.lastCertificateOkAt ?? null,
    lastHealthCheckAt: record.lastHealthCheckAt ?? null,
    failingSince: record.failingSince ?? null,
    activatedAt: record.activatedAt ?? null,
    renewalStatus: record.renewalStatus ?? "not_applicable",
    renewalLastAttemptAt: record.renewalLastAttemptAt ?? null,
    renewalFailureCount: record.renewalFailureCount ?? 0,
    renewalLastError: record.renewalLastError ?? null,
  };
}

export async function listAdminDomains(query: DomainQuery) {
  await dbConnect();
  const where: Record<string, unknown> = { status: { $ne: "revoked" } };
  if (query.filter === "attention") {
    where.$or = [
      { routingStatus: "failed" },
      { certificateStatus: "failed" },
      { renewalStatus: "failed" },
      { failingSince: { $ne: null, $exists: true } },
      { temporaryFailureCount: { $gt: 0 } },
      { certificateExpiresAt: { $ne: null, $lt: new Date(Date.now() + CERTIFICATE_RENEWAL_WINDOW_MS) } },
    ];
  }
  const [records, total] = await Promise.all([
    DomainVerification.find(where).sort({ updatedAt: -1 }).skip((query.page - 1) * PAGE_SIZE).limit(PAGE_SIZE).select(SAFE_FIELDS).lean<DomainVerificationDoc[]>(),
    DomainVerification.countDocuments(where),
  ]);
  const businesses = await Business.find({ _id: { $in: records.map((record) => record.business) } }).select("name customDomain").lean<Array<{ _id: unknown; name: string; customDomain?: string | null }>>();
  const byId = new Map(businesses.map((business) => [String(business._id), business]));
  return { items: records.map((record) => toRow(record, byId.get(String(record.business)))), total, page: query.page, pageSize: PAGE_SIZE };
}

/** One store's domains, for its detail page. */
export async function getAdminBusinessDomains(businessId: string): Promise<AdminDomainRow[]> {
  await dbConnect();
  const [records, business] = await Promise.all([
    DomainVerification.find({ business: businessId, status: { $ne: "revoked" } }).limit(10).select(SAFE_FIELDS).lean<DomainVerificationDoc[]>(),
    Business.findById(businessId).select("name customDomain").lean<{ name: string; customDomain?: string | null }>(),
  ]);
  return records.map((record) => toRow(record, business ?? undefined));
}
