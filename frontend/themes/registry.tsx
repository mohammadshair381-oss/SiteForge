import type { ComponentType } from "react";
import type { ThemeId } from "@/lib/constants";
import type { ThemeProps } from "./types";
import AuroraTheme from "./AuroraTheme";
import MarketTheme from "./MarketTheme";
import BistroTheme from "./BistroTheme";
import StudioTheme from "./StudioTheme";
import LaunchTheme from "./LaunchTheme";
import AtelierTheme from "./AtelierTheme";
import VoltTheme from "./VoltTheme";
import HarvestTheme from "./HarvestTheme";
import FormaTheme from "./FormaTheme";

export const THEME_COMPONENTS: Record<ThemeId, ComponentType<ThemeProps>> = {
  aurora: AuroraTheme,
  market: MarketTheme,
  bistro: BistroTheme,
  studio: StudioTheme,
  launch: LaunchTheme,
  atelier: AtelierTheme,
  volt: VoltTheme,
  harvest: HarvestTheme,
  forma: FormaTheme,
};

export function resolveThemeComponent(themeId: string): ComponentType<ThemeProps> {
  return THEME_COMPONENTS[themeId as ThemeId] ?? AuroraTheme;
}
