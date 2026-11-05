import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { validateDomain } from "@/lib/domain";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertCanAddCustomDomain } from "@/lib/billing";
import { recordDomainEvent } from "@/lib/domains/events";
import { assertFeatureReady } from "@/lib/required-indexes";
import {
  DOMAIN_ACTIVATION_CLEARED,
  DomainVerification,
  domainOwnershipExpiry,
  domainStatusOf,
  domainVerificationTokenMatches,
  isDomainOwnershipFresh,
  type DomainVerificationDoc,
} from "@/models/DomainVerification";
import { Business } from "@/models/Business";
import { checkDomainTxtRecord, domainTxtRecordName, domainTxtRecordValue } from "@/lib/domain-dns";

const VERIFY_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_MAX_PER_IP = 20;
const VERIFY_MAX_PER_BUSINESS = 20;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const NO_PENDING_MESSAGE =
  "No pending verification found for this domain. Request verification again.";

function isDuplicateKeyError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

/** Records a failed attempt without consuming the pending token. */
async function recordAttempt(
  recordId: unknown,
  businessId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const record = await DomainVerification.findOneAndUpdate(
    { _id: recordId, business: businessId },
    {
      $inc: { attempts: 1 },
      $set: { lastAttemptAt: now, lastError: reason },
    },
  ).select("domain").lean<{ domain: string }>();
  if (record) await recordDomainEvent({ businessId, domain: record.domain, type: "verification_failed", detail: reason });
}

/**
 * Makes `domain` the business's chosen custom domain. Used when a record is already
 * verified and does not require DNS proof again. It still has to pass the DNS and
 * certificate checks (`lib/domains/activation.ts`) before it serves in production.
 */
async function activateVerifiedDomain(
  businessId: string,
  domain: string,
  now: Date,
): Promise<string | null> {
  const business = await Business.findById(businessId);
  if (!business) throw new HttpError(404, "Business not found", "not_found");

  const previousDomain =
    business.customDomain && business.customDomain !== domain
      ? business.customDomain
      : null;

  if (business.customDomain !== domain) {
    business.customDomain = domain;
    try {
      await business.save();
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new HttpError(409, "That domain is not available.", "domain_in_use");
      }
      throw error;
    }
    // Earlier checks were for when it was not this store's domain.
    await DomainVerification.updateOne({ business: businessId, domain }, { $set: DOMAIN_ACTIVATION_CLEARED });
    await recordDomainEvent({ businessId, domain, type: "selected" });
  }

  await DomainVerification.updateMany(
    { business: businessId, domain: { $ne: domain }, status: "verified" },
    { $set: { status: "revoked", revokedAt: now, expiresAt: null, ...DOMAIN_ACTIVATION_CLEARED } },
  );

  return previousDomain;
}

/**
 * Checks the TXT record for `token` and throws a classified, retryable error
 * unless it matches. A failure only records the attempt: it never changes the
 * record's lifecycle state, so a transient resolver problem cannot disable a
 * domain or consume a token.
 */
async function assertDnsProof(
  recordId: unknown,
  businessId: string,
  domain: string,
  token: string,
  now: Date,
): Promise<void> {
  const dns = await checkDomainTxtRecord(domain, domainTxtRecordValue(token));

  if (dns.kind === "match") return;

  if (dns.kind === "resolver_error") {
    await recordAttempt(recordId, businessId, "dns_lookup_failed", now);
    throw new HttpError(
      502,
      "The DNS lookup failed temporarily. Please retry in a few minutes; your verification request stays valid.",
      "dns_lookup_failed",
    );
  }

  await recordAttempt(recordId, businessId, dns.reason, now);
  if (dns.reason === "mismatch") {
    throw new HttpError(
      400,
      `A TXT record exists at ${domainTxtRecordName(domain)} but its value does not match the expected verification value.`,
      "dns_mismatch",
    );
  }
  throw new HttpError(
    400,
    `No TXT record was found at ${domainTxtRecordName(domain)}. DNS changes can take a few minutes to propagate; you can retry verification.`,
    "dns_not_found",
  );
}

interface ActivationResult {
  activated: boolean;
  previousDomain: string | null;
}

/**
 * Atomically claims the pending record and activates it. The record claim, the
 * `Business.customDomain` write, and the revocation of any previously verified
 * record happen in one transaction, so two concurrent verifications can never
 * leave two domains active or activate a record whose token changed.
 */
async function activatePendingDomain(
  businessId: string,
  record: DomainVerificationDoc,
  domain: string,
  now: Date,
): Promise<ActivationResult> {
  const session = await mongoose.connection.startSession();
  let activated = false;
  let previousDomain: string | null = null;

  try {
    try {
      await session.withTransaction(async () => {
        // Reset per attempt: `withTransaction` may retry after an abort.
        activated = false;
        previousDomain = null;

        const claimed = await DomainVerification.findOneAndUpdate(
          {
            _id: record._id,
            business: businessId,
            status: "pending",
            tokenHash: record.tokenHash,
          },
          {
            $set: {
              status: "verified",
              verifiedAt: now,
              ownershipCheckedAt: now,
              activationRequired: true,
              revokedAt: null,
              expiresAt: null,
              lastAttemptAt: now,
              lastError: null,
            },
            $inc: { attempts: 1 },
          },
          { new: true, session },
        );

        // Another caller already moved the record out of `pending`.
        if (!claimed) return;

        const business = await Business.findById(businessId).session(session);
        if (!business) throw new HttpError(404, "Business not found", "not_found");

        if (business.customDomain && business.customDomain !== domain) {
          previousDomain = business.customDomain;
        }
        business.customDomain = domain;
        await business.save({ session });

        // Single-active-domain invariant: only one verified record may exist.
        await DomainVerification.updateMany(
          { business: businessId, domain: { $ne: domain }, status: "verified" },
          { $set: { status: "revoked", revokedAt: now, expiresAt: null, ...DOMAIN_ACTIVATION_CLEARED } },
          { session },
        );

        activated = true;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isDuplicateKeyError(error)) {
        // Another business owns this domain as its active custom domain.
        await DomainVerification.updateOne(
          { _id: record._id, business: businessId },
          {
            $set: {
              status: "revoked",
              revokedAt: now,
              expiresAt: null,
              lastAttemptAt: now,
              lastError: "domain_in_use",
            },
          },
        );
        throw new HttpError(409, "That domain is not available.", "domain_in_use");
      }
      if (isTransactionalConflict(error)) {
        throw new HttpError(
          409,
          "The verification conflicted with another update. Please retry.",
          "conflict",
        );
      }
      throw error;
    }

    return { activated, previousDomain };
  } finally {
    await session.endSession();
  }
}

/**
 * `POST /api/businesses/[id]/domains/verify`
 *
 * Verifies DNS ownership of a custom domain by checking the TXT record that
 * contains the server-issued token.
 *
 * Safety properties:
 * - The submitted token is compared against the stored hash in constant time.
 * - Entitlement is rechecked before any activation.
 * - DNS is checked *before* the record is consumed, so a failed or premature
 *   lookup stays retryable with the same token.
 * - Failure reasons are classified (`dns_not_found`, `dns_mismatch`,
 *   `dns_lookup_failed`, `invalid_token`, `token_expired`).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    await dbConnect();

    await enforceRateLimit({
      key: `domain-verify:ip:${getClientIp(request)}`,
      limit: VERIFY_MAX_PER_IP,
      windowMs: VERIFY_WINDOW_MS,
    });
    await enforceRateLimit({
      key: `domain-verify:business:${id}`,
      limit: VERIFY_MAX_PER_BUSINESS,
      windowMs: VERIFY_WINDOW_MS,
    });

    const body = await readJson(request);
    const domainValue = (body as { domain?: unknown }).domain;
    const tokenValue = (body as { token?: unknown }).token;

    let normalized: string;
    try {
      normalized = validateDomain(domainValue as string | null | undefined);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid domain", "invalid_domain");
    }

    const record = await DomainVerification.findOne({
      business: id,
      domain: normalized,
    }).lean<DomainVerificationDoc>();

    if (!record) {
      throw new HttpError(404, NO_PENDING_MESSAGE, "no_pending_verification");
    }

    const status = domainStatusOf(record);
    if (status === "revoked") {
      throw new HttpError(404, NO_PENDING_MESSAGE, "no_pending_verification");
    }

    // Recheck entitlement at the activation point (a downgrade between request
    // and verification must not activate a custom domain).
    await assertCanAddCustomDomain(id);

    // A new claim needs the unique indexes behind "one domain, one store". Renewing the
    // proof of a domain this store already holds claims nothing, and must keep working.
    const isRenewal = status === "verified" && typeof tokenValue === "string" && tokenValue.trim() !== "";
    if (!isRenewal) await assertFeatureReady("custom_domains");

    const now = new Date();

    if (status === "verified") {
      const submitted = typeof tokenValue === "string" ? tokenValue.trim() : "";

      if (submitted) {
        // Ownership renewal: prove DNS control again with the renewal token.
        // Routing/active state is untouched on failure.
        const renewalValid =
          !!record.renewalTokenHash &&
          !!record.renewalExpiresAt &&
          record.renewalExpiresAt.getTime() > now.getTime();
        if (
          !renewalValid ||
          !domainVerificationTokenMatches(submitted, record.renewalTokenHash)
        ) {
          await recordAttempt(record._id, id, "invalid_token", now);
          throw new HttpError(
            400,
            "That token does not match this domain's current renewal request. Request a new renewal token.",
            "invalid_token",
          );
        }

        await assertDnsProof(record._id, id, normalized, submitted, now);

        const renewed = await DomainVerification.findOneAndUpdate(
          {
            _id: record._id,
            business: id,
            status: "verified",
            renewalTokenHash: record.renewalTokenHash,
          },
          {
            $set: {
              ownershipCheckedAt: now,
              renewalTokenHash: null,
              renewalExpiresAt: null,
              lastAttemptAt: now,
              lastError: null,
            },
            $inc: { attempts: 1 },
          },
          { new: true },
        );
        if (!renewed) {
          throw new HttpError(
            409,
            "The renewal conflicted with another update. Reload and retry.",
            "conflict",
          );
        }
        await recordDomainEvent({ businessId: id, domain: normalized, type: "renewed" });
        const business = await Business.findById(id).lean();
        return ok({
          domain: normalized,
          verified: true,
          renewed: true,
          active: business?.customDomain === normalized,
          ownershipCheckedAt: now,
          ownershipExpiresAt: domainOwnershipExpiry(renewed),
        });
      }

      // Switching the active domain does not need new DNS proof, but the
      // existing proof must still be fresh.
      if (!isDomainOwnershipFresh(record, now)) {
        throw new HttpError(
          409,
          "Ownership of this domain must be re-verified before it can be activated.",
          "ownership_stale",
        );
      }
      const previousDomain = await activateVerifiedDomain(id, normalized, now);
      return ok({
        domain: normalized,
        verified: true,
        active: true,
        alreadyVerified: true,
        verifiedAt: record.verifiedAt ?? null,
        previousDomain,
      });
    }

    // Normalize legacy pending records that predate the `status` field so the
    // atomic claim below can match them.
    if (record.status !== "pending") {
      await DomainVerification.updateOne(
        {
          _id: record._id,
          business: id,
          ...(record.status ? { status: record.status } : { status: null }),
        },
        { $set: { status: "pending" } },
      );
    }

    if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
      throw new HttpError(
        400,
        "This verification request has expired. Request a new verification token.",
        "token_expired",
      );
    }

    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    if (token.length < 16) {
      throw new HttpError(400, "A verification token is required", "token_required");
    }

    if (!domainVerificationTokenMatches(token, record.tokenHash)) {
      await recordAttempt(record._id, id, "invalid_token", now);
      throw new HttpError(
        400,
        "That verification token does not match this domain's pending request.",
        "invalid_token",
      );
    }

    await assertDnsProof(record._id, id, normalized, token, now);

    const result = await activatePendingDomain(id, record, normalized, now);

    if (!result.activated) {
      // A concurrent request already verified this record.
      const current = await DomainVerification.findById(record._id).lean<DomainVerificationDoc>();
      if (current && domainStatusOf(current) === "verified") {
        const previousDomain = await activateVerifiedDomain(id, normalized, now);
        return ok({
          domain: normalized,
          verified: true,
          active: true,
          alreadyVerified: true,
          verifiedAt: current.verifiedAt ?? null,
          previousDomain,
        });
      }
      throw new HttpError(
        409,
        "Verification is already being processed. Reload to see the latest status.",
        "conflict",
      );
    }

    await recordDomainEvent({ businessId: id, domain: normalized, type: "verified" });
    return ok({
      domain: normalized,
      verified: true,
      active: true,
      alreadyVerified: false,
      verifiedAt: now,
      previousDomain: result.previousDomain,
    });
  });
}
