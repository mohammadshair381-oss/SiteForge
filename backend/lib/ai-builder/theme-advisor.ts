import { z } from "zod";
import { BUSINESS_CATEGORIES, THEME_IDS, type ThemeId } from "@/lib/constants";
import { THEMES, getThemeMeta } from "@/lib/themes";
import { canSelectTheme, themePreferenceFor, type ThemeAccess } from "@/lib/theme-tiers";

/**
 * AI theme recommendations (pure; no I/O). The provider compares the nine
 * themes for the store; the SERVER then decides what the owner may do with
 * each recommendation from the business's own plan (`ThemeAccess`): a theme
 * the plan does not include is never offered as selectable, and the plan
 * that unlocks it is named. Applying a theme is the normal theme change
 * (`PATCH /api/businesses/[id]`, `assertCanUseTheme`); nothing is saved here.
 */

const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const text = (max: number) => z.string().trim().max(max).refine(noHtml, "HTML is not supported");

export const themeAdviceSchema = z
  .object({
    summary: text(400).pipe(z.string().min(1)),
    recommendations: z.array(z.object({ themeId: z.enum(THEME_IDS), reason: text(300).pipe(z.string().min(1)) }).strict()).min(1).max(3),
    notes: z.array(text(200)).max(5).prefault([]),
  })
  .strict();
export type ThemeAdvice = z.infer<typeof themeAdviceSchema>;

export interface ThemeRecommendation {
  themeId: ThemeId;
  name: string;
  identity: string;
  reason: string;
  current: boolean;
  /** The plan includes it (or it is the current theme): it can be applied now. */
  selectable: boolean;
  /** For a locked theme: the cheapest active plan that includes it. */
  requiredPlan: { key: string; name: string } | null;
}

/** The theme catalogue as provider input (static product data, not store data). */
export function themeCatalog() {
  return THEMES.map((t) => ({ id: t.id, name: t.name, identity: t.identity, bestFor: t.bestFor, look: t.visual, motion: t.motion }));
}

function withAccess(themeId: ThemeId, reason: string, access: ThemeAccess): ThemeRecommendation {
  const meta = getThemeMeta(themeId);
  const selectable = canSelectTheme(access, themeId);
  return {
    themeId,
    name: meta.name,
    identity: meta.identity,
    reason,
    current: access.current === themeId,
    selectable,
    requiredPlan: selectable ? null : access.requiredPlan[themeId],
  };
}

/** The provider's recommendations, de-duplicated, with what this plan allows. */
export function recommendationsWithAccess(advice: ThemeAdvice, access: ThemeAccess): ThemeRecommendation[] {
  const seen = new Set<ThemeId>();
  return advice.recommendations
    .filter((r) => (seen.has(r.themeId) ? false : (seen.add(r.themeId), true)))
    .map((r) => withAccess(r.themeId, r.reason, access));
}

/**
 * Recommendations without AI (AI off, or no consent): the themes designed for
 * the business type, in order, from the catalogue. Clearly labelled as such.
 */
export function fallbackRecommendations(businessType: string | null | undefined, access: ThemeAccess): ThemeRecommendation[] {
  return themePreferenceFor(businessType)
    .slice(0, 3)
    .map((id) => {
      const meta = getThemeMeta(id);
      const names = meta.bestFor.slice(0, 3).map((key) => BUSINESS_CATEGORIES.find((c) => c.key === key)?.name ?? key);
      return withAccess(id, `${meta.identity}${names.length > 0 ? ` Designed for ${names.join(", ")}.` : ""}`, access);
    });
}
