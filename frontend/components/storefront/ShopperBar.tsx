import Link from "next/link";

/**
 * Thin shopping bar shown above every public storefront page, whatever the
 * theme: a persistent way back to the cart and, when customer accounts are
 * enabled, to the customer's account. Rendered only by public storefront
 * routes (never in dashboard previews). Server component; no client JS.
 */
export default function ShopperBar({
  storeName,
  accountsEnabled,
  signedInName,
}: {
  storeName: string;
  accountsEnabled: boolean;
  /** First name or full name of a signed-in customer of this store, if any. */
  signedInName: string | null;
}) {
  return (
    <nav aria-label="Shopping" className="border-b border-slate-200 bg-white/95 text-slate-700">
      <div className="mx-auto flex max-w-6xl items-center justify-end gap-4 px-4 py-1.5 text-sm sm:px-6">
        <span className="sr-only">{storeName}</span>
        <Link
          href="/products"
          className="mr-auto rounded px-1 font-medium hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          All products
        </Link>
        {accountsEnabled && (
          <Link
            href={signedInName ? "/account" : "/account/login"}
            className="rounded px-1 font-medium hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
          >
            {signedInName ? `Account (${signedInName})` : "Sign in"}
          </Link>
        )}
        <Link
          href="/cart"
          className="rounded px-1 font-semibold hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          Cart
        </Link>
      </div>
    </nav>
  );
}
