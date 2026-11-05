import { dbConnect } from "@/lib/db";
import { handle, ok, created, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { validateDomain } from "@/lib/domain";
import { certificateProvider, certificateRenewalMode } from "@/lib/domains/certificates";
import { domainHealth } from "@/lib/domains/health";
import { listDomainEvents, recordDomainEvent } from "@/lib/domains/events";
import { domainLifecycleState } from "@/lib/domains/lifecycle";
import { domainRoutingTarget, expectedRoutingRecords } from "@/lib/domains/routing";
import { assertFeatureReady, isFeatureReady } from "@/lib/required-indexes";
import {
  DOMAIN_ACTIVATION_CLEARED,
  DomainVerification,
  domainOwnershipExpiry,
  domainStatusOf,
  isDomainOwnershipFresh,
  generateDomainVerificationToken,
  hashDomainVerificationToken,
} from "@/models/DomainVerification";
import { Business } from "@/models/Business";
import { assertCanAddCustomDomain } from "@/lib/billing";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { domainTxtRecordName, domainTxtRecordValue } from "@/lib/domain-dns";

const DOMAIN_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const DOMAIN_REQUEST_MAX_PER_IP = 10;
const DOMAIN_REQUEST_MAX_PER_BUSINESS = 3;
const VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/businesses/[id]/domains`
 *
 * Requests (or re-requests) DNS ownership verification for a custom domain.
 * Checks entitlement, validates the domain, and issues a fresh verification
 * token. The raw token is returned once so the caller can instruct the owner to
 * create the required DNS TXT record.
 *
 * Lifecycle rules:
 * - A pending request owned by this business is refreshed in place (attempts
 *   are preserved so the UI can show that verification was tried).
 * - A revoked record owned by this business is reused: the same document goes
 *   back to `pending` with a new token and a new expiry.
 * - A revoked record owned by another business may be taken over atomically
 *   (the domain is genuinely free again). Ownership still has to be proven with
 *   the new token.
 * - A verified record is never overwritten: `409 domain_already_verified` for
 *   the owner, and a neutral `409 domain_in_use` for every other caller.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    await dbConnect();

    await enforceRateLimit({
      key: `domain:ip:${getClientIp(request)}`,
      limit: DOMAIN_REQUEST_MAX_PER_IP,
      windowMs: DOMAIN_REQUEST_WINDOW_MS,
    });
    await enforceRateLimit({
      key: `domain:business:${id}`,
      limit: DOMAIN_REQUEST_MAX_PER_BUSINESS,
      windowMs: DOMAIN_REQUEST_WINDOW_MS,
    });

    const body = await readJson(request);
    const domainValue = (body as { domain?: unknown }).domain;

    let normalized: string;
    try {
      normalized = validateDomain(domainValue as string | null | undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid domain", "invalid_domain");
    }

    // Entitlement: the plan must include custom domains.
    await assertCanAddCustomDomain(id);

    const existing = await DomainVerification.findOne({ domain: normalized }).lean();
    // One domain, one store rests on unique indexes, so a new claim waits until they exist.
    // Renewing a domain this store already holds claims nothing, and must keep working.
    const renewingOwn = (body as { renew?: unknown }).renew === true && !!existing && domainStatusOf(existing) === "verified" && String(existing.business) === String(id);
    if (!renewingOwn) await assertFeatureReady("custom_domains");
    const rawToken = generateDomainVerificationToken();
    const tokenHash = hashDomainVerificationToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);

    const pendingFields = {
      tokenHash,
      expiresAt,
      status: "pending" as const,
      usedAt: null,
      verifiedAt: null,
      revokedAt: null,
      lastError: null,
      ...DOMAIN_ACTIVATION_CLEARED,
    };

    if (!existing) {
      await DomainVerification.create({
        business: id,
        domain: normalized,
        ...pendingFields,
      });
      await recordDomainEvent({ businessId: id, domain: normalized, type: "requested" });
      return created(domainRequestPayload(normalized, rawToken, expiresAt));
    }

    const status = domainStatusOf(existing);
    const ownedByCaller = String(existing.business) === String(id);

    if (status === "verified") {
      if (ownedByCaller && (body as { renew?: unknown }).renew === true) {
        // Ownership renewal: the domain keeps its status and keeps routing
        // while a separate renewal token is outstanding.
        const renewalExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
        const renewing = await DomainVerification.findOneAndUpdate(
          { _id: existing._id, business: id },
          {
            $set: {
              renewalTokenHash: tokenHash,
              renewalExpiresAt,
              lastError: null,
            },
          },
          { new: true },
        );
        if (!renewing) {
          throw new HttpError(409, "That domain is not available.", "domain_in_use");
        }
        await recordDomainEvent({ businessId: id, domain: normalized, type: "renewal_requested" });
        return created({
          ...domainRequestPayload(normalized, rawToken, renewalExpiresAt),
          status: "verified" as const,
          renewal: true,
        });
      }
      if (ownedByCaller) {
        throw new HttpError(
          409,
          "This domain is already verified for your business.",
          "domain_already_verified",
        );
      }
      throw new HttpError(409, "That domain is not available.", "domain_in_use");
    }

    if (status === "pending") {
      if (!ownedByCaller) {
        // Never disclose who owns the pending request.
        throw new HttpError(409, "That domain is not available.", "domain_in_use");
      }

      const refreshed = await DomainVerification.findOneAndUpdate(
        { _id: existing._id, business: id },
        { $set: pendingFields },
        { new: true },
      );
      if (!refreshed) {
        throw new HttpError(409, "That domain is not available.", "domain_in_use");
      }
      await recordDomainEvent({ businessId: id, domain: normalized, type: "requested" });
      return created(domainRequestPayload(normalized, rawToken, expiresAt));
    }

    // Revoked: the domain is free again.
    if (ownedByCaller) {
      const refreshed = await DomainVerification.findOneAndUpdate(
        { _id: existing._id, business: id },
        { $set: pendingFields },
        { new: true },
      );
      if (!refreshed) {
        throw new HttpError(409, "That domain is not available.", "domain_in_use");
      }
      await recordDomainEvent({ businessId: id, domain: normalized, type: "requested" });
      return created(domainRequestPayload(normalized, rawToken, expiresAt));
    }

    // Cross-tenant takeover is restricted to records that were explicitly
    // revoked by the lifecycle code (legacy removals are normalized by the
    // documented data migration first). The conditional update makes the
    // takeover atomic: a concurrent claimant cannot also win.
    const takenOver = await DomainVerification.findOneAndUpdate(
      { _id: existing._id, status: "revoked" },
      {
        $set: {
          business: id,
          ...pendingFields,
          attempts: 0,
          lastAttemptAt: null,
        },
      },
      { new: true },
    );
    if (!takenOver) {
      throw new HttpError(409, "That domain is not available.", "domain_in_use");
    }
    await recordDomainEvent({ businessId: id, domain: normalized, type: "requested" });
    return created(domainRequestPayload(normalized, rawToken, expiresAt));
  });
}

function domainRequestPayload(domain: string, rawToken: string, expiresAt: Date) {
  return {
    domain,
    status: "pending" as const,
    token: rawToken,
    instructions: {
      type: "TXT" as const,
      name: domainTxtRecordName(domain),
      value: domainTxtRecordValue(rawToken),
      ttl: 300,
    },
    expiresAt,
  };
}

/**
 * `GET /api/businesses/[id]/domains`
 *
 * Lists the business's pending and verified domains. Revoked (removed) records
 * are hidden. `active` here means the store's chosen domain, as it always has, from
 * the authoritative `Business.customDomain`. Whether a domain is really ready to serve
 * is `lifecycle`: `active` there needs DNS and a certificate to have been confirmed.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();

    const verifications = await DomainVerification.find({ business: id }).lean();
    const business = await Business.findById(id).lean();
    if (!business) throw new HttpError(404, "Business not found", "not_found");

    const activeDomain = business.customDomain ?? null;

    const domains = verifications
      .map((record) => {
        const status = domainStatusOf(record);
        const ownershipExpiresAt =
          status === "verified" ? domainOwnershipExpiry(record) : null;
        const fresh = status === "verified" && isDomainOwnershipFresh(record);
        const selected = activeDomain === record.domain;
        return {
          domain: record.domain,
          status,
          lifecycle: domainLifecycleState({ status, ownershipFresh: fresh, selected, expiresAt: record.expiresAt, attempts: record.attempts, lastError: record.lastError, activatedAt: record.activatedAt, routingStatus: record.routingStatus, certificateStatus: record.certificateStatus }),
          selected,
          health: domainHealth({ ...record, status, selected, ownershipFresh: fresh, ownershipExpiresAt }),
          // This legacy domain serves on, though its DNS and certificate were never confirmed.
          unconfirmed: status === "verified" && !record.activatedAt && record.activationRequired !== true,
          lastDnsOkAt: record.lastDnsOkAt ?? null,
          lastCertificateOkAt: record.lastCertificateOkAt ?? null,
          lastHealthCheckAt: record.lastHealthCheckAt ?? null,
          failingSince: record.failingSince ?? null,
          renewalStatus: record.renewalStatus ?? "not_applicable",
          renewalLastAttemptAt: record.renewalLastAttemptAt ?? null,
          renewalLastSuccessAt: record.renewalLastSuccessAt ?? null,
          renewalFailureCount: record.renewalFailureCount ?? 0,
          renewalLastError: record.renewalLastError ?? null,
          routingStatus: record.routingStatus ?? "unchecked",
          routingCheckedAt: record.routingCheckedAt ?? null,
          routingError: record.routingError ?? null,
          certificateStatus: record.certificateStatus ?? "not_started",
          certificateCheckedAt: record.certificateCheckedAt ?? null,
          certificateExpiresAt: record.certificateExpiresAt ?? null,
          certificateError: record.certificateError ?? null,
          activatedAt: record.activatedAt ?? null,
          verified: status === "verified",
          active:
            status === "verified" && fresh && activeDomain === record.domain,
          ownershipExpiresAt,
          ownershipStale: status === "verified" && !fresh,
          renewalPending:
            status === "verified" &&
            !!record.renewalTokenHash &&
            !!record.renewalExpiresAt &&
            record.renewalExpiresAt.getTime() > Date.now(),
          verifiedAt: record.verifiedAt ?? null,
          expiresAt: record.expiresAt ?? null,
          revokedAt: record.revokedAt ?? null,
          attempts: record.attempts ?? 0,
          lastAttemptAt: record.lastAttemptAt ?? null,
          lastError: record.lastError ?? null,
        };
      })
      .filter((record) => record.status !== "revoked")
      .sort((a, b) => a.domain.localeCompare(b.domain));

    const routingTarget = domainRoutingTarget();
    const history = await listDomainEvents(id, domains.map((record) => record.domain));
    return ok({
      domains: domains.map((record) => ({ ...record, events: history[record.domain] ?? [], routingRecords: expectedRoutingRecords(record.domain, routingTarget) })),
      currentCustomDomain: activeDomain,
      routingConfigured: routingTarget !== null,
      certificatesConfigured: certificateProvider() !== null,
      certificateRenewal: certificateRenewalMode(),
      ready: await isFeatureReady("custom_domains"),
    });
  });
}

/**
 * `DELETE /api/businesses/[id]/domains`
 *
 * Removes any domain belonging to the business: pending requests can be
 * cancelled, and verified domains (active or secondary) can be removed. The
 * record is revoked and, when it was the active domain, `Business.customDomain`
 * is cleared in the same request so public routing stops immediately.
 */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    await dbConnect();

    const body = await readJson(request);
    const domainValue = (body as { domain?: unknown }).domain;

    let normalized: string;
    try {
      normalized = validateDomain(domainValue as string | null | undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid domain", "invalid_domain");
    }

    const business = await Business.findById(id).lean();
    if (!business) throw new HttpError(404, "Business not found", "not_found");

    const record = await DomainVerification.findOne({ business: id, domain: normalized });
    if (!record) {
      throw new HttpError(
        404,
        "That domain is not assigned to this business",
        "not_found",
      );
    }

    const now = new Date();
    await DomainVerification.updateOne(
      { _id: record._id, business: id },
      {
        $set: {
          status: "revoked",
          revokedAt: now,
          // Keep the record (no data loss) while making the TTL index ignore it.
          expiresAt: null,
          renewalTokenHash: null,
          renewalExpiresAt: null,
          lastError: null,
          ...DOMAIN_ACTIVATION_CLEARED,
        },
      },
    );
    await recordDomainEvent({ businessId: id, domain: normalized, type: "removed" });

    const wasActive = business.customDomain === normalized;
    if (wasActive) {
      // Guarded write: a concurrently activated different domain is not cleared.
      await Business.updateOne(
        { _id: id, customDomain: normalized },
        { $set: { customDomain: null } },
      );
    }

    return ok({ removed: true, domain: normalized, wasActive });
  });
}
