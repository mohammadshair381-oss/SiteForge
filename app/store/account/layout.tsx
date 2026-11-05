import type { CSSProperties, ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readableTextColor } from "@/lib/color-contrast";
import { isCustomerAccountsEnabled } from "@/lib/env";
import { getPublicStorefront } from "@/lib/tenant";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import { accountVars, skinFor } from "@/components/storefront/commerce/skins";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";

export const dynamic = "force-dynamic";

// Account pages are private: never indexed, and token-bearing URLs are never
// sent on as a Referer.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Shared frame for storefront customer account pages: the store's own header
 * and footer, and the active theme's account tokens (`accountVars`). Only an
 * eligible (published, entitled) storefront renders them; anything else is a
 * 404, matching the account API gate.
 */
export default async function StorefrontAccountLayout({ children }: { children: ReactNode }) {
  // Feature gate (default off): same 404 as the account API.
  if (!isCustomerAccountsEnabled()) notFound();
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) notFound();
  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  const skin = skinFor(view.themeId);
  const accent = view.theme.primaryColor;

  return (
    <StoreFrame view={view} commerce={commerce}>
      <div
        className={`${skin.container} pb-16 pt-8 sm:pt-12`}
        style={
          {
            ...accountVars(skin),
            // Set here, inside the store root, which uses the same name for its second colour.
            "--sf-accent": accent,
            // Black or white, whichever contrasts more with the theme colour.
            "--sf-accent-text": readableTextColor(accent) ?? "#ffffff",
          } as CSSProperties
        }
      >
        {children}
      </div>
    </StoreFrame>
  );
}
