import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Studio: minimal editorial. Asymmetric hero, typographic category index, borderless portrait cards. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/studio.ts). */
export default function StudioTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.studio} />;
}
