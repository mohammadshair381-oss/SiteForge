import { dbConnect } from "@/lib/db";
import { toStorefrontView } from "@/lib/storefront";
import { getEntitlements } from "@/lib/billing";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { getStorefrontSettings } from "@/lib/storefront-settings";
import { loadBestSellerIds } from "@/lib/storefront-commerce";
import { loadPublicCategories } from "@/lib/categories";
import { recentApprovedReviews, reviewsWanted } from "@/lib/reviews";
import { categoryHref, type CommerceExtras } from "@/lib/storefront-home";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Page } from "@/models/Page";

export interface LinkOptionData {
  label: string;
  href: string;
}

/**
 * Everything a dashboard preview of the store needs, with the DRAFT
 * homepage: the same projection (`toStorefrontView`), data extras and draft
 * settings the website editor uses, so the setup wizard and the editor show
 * exactly what the store will render. Callers authorize first
 * (`requireBusinessRole`); this function trusts `businessId`.
 */
export async function loadStorefrontPreviewData(businessId: string, options: { liveFrame?: boolean; /** The editor: a reviews section can be added at any moment. */ reviews?: boolean } = {}) {
  await dbConnect();
  const [business, products, entitlements, pages] = await Promise.all([
    Business.findById(businessId).lean(),
    Product.find({ business: businessId, status: "active" }).sort({ createdAt: -1 }).lean(),
    getEntitlements(businessId),
    Page.find({ business: businessId }).lean(),
  ]);
  if (!business) return null;
  const [settings, bestSellerIds, managedCategories, onlinePayments] = await Promise.all([
    getStorefrontSettings(businessId),
    loadBestSellerIds(businessId),
    loadPublicCategories(businessId),
    isOnlinePaymentAvailable(businessId),
  ]);
  const reviewLimit = options.reviews
    ? 12
    : Math.max(
        reviewsWanted(settings.draft.sections),
        reviewsWanted(settings.published?.sections),
        reviewsWanted(business.themeSettings?.sections),
        ...pages.flatMap((page) => [reviewsWanted(page.sections), reviewsWanted(page.publishedSections)]),
      );
  const reviews = reviewLimit > 0 ? await recentApprovedReviews(businessId, reviewLimit) : [];
  const accountsEnabled = isCustomerAccountsEnabled();
  const view = { ...toStorefrontView(business, products, entitlements.removeBranding, pages, { useDraft: !options.liveFrame }), reviews };
  const publishedPages = pages.filter((p) => p.status === "published");
  const extras: CommerceExtras = {
    bestSellerIds,
    managedCategories,
    pageSlugs: publishedPages.map((p) => p.slug),
    accountsEnabled,
    onlinePayments,
    codAvailable: business.codEnabled === true && (accountsEnabled || business.guestCodEnabled === true),
  };
  const categoryNames = [...new Map(products.map((p) => (p.category ?? "").trim()).filter(Boolean).map((n) => [n.toLowerCase(), n] as const)).values()].sort((a, b) => a.localeCompare(b));
  const linkOptions: LinkOptionData[] = [
    { label: "All products", href: "/products" },
    ...managedCategories.filter((c) => c.active).map((c) => ({ label: `Category: ${c.name}`, href: `/category/${c.slug}` })),
    ...categoryNames.map((name) => ({ label: `Category: ${name}`, href: categoryHref(name) })),
    ...products.slice(0, 50).map((p) => ({ label: `Product: ${p.name}`, href: `/product/${p.slug}` })),
    ...publishedPages.filter((p) => !p.isHome).map((p) => ({ label: `Page: ${p.title}`, href: `/${p.slug}` })),
    { label: "Shipping & returns", href: "/policies" },
    { label: "Cart", href: "/cart" },
  ];
  return { business, products, pages, entitlements, settings, view, extras, categoryNames, linkOptions };
}
