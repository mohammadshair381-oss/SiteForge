import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Market: professional retail. Search-first header with category bar, dense grids, catalog filter sidebar. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/market.ts). */
export default function MarketTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.market} />;
}
