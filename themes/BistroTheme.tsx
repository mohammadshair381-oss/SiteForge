import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Bistro: restaurants, cafés and food brands. Centred header, arched hero image, menu-style product list. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/bistro.ts). */
export default function BistroTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.bistro} />;
}
