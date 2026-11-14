import CommerceShell from "@/components/storefront/commerce/CommerceShell";
import { STORE_SKINS } from "@/components/storefront/commerce/skins";
import type { ThemeProps } from "./types";

/** Harvest: grocery and daily essentials. Mobile-first: search in reach, quick dock, category bubbles, one-tap add. Layout variants, behaviour and data come from the shared commerce shell (skin: themes/skins/harvest.ts). */
export default function HarvestTheme(props: ThemeProps) {
  return <CommerceShell {...props} skin={STORE_SKINS.harvest} />;
}
