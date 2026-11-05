import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Atelier: luxury fashion and jewellery. Full-bleed campaign hero, Didone type, tall portrait cards with image rollover. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/atelier.ts). */
export default function AtelierTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.atelier} />;
}
