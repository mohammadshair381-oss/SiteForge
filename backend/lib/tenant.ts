import { dbConnect } from "./db";
import { extractSubdomain, normalizeHost } from "./host";
import { getEntitlements } from "./billing";
import { domainMayServeInProduction } from "./domains/lifecycle";
import { Business, type BusinessDoc } from "@/models/Business";
import {
  DomainVerification,
  domainStatusOf,
  isDomainOwnershipFresh,
  type DomainVerificationDoc,
} from "@/models/DomainVerification";
import { Product, type ProductDoc } from "@/models/Product";

export interface StorefrontResult {
  business: BusinessDoc;
  products: ProductDoc[];
}

export function resolveHostToSubdomain(host: string | null | undefined) {
  return extractSubdomain(host);
}

/**
 * Resolves the business that owns a given request host. A host can map via a
 * tenant subdomain or a verified custom domain.
 *
 * Custom-domain routing is fail-closed and authoritative:
 * - the DomainVerification record must be effectively `verified` (legacy
 *   records without a status field are normalized by `domainStatusOf`), and
 * - `Business.customDomain` must equal the requested host. Removing a domain
 *   clears that field, so routing stops immediately, and a verified secondary
 *   domain never routes while another domain is active.
 *
 * Returns null when nothing matches; callers should 404.
 */
export async function resolveBusinessByHost(
  host: string | null | undefined,
): Promise<BusinessDoc | null> {
  await dbConnect();

  const subdomain = extractSubdomain(host);
  if (subdomain) {
    return Business.findOne({ subdomain });
  }

  const normalized = normalizeHost(host).split(":")[0];
  if (!normalized) return null;

  const verification = await DomainVerification.findOne({
    domain: normalized,
  }).lean<DomainVerificationDoc>();

  // Only match custom domains that have completed DNS ownership verification.
  // `expiresAt` is deliberately not consulted: it only bounds pending tokens.
  if (!verification || !verification.verifiedAt) return null;
  if (domainStatusOf(verification) !== "verified") return null;

  // Ownership proof must be fresh (local timestamp check, no DNS lookup). A
  // stale domain stays verified but does not serve until the owner renews.
  if (!isDomainOwnershipFresh(verification)) return null;

  // Proving ownership does not make a new domain ready to serve: in production it must
  // also have been activated. A stored certificate date never stops one here, because it
  // may have been renewed since the last check, and TLS has already happened by this point.
  // Local development and tests have no TLS to confirm.
  if (process.env.NODE_ENV === "production" && !domainMayServeInProduction(verification)) return null;

  const business = await Business.findById(verification.business);
  if (!business) return null;

  // The business document is the single source of truth for the active domain.
  if (business.customDomain !== normalized) return null;

  // Fail closed: custom domain requires the customDomain plan entitlement.
  const entitlements = await getEntitlements(business._id.toString());
  if (!entitlements.active || !entitlements.customDomain) {
    return null;
  }

  return business;
}

/**
 * Resolves the business a guest may *buy from* on this host. Commerce uses the
 * same eligibility as the public storefront: the business must be published
 * and hold an active subscription entitlement (custom-domain entitlement is
 * already enforced by `resolveBusinessByHost`). A suspended, unpublished or
 * lapsed store therefore cannot take carts or stock-reserving orders.
 *
 * Order *status* and *cancellation* deliberately keep using
 * `resolveBusinessByHost`: a guest must still be able to see and cancel (and so
 * release the stock of) an order placed before the store went offline.
 */
export async function resolveCommerceBusiness(
  host: string | null | undefined,
): Promise<BusinessDoc | null> {
  const business = await resolveBusinessByHost(host);
  if (!business || business.status !== "published") return null;
  const entitlements = await getEntitlements(business._id.toString());
  return entitlements.active ? business : null;
}

/**
 * Public storefront data. A storefront is exposed only when ALL checks pass:
 *
 *  1. The business is explicitly `published` by its owner. Suspended, draft and
 *     otherwise unpublished businesses stay hidden, so subscription
 *     eligibility can never bypass a suspension or an unpublish.
 *  2. The business has an active subscription entitlement, evaluated with the
 *     same `getEntitlements(...).active` predicate the publish route
 *     (`assertCanPublish`) and the dashboard use. This means a published
 *     business whose paid subscription has since expired stops serving its
 *     storefront, while a valid free-plan storefront keeps working.
 *  3. When resolved via a custom domain, the business's plan must include the
 *     `customDomain` feature entitlement. An expired or downgraded plan denies
 *     access.
 *
 * The entitlement check is read-only: a visitor request never mutates the
 * subscription, the business, or its products. If the business becomes
 * eligible again (e.g. the subscription is renewed) and is still published, the
 * storefront automatically becomes accessible again. Failing closed: a
 * missing, incomplete or expired subscription denies access.
 */
export async function getPublicStorefront(
  host: string | null | undefined,
): Promise<{ business: BusinessDoc; products: ProductDoc[]; removeBranding: boolean } | null> {
  const business = await resolveBusinessByHost(host);
  if (!business || business.status !== "published") return null;

  // Reuse the shared billing helper so eligibility has a single definition.
  const entitlements = await getEntitlements(business._id.toString());
  if (!entitlements.active) return null;

  // Custom domains require the customDomain feature on the active plan.
  const normalized = normalizeHost(host).split(":")[0];
  if (
    normalized &&
    business.customDomain &&
    business.customDomain === normalized &&
    !entitlements.customDomain
  ) {
    return null;
  }

  const products = await Product.find({
    business: business._id,
    status: "active",
  })
    .select("name slug description price compareAtPrice currency imageUrl images category stock createdAt options variants lowStockThreshold ratingAverage ratingCount seoTitle seoDescription imageAlt")
    .sort({ createdAt: -1 })
    .lean<ProductDoc[]>();

  return { business, products, removeBranding: entitlements.removeBranding };
}
