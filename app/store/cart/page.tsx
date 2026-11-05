import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import CartCheckout, { type CheckoutAccount, type SavedAddress } from "@/components/storefront/CartCheckout";
import { listCustomerAddresses } from "@/lib/customer-addresses";
import { isOnlinePaymentAvailable } from "@/lib/payments/order-payments";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { skinFor, surfaceVars } from "@/components/storefront/commerce/skins";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "Your cart" },
  robots: { index: false },
};

export default async function StorefrontCart() {
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) notFound();

  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  // A few of this store's own products that can be bought, for an empty cart.
  const catalog = view.products
    .filter((product) => product.availability !== "out_of_stock")
    .slice(0, 3)
    .map((product) => ({
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: product.price,
      currency: product.currency,
      imageUrl: product.imageUrl,
    }));

  // Display only: the checkout API re-checks all of this server-side.
  const accountsEnabled = isCustomerAccountsEnabled();
  const guestCod = result.business.codEnabled === true && result.business.guestCodEnabled === true;
  const codOffered = result.business.codEnabled === true && (accountsEnabled || guestCod);
  const onlineOffered = await isOnlinePaymentAvailable(result.business._id);
  let account: CheckoutAccount = null;
  let savedAddresses: SavedAddress[] = [];
  if (accountsEnabled) {
    const resolution = await resolveCheckoutCustomer(
      new Request("http://storefront.invalid/cart", { headers: { cookie: headerList.get("cookie") ?? "" } }),
      result.business,
    );
    account =
      resolution.status === "customer"
        ? { status: "signed_in", name: resolution.customer.name, email: resolution.customer.email }
        : { status: resolution.status === "unverified" ? "unverified" : "signed_out" };
    if (resolution.status === "customer") savedAddresses = await listCustomerAddresses(result.business._id, resolution.customer.id);
  }

  return (
    <StoreFrame view={view} commerce={commerce}>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12" style={surfaceVars(skinFor(view.themeId), view.theme.primaryColor)}>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className={`text-3xl sm:text-4xl ${skinFor(view.themeId).heroHeading}`}>Your cart</h1>
          <Link href="/products" className="text-sm font-medium underline-offset-4 hover:underline">
            ← Continue shopping
          </Link>
        </div>
        <CartCheckout
          businessId={view.id}
          catalog={catalog}
          codOffered={codOffered}
          guestCod={guestCod}
          onlineOffered={onlineOffered}
          account={account}
          savedAddresses={savedAddresses}
        />
      </div>
    </StoreFrame>
  );
}
