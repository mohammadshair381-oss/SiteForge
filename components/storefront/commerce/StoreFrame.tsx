import React from "react";
import type { StorefrontView } from "@/lib/storefront";
import type { CommerceData } from "@/lib/storefront-home";
import { skinFor, storeRootProps } from "./skins";
import StoreHeader from "./StoreHeader";
import StoreFooter from "./StoreFooter";
import MotionRoot from "./MotionRoot";
import MobileDock from "./MobileDock";

/**
 * Themed page frame for the store's inner pages (catalog, product, cart,
 * order, account): the same header and footer as the homepage, in the
 * store's theme, around the page's own content.
 */
export default function StoreFrame({
  view,
  commerce,
  children,
}: {
  view: StorefrontView;
  commerce: CommerceData;
  children: React.ReactNode;
}) {
  const skin = skinFor(view.themeId);
  const root = storeRootProps(skin, view.theme);
  return (
    <div className={`${root.className} ${skin.layout.dock ? "pb-16 md:pb-0" : ""}`} style={root.style} data-theme={view.themeId}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-gray-900">
        Skip to content
      </a>
      <StoreHeader view={view} commerce={commerce} skin={skin} />
      <main id="main" className="flex-1">{children}</main>
      <StoreFooter view={view} commerce={commerce} skin={skin} />
      {skin.layout.dock && <MobileDock skin={skin} hasProducts={commerce.totalProducts > 0} accountHref={commerce.header.accountsEnabled ? (commerce.header.signedInName || commerce.header.signedInUnverified ? "/account" : "/account/login") : null} />}
      <MotionRoot />
    </div>
  );
}
