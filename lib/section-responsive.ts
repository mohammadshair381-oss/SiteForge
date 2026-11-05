import { z } from "zod";

/**
 * Settings that differ by screen size, for one section (pure; safe in client components).
 * They become ordinary CSS media queries printed by the one storefront renderer, so a phone
 * and the editor's phone preview (an iframe at phone width) get exactly the same result.
 * Nothing here changes a section's content. An unset value keeps what the theme does.
 */
export const RESPONSIVE_DEVICES = ["desktop", "tablet", "mobile"] as const;
export type ResponsiveDevice = (typeof RESPONSIVE_DEVICES)[number];

export const responsiveRuleSchema = z
  .object({
    hidden: z.boolean().optional(),
    spacing: z.enum(["none", "small", "medium", "large"]).optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    columns: z.enum(["1", "2", "3", "4"]).optional(),
    contentWidth: z.enum(["narrow", "normal", "wide", "full"]).optional(),
    imageAlign: z.enum(["left", "center", "right"]).optional(),
  })
  .strict();
export type ResponsiveRule = z.infer<typeof responsiveRuleSchema>;

export const responsiveSettingsSchema = z
  .object({ desktop: responsiveRuleSchema.optional(), tablet: responsiveRuleSchema.optional(), mobile: responsiveRuleSchema.optional() })
  .strict();
export type ResponsiveSettings = z.infer<typeof responsiveSettingsSchema>;

/** Hidden on every screen size, so no visitor can see the section. */
export function hiddenOnEveryScreen(settings: ResponsiveSettings | null | undefined): boolean {
  return RESPONSIVE_DEVICES.every((device) => settings?.[device]?.hidden === true);
}

const MEDIA: Record<ResponsiveDevice, string> = {
  desktop: "(min-width:1024px)",
  tablet: "(min-width:640px) and (max-width:1023px)",
  mobile: "(max-width:639px)",
};
const SPACING = { none: "0", small: "2rem", medium: "4rem", large: "6rem" } as const;
const WIDTH = { narrow: "48rem", normal: "72rem", wide: "96rem", full: "none" } as const;
const IMAGE_MARGIN = { left: "0 auto 0 0", center: "0 auto", right: "0 0 0 auto" } as const;

function ruleCss(selector: string, rule: ResponsiveRule): string {
  const parts: string[] = [];
  if (rule.hidden) parts.push(`${selector}{display:none!important}`);
  // Twice in the selector, to stay ahead of the store-wide spacing in app/globals.css.
  if (rule.spacing) parts.push(`${selector}${selector} section{padding-top:${SPACING[rule.spacing]}!important;padding-bottom:${SPACING[rule.spacing]}!important}`);
  if (rule.textAlign) parts.push(`${selector} :is(h1,h2,h3,h4,p,blockquote){text-align:${rule.textAlign}!important}`);
  if (rule.columns) parts.push(`${selector} .grid{grid-template-columns:repeat(${rule.columns},minmax(0,1fr))!important}`);
  if (rule.contentWidth) parts.push(`${selector} .sf-container{max-width:${WIDTH[rule.contentWidth]}!important}`);
  if (rule.imageAlign) parts.push(`${selector} img{display:block;margin:${IMAGE_MARGIN[rule.imageAlign]}}`);
  return parts.join("");
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** CSS for many sections, each marked `data-rs="<id>"`. Ids and values are checked, so nothing else can reach the page. */
export function responsiveCss(sections: ReadonlyArray<{ id: string; responsive?: ResponsiveSettings | null }>): string {
  const rules: string[] = [];
  for (const section of sections) {
    if (!section.responsive || !SAFE_ID.test(section.id)) continue;
    const parsed = responsiveSettingsSchema.safeParse(section.responsive);
    if (!parsed.success) continue;
    for (const device of RESPONSIVE_DEVICES) {
      const rule = parsed.data[device];
      const css = rule ? ruleCss(`[data-rs="${section.id}"]`, rule) : "";
      if (css) rules.push(`@media ${MEDIA[device]}{${css}}`);
    }
  }
  return rules.join("\n");
}

/** Sets one value for one screen size, removing whatever becomes empty. */
export function withResponsiveValue(settings: ResponsiveSettings | undefined, device: ResponsiveDevice, key: keyof ResponsiveRule, value: string | boolean | undefined): ResponsiveSettings | undefined {
  const rule = { ...(settings?.[device] ?? {}) } as Record<string, unknown>;
  if (value === undefined || value === "" || value === false) delete rule[key];
  else rule[key] = value;
  const next = { ...(settings ?? {}) } as Record<string, unknown>;
  if (Object.keys(rule).length > 0) next[device] = rule;
  else delete next[device];
  return Object.keys(next).length > 0 ? (next as ResponsiveSettings) : undefined;
}
