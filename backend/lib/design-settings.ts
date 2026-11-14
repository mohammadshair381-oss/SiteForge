import { z } from "zod";
import { THEME_IDS, type ThemeId } from "./constants";

/**
 * Store-wide design choices (pure; safe in client components).
 *
 * A theme keeps its own compositions whatever is chosen here: these settings
 * only replace its typefaces, button corners, text size and colours. "theme"
 * always means "what this theme does by itself".
 *
 * - Live: `themeSettings.primaryColor`, `accentColor`, `themeSettings.design` and
 *   `Business.themeId`.
 * - Draft: `themeSettings.designDraft`, shown in the editor and previews only,
 *   applied by `publishDesignDraft` (lib/design-service.ts).
 */
export const DESIGN_FONTS = ["theme", "sora", "jakarta", "hanken", "archivo", "space", "rounded", "didone", "fraunces", "newsreader", "serif", "mono"] as const;
export type DesignFont = (typeof DESIGN_FONTS)[number];

export const DESIGN_FONT_LABELS: Record<DesignFont, string> = {
  theme: "The theme's own",
  sora: "Sora (modern)",
  jakarta: "Plus Jakarta (friendly)",
  hanken: "Hanken (clean)",
  archivo: "Archivo (bold)",
  space: "Space Grotesk (technical)",
  rounded: "Nunito (rounded)",
  didone: "Bodoni (fashion)",
  fraunces: "Fraunces (warm serif)",
  newsreader: "Newsreader (editorial serif)",
  serif: "System serif",
  mono: "System monospace",
};

export const BUTTON_SHAPES = ["theme", "square", "rounded", "pill"] as const;
export type ButtonShape = (typeof BUTTON_SHAPES)[number];
export const BUTTON_SHAPE_LABELS: Record<ButtonShape, string> = { theme: "The theme's own", square: "Square", rounded: "Rounded", pill: "Pill" };

export const TEXT_SIZES = ["small", "normal", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_LABELS: Record<TextSize, string> = { small: "Smaller", normal: "Normal", large: "Larger" };

export const HEADING_WEIGHTS = ["theme", "400", "500", "600", "700", "800"] as const;
export const BODY_WEIGHTS = ["theme", "300", "400", "500"] as const;
export const HEADING_SIZES = ["normal", "smaller", "larger"] as const;
export const HEADING_SIZE_LABELS: Record<(typeof HEADING_SIZES)[number], string> = { normal: "The theme's own", smaller: "Smaller", larger: "Larger" };
export const BUTTON_STYLES = ["theme", "outline", "soft"] as const;
export const BUTTON_STYLE_LABELS: Record<(typeof BUTTON_STYLES)[number], string> = { theme: "The theme's own", outline: "Outlined", soft: "Soft tint" };
export const RADII = ["theme", "none", "small", "medium", "large"] as const;
export const RADIUS_LABELS: Record<(typeof RADII)[number], string> = { theme: "The theme's own", none: "Square", small: "Slightly rounded", medium: "Rounded", large: "Very rounded" };
export const SECTION_SPACINGS = ["theme", "compact", "spacious"] as const;
export const SECTION_SPACING_LABELS: Record<(typeof SECTION_SPACINGS)[number], string> = { theme: "The theme's own", compact: "Compact", spacious: "Spacious" };
export const CONTENT_WIDTHS = ["theme", "narrow", "wide"] as const;
export const CONTENT_WIDTH_LABELS: Record<(typeof CONTENT_WIDTHS)[number], string> = { theme: "The theme's own", narrow: "Narrow", wide: "Wide" };
export const LINK_STYLES = ["theme", "underline", "plain"] as const;
export const LINK_STYLE_LABELS: Record<(typeof LINK_STYLES)[number], string> = { theme: "The theme's own", underline: "Underlined", plain: "No underline" };

const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour like #4f46e5");
/** Empty means the theme's own colour. */
const optionalColor = z.string().trim().regex(/^(#[0-9a-fA-F]{6})?$/, "Must be a hex colour like #4f46e5");

export const storeDesignSchema = z.object({
  displayFont: z.enum(DESIGN_FONTS).prefault("theme"),
  bodyFont: z.enum(DESIGN_FONTS).prefault("theme"),
  buttonShape: z.enum(BUTTON_SHAPES).prefault("theme"),
  textSize: z.enum(TEXT_SIZES).prefault("normal"),
  headingWeight: z.enum(HEADING_WEIGHTS).prefault("theme"),
  bodyWeight: z.enum(BODY_WEIGHTS).prefault("theme"),
  headingSize: z.enum(HEADING_SIZES).prefault("normal"),
  backgroundColor: optionalColor.prefault(""),
  textColor: optionalColor.prefault(""),
  buttonStyle: z.enum(BUTTON_STYLES).prefault("theme"),
  radius: z.enum(RADII).prefault("theme"),
  sectionSpacing: z.enum(SECTION_SPACINGS).prefault("theme"),
  contentWidth: z.enum(CONTENT_WIDTHS).prefault("theme"),
  linkStyle: z.enum(LINK_STYLES).prefault("theme"),
});
export type StoreDesign = z.infer<typeof storeDesignSchema>;

export const DEFAULT_STORE_DESIGN: StoreDesign = {
  displayFont: "theme",
  bodyFont: "theme",
  buttonShape: "theme",
  textSize: "normal",
  headingWeight: "theme",
  bodyWeight: "theme",
  headingSize: "normal",
  backgroundColor: "",
  textColor: "",
  buttonStyle: "theme",
  radius: "theme",
  sectionSpacing: "theme",
  contentWidth: "theme",
  linkStyle: "theme",
};

/** Only the design choices of a larger object, such as a draft, in a fixed order. */
export function pickStoreDesign(value: StoreDesign): StoreDesign {
  const out = {} as Record<keyof StoreDesign, string>;
  for (const key of Object.keys(DEFAULT_STORE_DESIGN) as Array<keyof StoreDesign>) out[key] = value[key] ?? DEFAULT_STORE_DESIGN[key];
  return out as StoreDesign;
}

export const isDefaultStoreDesign = (value: StoreDesign) => JSON.stringify(pickStoreDesign(value)) === JSON.stringify(DEFAULT_STORE_DESIGN);

/** The whole set of design choices, as the design screen edits it. */
export const designDraftSchema = storeDesignSchema.extend({
  themeId: z.enum(THEME_IDS),
  /** Follow the theme's palette instead of the two colours below. */
  useThemeColors: z.boolean().prefault(false),
  primaryColor: hexColor,
  accentColor: hexColor,
});
export type DesignDraft = z.infer<typeof designDraftSchema>;

/**
 * Part of a draft, for saving one choice. Written out without defaults: `.partial()`
 * keeps a default, which would reset every other choice to it on each save.
 */
export const designDraftChangesSchema = z
  .object({
    displayFont: z.enum(DESIGN_FONTS),
    bodyFont: z.enum(DESIGN_FONTS),
    buttonShape: z.enum(BUTTON_SHAPES),
    textSize: z.enum(TEXT_SIZES),
    headingWeight: z.enum(HEADING_WEIGHTS),
    bodyWeight: z.enum(BODY_WEIGHTS),
    headingSize: z.enum(HEADING_SIZES),
    backgroundColor: optionalColor,
    textColor: optionalColor,
    buttonStyle: z.enum(BUTTON_STYLES),
    radius: z.enum(RADII),
    sectionSpacing: z.enum(SECTION_SPACINGS),
    contentWidth: z.enum(CONTENT_WIDTHS),
    linkStyle: z.enum(LINK_STYLES),
    themeId: z.enum(THEME_IDS),
    useThemeColors: z.boolean(),
    primaryColor: hexColor,
    accentColor: hexColor,
  })
  .partial()
  .strict();

export function readStoreDesign(value: unknown): StoreDesign {
  const parsed = storeDesignSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_STORE_DESIGN;
}

export function readDesignDraft(value: unknown): DesignDraft | null {
  const parsed = designDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The CSS value of a chosen typeface; null keeps the theme's own. */
export function designFontValue(font: DesignFont): string | null {
  return font === "theme" ? null : `var(--sf-font-${font})`;
}

/** Root class for a chosen button shape (app/globals.css); literal for Tailwind's sake. */
export function buttonShapeClass(shape: ButtonShape): string {
  return shape === "square" ? "sf-btn-square" : shape === "rounded" ? "sf-btn-rounded" : shape === "pill" ? "sf-btn-pill" : "";
}

/** Root classes for the other design choices (app/globals.css); literal for Tailwind's sake. "theme" adds none. */
export function designClasses(design: StoreDesign): string {
  return [
    design.headingWeight !== "theme" ? "sf-heading-weight" : "",
    design.bodyWeight !== "theme" ? "sf-body-weight" : "",
    design.headingSize === "smaller" ? "sf-heading-smaller" : design.headingSize === "larger" ? "sf-heading-larger" : "",
    design.backgroundColor ? "sf-custom-bg" : "",
    design.textColor ? "sf-custom-text" : "",
    design.buttonStyle === "outline" ? "sf-btn-outline" : design.buttonStyle === "soft" ? "sf-btn-soft" : "",
    design.radius === "none" ? "sf-radius-none" : design.radius === "small" ? "sf-radius-small" : design.radius === "medium" ? "sf-radius-medium" : design.radius === "large" ? "sf-radius-large" : "",
    design.sectionSpacing === "compact" ? "sf-spacing-compact" : design.sectionSpacing === "spacious" ? "sf-spacing-spacious" : "",
    design.contentWidth === "narrow" ? "sf-width-narrow" : design.contentWidth === "wide" ? "sf-width-wide" : "",
    design.linkStyle === "underline" ? "sf-links-underline" : design.linkStyle === "plain" ? "sf-links-plain" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Scales the whole store, images and spacing included, so a theme keeps its proportions. */
export function textSizeZoom(size: TextSize): number | undefined {
  return size === "small" ? 0.94 : size === "large" ? 1.06 : undefined;
}

export type { ThemeId };
