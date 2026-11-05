import { THEME_IDS, type ThemeId } from "./constants";
import { brandPresetFor } from "./brand-presets";

/**
 * Plan-based theme access: the pure rules (no I/O; safe in client code).
 *
 * Each plan may list the themes it includes (`Plan.features.themes`, set in
 * the Super Admin plan manager). A plan without that list uses the default
 * tier below, decided by its key (and price for unknown free plans). This is
 * the ONLY place the default distribution is written down; `lib/billing.ts`
 * `getEntitlements` turns it into the business's entitlement.
 */

/** Free tier: Bistro, Market, Studio. */
export const FREE_THEMES: readonly ThemeId[] = ["bistro", "market", "studio"];
/** Starter tier: the Free themes plus Aurora, Launch, Harvest. */
export const STARTER_THEMES: readonly ThemeId[] = [...FREE_THEMES, "aurora", "launch", "harvest"];
/** Max tier: all nine (Atelier, Volt and Forma added). */
export const MAX_THEMES: readonly ThemeId[] = [...THEME_IDS];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** Known, de-duplicated theme ids in catalogue order (unknown values dropped). */
export function normalizeThemeList(value: unknown): ThemeId[] {
  const list = Array.isArray(value) ? value : [];
  return THEME_IDS.filter((id) => list.includes(id));
}

/**
 * Themes a plan includes: its explicit list when it has a valid, non-empty
 * one, otherwise the default tier for its key. Unknown paid plans get every
 * theme (the top tier); unknown free plans get the Free tier.
 */
export function planThemes(plan: { key?: string | null; price?: number | null; features?: { themes?: unknown } | null } | null | undefined): ThemeId[] {
  if (!plan) return [...FREE_THEMES];
  const explicit = normalizeThemeList(plan.features?.themes);
  if (explicit.length > 0) return explicit;
  const key = (plan.key ?? "").toLowerCase();
  if (key === "free") return [...FREE_THEMES];
  if (key === "starter") return [...STARTER_THEMES];
  if (key === "max" || key === "pro") return [...MAX_THEMES];
  return plan.price === 0 ? [...FREE_THEMES] : [...MAX_THEMES];
}

/**
 * Preference order of themes for a business type, best first. The first
 * entry is the dedicated theme; later ones are good alternatives on smaller
 * plans. `defaultThemeFor` picks the first one the plan includes.
 */
export function themePreferenceFor(businessType: string | null | undefined): ThemeId[] {
  const type = (businessType ?? "").toLowerCase();
  // Food & beverage is usually a café or restaurant: Bistro first.
  if (type === "food") return ["bistro", "harvest", "market"];
  const preset = brandPresetFor(businessType);
  const alternatives: Record<string, ThemeId[]> = {
    general: ["market", "studio"],
    clothing: ["atelier", "studio", "launch"],
    shoes: ["launch", "studio", "market"],
    electronics: ["volt", "launch", "market"],
    grocery: ["harvest", "market"],
    furniture: ["forma", "studio", "bistro"],
    cosmetics: ["aurora", "studio"],
    hardware: ["launch", "market"],
    services: ["studio", "market", "aurora"],
    realestate: ["forma", "studio", "aurora"],
    fitness: ["launch", "aurora", "market"],
    education: ["market", "studio", "launch"],
    creative: ["atelier", "studio", "aurora"],
  };
  const order = [preset.theme, ...(alternatives[preset.key] ?? []), "market", "studio", "bistro"] as ThemeId[];
  return order.filter((id, index) => order.indexOf(id) === index);
}

/** The best theme for a business type that the plan includes (never a locked one). */
export function defaultThemeFor(businessType: string | null | undefined, allowed: readonly ThemeId[]): ThemeId {
  const preferred = themePreferenceFor(businessType).find((id) => allowed.includes(id));
  return preferred ?? allowed[0] ?? FREE_THEMES[0];
}

export interface ThemeTierPlan {
  key: string;
  name: string;
  price: number;
  currency: string;
  interval: string;
  themes: ThemeId[];
}

/**
 * The cheapest active plan that includes each theme (upgrade information for
 * locked themes); null when no active plan includes it.
 */
export function cheapestPlanFor(plans: ThemeTierPlan[]): Record<ThemeId, ThemeTierPlan | null> {
  const sorted = [...plans].sort((a, b) => a.price - b.price);
  return Object.fromEntries(THEME_IDS.map((id) => [id, sorted.find((plan) => plan.themes.includes(id)) ?? null])) as Record<ThemeId, ThemeTierPlan | null>;
}

/**
 * What a business may do with each theme (serializable; computed on the
 * server, used by every picker so they all show the same rules).
 * - `current`: the business's theme; always usable, even when the plan no
 *   longer includes it (grandfathered: a downgrade never changes a store).
 * - `allowed`: themes the plan includes (selectable).
 * - `requiredPlan`: the cheapest plan including each theme (upgrade info).
 */
export interface ThemeAccess {
  current: ThemeId;
  allowed: ThemeId[];
  planName: string;
  requiredPlan: Record<ThemeId, { key: string; name: string } | null>;
  /** The current theme is kept from an earlier plan. */
  grandfathered: boolean;
}

export function canSelectTheme(access: Pick<ThemeAccess, "current" | "allowed">, themeId: string): boolean {
  return themeId === access.current || (access.allowed as string[]).includes(themeId);
}
