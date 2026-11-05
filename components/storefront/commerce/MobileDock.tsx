import React from "react";
import Link from "next/link";
import type { StoreSkin } from "./skins";

/**
 * Quick navigation fixed to the bottom of small screens (themes with
 * `layout.dock`): home, shop and search, and the cart. Plain links to
 * existing routes; the page reserves room for it so nothing is covered.
 */
export default function MobileDock({ skin, hasProducts, editable, accountHref }: { skin: StoreSkin; hasProducts: boolean; editable?: boolean; accountHref?: string | null }) {
  const preventNav = editable ? (e: React.MouseEvent) => e.preventDefault() : undefined;
  const item = `flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-[11px] font-semibold ${skin.focus}`;
  const icon = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  return (
    <nav aria-label="Quick links" onClick={preventNav} className={`fixed inset-x-0 bottom-0 z-30 border-t pb-[env(safe-area-inset-bottom)] md:hidden ${skin.border} ${skin.panel}`}>
      <ul className="mx-auto flex max-w-md items-stretch gap-1 px-3 py-1.5">
        <li className="flex flex-1">
          <Link href="/" className={item}>
            <svg {...icon}><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z" /></svg>
            Home
          </Link>
        </li>
        {hasProducts && (
          <>
            <li className="flex flex-1">
              <a href="/products" className={item}>
                <svg {...icon}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>
                Shop
              </a>
            </li>
            <li className="flex flex-1">
              <a href="/products#catalog-search" className={item}>
                <svg {...icon}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                Search
              </a>
            </li>
          </>
        )}
        <li className="flex flex-1">
          <a href="/cart" className={item}>
            <svg {...icon}><path d="M6 7h12l-1 13H7L6 7Z" /><path d="M9 7a3 3 0 0 1 6 0" /></svg>
            Cart
          </a>
        </li>
        {accountHref && (
          <li className="flex flex-1">
            <a href={accountHref} className={item}>
              <svg {...icon}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
              Account
            </a>
          </li>
        )}
      </ul>
    </nav>
  );
}
