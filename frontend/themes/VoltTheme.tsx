import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Volt: electronics and gadgets. Dark spotlight hero, option chips on cards, specification and comparison tables. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/volt.ts). */
export default function VoltTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.volt} />;
}
