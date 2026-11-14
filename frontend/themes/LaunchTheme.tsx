import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Launch: bold modern DTC. Giant statement hero, marquee, colour-block categories, offset-shadow cards. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/launch.ts). */
export default function LaunchTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.launch} />;
}
