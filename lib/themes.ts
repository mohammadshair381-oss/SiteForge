import type { ThemeId } from "./constants";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  description: string;
  bestFor: string[];
  palette: string[];
  /** The theme's design identity (marketplace card). */
  identity: string;
  /** Visual characteristics (marketplace card). */
  visual: string[];
  /** Animation characteristics (marketplace card). */
  motion: string;
}

/**
 * Nine reusable themes. Theme rendering is fully separated from business data:
 * every theme consumes the same StorefrontView contract, so switching themes
 * never changes or removes a business's products or settings. The first five
 * ids are the original themes (stored values stay valid); the design system
 * of each theme lives in `themes/skins/<id>.ts`. `bestFor` lists business
 * types (lib/constants.ts BUSINESS_CATEGORIES keys).
 */
export const THEMES: ThemeMeta[] = [
  {
    id: "aurora",
    name: "Aurora",
    tagline: "Premium modern lifestyle",
    description:
      "A midnight canvas with an immersive full-height hero, a bento category mosaic and large product cards that lift on hover.",
    bestFor: ["cosmetics", "beauty", "technology", "creative"],
    palette: ["#070a13", "#4f46e5", "#0ea5e9"],
    identity: "Immersive premium design with cinematic visuals and elegant product layouts.",
    visual: ["Full-height cinematic hero", "Bento category mosaic", "Large 4:5 product cards"],
    motion: "Soft, slow fades; product cards lift and images settle.",
  },
  {
    id: "market",
    name: "Market",
    tagline: "Professional retail",
    description:
      "Search-first header with a category bar, a panel hero with category shortcuts, dense product grids and a filter sidebar.",
    bestFor: ["retail", "hardware", "other"],
    palette: ["#f3f4f6", "#047857", "#0f172a"],
    identity: "Professional retail layout focused on search, categories and product discovery.",
    visual: ["Search-first header with category bar", "Dense five-column grids", "Filter sidebar in the catalog"],
    motion: "Minimal and fast: quick hovers, no distractions.",
  },
  {
    id: "bistro",
    name: "Bistro",
    tagline: "Restaurants and food",
    description:
      "Warm cream paper and serif type, an arched hero image, menu-style product lists with price leaders and menu category tabs.",
    bestFor: ["food", "creative"],
    palette: ["#f8f1e6", "#9a4a26", "#3b2417"],
    identity: "Warm editorial design for food, restaurant and lifestyle businesses.",
    visual: ["Warm cream paper and serif type", "Arched hero image", "Menu-style lists with price leaders"],
    motion: "Gentle fades and soft image zooms.",
  },
  {
    id: "studio",
    name: "Studio",
    tagline: "Minimal editorial",
    description:
      "Light grotesk type, an asymmetric editorial hero, a typographic category index and borderless portrait product cards.",
    bestFor: ["creative", "services", "realestate"],
    palette: ["#ffffff", "#111827", "#e5e5e5"],
    identity: "Minimal creative design with editorial typography and spacious product presentation.",
    visual: ["Asymmetric editorial hero", "Typographic category index", "Borderless portrait cards"],
    motion: "Calm, unhurried reveals.",
  },
  {
    id: "launch",
    name: "Launch",
    tagline: "Bold modern brand",
    description:
      "Giant uppercase headlines, an offset colour block, a marquee of your categories and high-contrast cards with a hard shadow.",
    bestFor: ["shoes", "fitness", "education", "services"],
    palette: ["#ffffff", "#2563eb", "#0a0a0a"],
    identity: "Bold modern design with strong typography and high-impact promotional sections.",
    visual: ["Giant uppercase headlines", "Marquee of your categories", "Cards with a hard offset shadow"],
    motion: "Crisp and quick, with a looping marquee.",
  },
  {
    id: "atelier",
    name: "Atelier",
    tagline: "Luxury fashion and jewellery",
    description:
      "Ivory and ink with Didone headlines, a full-bleed campaign hero, tall portrait cards with an image rollover and an editorial product page.",
    bestFor: ["clothing", "shoes", "beauty"],
    palette: ["#faf8f4", "#141414", "#b08d57"],
    identity: "Luxury fashion and jewellery with editorial campaign imagery and refined layouts.",
    visual: ["Full-bleed campaign hero", "Didone serif with spaced capitals", "Tall portrait cards with image rollover"],
    motion: "Slow, refined fades; a second image on hover.",
  },
  {
    id: "volt",
    name: "Volt",
    tagline: "Electronics and gadgets",
    description:
      "A graphite spotlight hero, option chips on product cards, specification and option-comparison tables and a filter sidebar.",
    bestFor: ["electronics", "technology", "hardware"],
    palette: ["#0a0c10", "#22d3ee", "#6366f1"],
    identity: "Electronics and technology design with structured product specifications and comparisons.",
    visual: ["Graphite spotlight hero", "Option chips on product cards", "Specification and comparison tables"],
    motion: "Crisp transitions and a glow on hover.",
  },
  {
    id: "harvest",
    name: "Harvest",
    tagline: "Grocery and daily essentials",
    description:
      "Mobile-first: search always in reach, a quick dock on phones, round category bubbles, offer tiles and one-tap add to cart.",
    bestFor: ["grocery", "food"],
    palette: ["#fbfcf8", "#15803d", "#f59e0b"],
    identity: "Fresh grocery and daily essentials design with mobile-friendly shopping.",
    visual: ["Search always in reach", "Round category bubbles", "Quick navigation dock on phones"],
    motion: "Lively but short: quick add-to-cart feedback.",
  },
  {
    id: "forma",
    name: "Forma",
    tagline: "Furniture and interiors",
    description:
      "Warm stone with light serif type, a room hero with a caption card, alternating collection stories and spacious gallery cards.",
    bestFor: ["furniture", "realestate", "creative"],
    palette: ["#f4f1ec", "#2a2621", "#a16207"],
    identity: "Furniture and interior design with large lifestyle photography and collection storytelling.",
    visual: ["Room hero with a caption card", "Alternating collection stories", "Spacious gallery cards"],
    motion: "Calm, slow reveals.",
  },
];

export function getThemeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function isValidThemeId(id: string): id is ThemeId {
  return THEMES.some((theme) => theme.id === id);
}
