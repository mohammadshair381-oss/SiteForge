import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Aurora: premium modern lifestyle. Immersive full-height hero, bento category mosaic, large lifting cards. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/aurora.ts). */
export default function AuroraTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.aurora} />;
}
