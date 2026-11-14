import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Forma: furniture and home decor. Room hero with caption card, alternating collection stories, spacious gallery cards. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/forma.ts). */
export default function FormaTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.forma} />;
}
