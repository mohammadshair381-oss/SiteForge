import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import ShopperBar from "@/components/storefront/ShopperBar";
import { shopperBarProps } from "@/lib/storefront-shopper";
import { notFound } from "next/navigation";
import { getPublicStorefront, resolveBusinessByHost } from "@/lib/tenant";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { readableOn, skinFor, surfaceVars } from "@/components/storefront/commerce/skins";
import { isValidObjectId } from "@/lib/ids";
import { dbConnect } from "@/lib/db";
import { Order } from "@/models/Order";
import OrderStatusView from "@/components/storefront/OrderStatusView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Your order" },
  robots: { index: false },
};

/**
 * Order confirmation/status. Uses `resolveBusinessByHost` (not the storefront
 * gate) so a customer can still see and cancel an order after the store goes
 * offline, matching the order status/cancel APIs. The order itself is only
 * fetched client-side with the httpOnly ownership cookie.
 */
export default async function StorefrontOrder({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ payment?: string | string[] }>;
}) {
  const { orderId } = await params;
  const { payment } = await searchParams;
  // Display hint only (see OrderStatusView); restricted to known values.
  const paymentResult =
    typeof payment === "string" && ["success", "pending", "failed", "review"].includes(payment) ? payment : null;
  if (!isValidObjectId(orderId)) notFound();
  const headerList = await headers();
  const business = await resolveBusinessByHost(headerList.get("host"));
  if (!business) notFound();
  const color = business.themeSettings?.primaryColor || "#4f46e5";

  // A live store shows its usual header and footer; an offline one (orders
  // stay viewable) keeps the minimal frame.
  const store = await getPublicStorefront(headerList.get("host"));
  if (store) {
    const { view, commerce } = await loadStorefrontFrame(store, headerList.get("cookie"));
    return (
      <StoreFrame view={view} commerce={commerce}>
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12" style={surfaceVars(skinFor(view.themeId), view.theme.primaryColor)}>
          <h1 className={`mb-6 text-3xl sm:text-4xl ${skinFor(view.themeId).heroHeading}`}>Your order</h1>
          <OrderStatusView businessId={String(business._id)} orderId={orderId} paymentResult={paymentResult} />
        </div>
      </StoreFrame>
    );
  }
  // Orders stay viewable, but an offline store's name is not for just any address.
  await dbConnect();
  if (!(await Order.exists({ _id: orderId, business: business._id }))) notFound();
  const bar = await shopperBarProps(business, headerList.get("cookie"));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <ShopperBar {...bar} />
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-bold" style={{ color }}>
          {business.name}
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-6 pb-16" style={{ "--sf-accent": color, "--sf-accent-text": readableOn(color) } as React.CSSProperties}>
        <h1 className="mb-6 text-3xl font-extrabold">Your order</h1>
        <OrderStatusView businessId={String(business._id)} orderId={orderId} paymentResult={paymentResult} />
      </main>
    </div>
  );
}
