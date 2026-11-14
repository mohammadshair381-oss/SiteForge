import { dbConnect } from "@/lib/db";
import { getEntitlements } from "@/lib/billing";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { readSetupProgress, type SetupFacts, type SetupProgress } from "@/lib/store-setup";
import { Business, type BusinessDoc } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";

/**
 * The real state of a store for the setup wizard and the overview's setup
 * card (lib/store-setup.ts turns it into step states and readiness). Callers
 * authorize first (`requireBusinessRole`) and pass the signed-in user.
 */
export async function loadSetupFacts(
  businessId: string,
  user: { emailVerifiedAt?: Date | null },
): Promise<{ business: BusinessDoc; facts: SetupFacts; progress: SetupProgress; settings: Awaited<ReturnType<typeof getStorefrontSettings>>; entitlements: Awaited<ReturnType<typeof getEntitlements>> } | null> {
  await dbConnect();
  const [business, entitlements, settings, activeProducts, withoutImage, onlinePayments, otherPages] = await Promise.all([
    Business.findById(businessId).lean<BusinessDoc>(),
    getEntitlements(businessId),
    getStorefrontSettings(businessId),
    Product.countDocuments({ business: businessId, status: "active" }),
    Product.countDocuments({ business: businessId, status: "active", $or: [{ imageUrl: "" }, { imageUrl: null }, { imageUrl: { $exists: false } }] }),
    isOnlinePaymentAvailable(businessId),
    Page.countDocuments({ business: businessId, isHome: { $ne: true } }),
  ]);
  if (!business) return null;
  const facts: SetupFacts = {
    name: business.name ?? "",
    description: business.description ?? "",
    contactEmail: business.contactEmail ?? "",
    phone: business.phone ?? "",
    address: business.address ?? "",
    serviceArea: business.serviceArea ?? "",
    otherPages,
    logoUrl: business.logoUrl ?? "",
    activeProducts,
    activeProductsWithoutImage: withoutImage,
    shippingConfigured: business.shippingSettings !== undefined && business.shippingSettings !== null,
    policies: { shipping: Boolean(settings.draft.policies.shipping.trim()), returns: Boolean(settings.draft.policies.returns.trim()) },
    codEnabled: business.codEnabled === true,
    guestCodEnabled: business.guestCodEnabled === true,
    accountsEnabled: isCustomerAccountsEnabled(),
    onlinePaymentsConnected: onlinePayments,
    // Absent = legacy account (grandfathered as verified); only explicit null is unverified.
    emailVerified: user.emailVerifiedAt !== null,
    planActive: entitlements.active,
    suspended: business.status === "suspended",
    published: business.status === "published",
  };
  return { business, facts, progress: readSetupProgress(business.setup), settings, entitlements };
}
