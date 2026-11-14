import { Types } from "mongoose";
import { dbConnect } from "@/lib/db";
import { Order } from "@/models/Order";
import { Page } from "@/models/Page";
import type { BusinessDoc } from "@/models/Business";
import type { ProductDoc } from "@/models/Product";
import { toStorefrontView, type StorefrontView } from "@/lib/storefront";
import { buildCommerceData, type CommerceData } from "@/lib/storefront-home";
import { shopperBarProps } from "@/lib/storefront-shopper";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import { loadPublicCategories } from "@/lib/categories";

/**
 * Server-only: loads the real data the public storefront chrome and homepage
 * need (published config, published page slugs, best sellers from PAID
 * orders, account state, payment options) and builds `CommerceData`.
 * Everything is scoped to the Host-resolved business.
 */

/** Window for "best sellers": paid orders from the last N days. */
const BEST_SELLER_DAYS = 180;

export async function loadBestSellerIds(businessId: unknown, now = new Date()): Promise<string[]> {
  await dbConnect();
  const since = new Date(now.getTime() - BEST_SELLER_DAYS * 24 * 60 * 60 * 1000);
  const business = new Types.ObjectId(String(businessId));
  const rows = await Order.aggregate<{ _id: string; units: number }>([
    { $match: { business, status: "paid", paidAt: { $gte: since } } },
    { $unwind: "$items" },
    { $group: { _id: "$items.product", units: { $sum: "$items.quantity" } } },
    { $match: { units: { $gt: 0 } } },
    { $sort: { units: -1, _id: 1 } },
    { $limit: 12 },
  ]);
  return rows.map((row) => String(row._id));
}

/**
 * Builds the public view (with published navigation) and the commerce data
 * for one Host-resolved store. Used by every public storefront route so the
 * header, footer and homepage are the same everywhere.
 */
export async function loadStorefrontFrame(
  result: { business: BusinessDoc; products: ProductDoc[]; removeBranding: boolean },
  cookieHeader: string | null,
): Promise<{ view: StorefrontView; commerce: CommerceData }> {
  await dbConnect();
  const { business } = result;
  const [pages, bestSellerIds, shopper, onlinePayments, managedCategories] = await Promise.all([
    Page.find({ business: business._id, status: "published" }).select("title slug status").lean<Array<{ _id: unknown; title: string; slug: string; status: string }>>(),
    loadBestSellerIds(business._id),
    shopperBarProps(business, cookieHeader),
    isOnlinePaymentAvailable(business._id),
    loadPublicCategories(business._id),
  ]);
  const view = toStorefrontView(business, result.products, result.removeBranding, pages);
  const settings = (business.themeSettings ?? {}) as unknown as Record<string, unknown>;
  const commerce = buildCommerceData(view, settings.publishedStorefront, {
    bestSellerIds,
    pageSlugs: pages.map((p) => p.slug).filter(Boolean),
    accountsEnabled: shopper.accountsEnabled,
    signedInName: shopper.signedInName,
    signedInUnverified: shopper.signedInUnverified,
    onlinePayments,
    codAvailable: business.codEnabled === true && (shopper.accountsEnabled || business.guestCodEnabled === true),
    managedCategories,
  });
  return { view, commerce };
}
