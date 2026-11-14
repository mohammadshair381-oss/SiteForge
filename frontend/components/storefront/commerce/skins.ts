import type React from "react";
import type { ThemeId } from "@/lib/constants";
import type { StorefrontTheme } from "@/lib/storefront";
import { DEFAULT_STORE_DESIGN, buttonShapeClass, designClasses, designFontValue, pickStoreDesign, textSizeZoom, type StoreDesign } from "@/lib/design-settings";
import { aurora } from "@/themes/skins/aurora";
import { market } from "@/themes/skins/market";
import { bistro } from "@/themes/skins/bistro";
import { studio } from "@/themes/skins/studio";
import { launch } from "@/themes/skins/launch";
import { atelier } from "@/themes/skins/atelier";
import { volt } from "@/themes/skins/volt";
import { harvest } from "@/themes/skins/harvest";
import { forma } from "@/themes/skins/forma";

/**
 * A theme's design system for the shared commerce components.
 *
 * Behaviour, data and accessibility are identical for every theme (one
 * renderer: docs/storefront-commerce.md); a skin decides
 * - the look: class tokens below (colours, type, borders, radii);
 * - the composition: `layout` picks one of several shared, data-identical
 *   variants for the header, section headings, hero, product rails, product
 *   card, category section, benefits, promotions, story, footer, product page,
 *   catalog and customer account;
 * - density, proportions and rhythm: `grid`, `catalogGrid`, `media`, `spacing`,
 *   `divider`;
 * - typography: display/body font stacks (a self-hosted face per theme);
 * - the motion language: easing and duration for every animation.
 * Brand colours (primary/accent) are applied inline from theme settings.
 * Each theme's skin lives in `themes/skins/<id>.ts`.
 */
export interface StoreSkin {
  id: ThemeId;
  dark: boolean;
  page: string;
  container: string;
  muted: string;
  subtle: string;
  border: string;
  header: string;
  sticky: boolean;
  announcement: string;
  brand: string;
  navLink: string;
  input: string;
  iconButton: string;
  heading: string;
  eyebrow: string;
  sectionAlt: string;
  card: string;
  cardImage: string;
  productName: string;
  price: string;
  button: string;
  buttonOutline: string;
  badge: string;
  categoryCard: string;
  heroHeading: string;
  promo: string;
  /** Secondary text inside a promotion (its background may differ from the page). */
  promoMuted: string;
  benefit: string;
  footer: string;
  footerHeading: string;
  /** The store name in the footer (the footer background may differ from the header). */
  footerBrand: string;
  /** Drawers and dropdown panels (mobile menu, account menu). */
  panel: string;
  menuLink: string;
  focus: string;
  layout: StoreLayout;
  /** Homepage and related-products grid (full container width). */
  grid: string;
  /** Catalog grid (narrower when the catalog has a sidebar). */
  catalogGrid: string;
  /** Product media proportion on cards (fixed: no layout shift). */
  media: string;
  /** The product page's details column ("" sets it directly on the page). */
  detailPanel: string;
  /** Vertical rhythm for the owner's compact, normal and spacious sections. */
  spacing: { compact: string; normal: string; spacious: string };
  /** A rule between homepage sections ("" for none). */
  divider: string;
  /** The customer account's look (`accountVars`): CSS values, so client forms need no skin. */
  account: {
    surface: string;
    text: string;
    muted: string;
    line: string;
    inputLine: string;
    field: string;
    danger: string;
    radius: string;
    control: string;
    borderWidth: string;
    shadow: string;
    titleWeight: string;
    titleTracking: string;
    titleCase: string;
    buttonCase: string;
    buttonTracking: string;
  };
  /** CSS font-family values for headings and body text (app/globals.css `--sf-font-*`). */
  fonts: { display: string; body: string };
  /** The small mark above section headings. */
  ornament: "none" | "glow" | "flourish" | "rule" | "block" | "slash" | "pill";
  motion: { ease: string; duration: string };
}

export interface StoreLayout {
  /**
   * glass: a floating pill over the page; marketplace: a brand-coloured search
   * bar over a category bar; signboard: the name centred between two sets of
   * links; minimal: small type, little chrome; slab: joined, bordered cells;
   * centered: a large name centred over the links; console: a dense bar with a
   * command-style search; grocer: search first over category chips that scroll
   * on every screen; textual: words instead of icons.
   */
  header: "glass" | "marketplace" | "signboard" | "minimal" | "slab" | "centered" | "console" | "grocer" | "textual";
  /** How a section introduces itself: its title, subtitle and "View all". */
  heading: "glow" | "bar" | "flourish" | "index" | "slab" | "caps" | "path" | "chip" | "quiet";
  /** How a row of products is composed on the homepage. */
  rail: "scroller" | "panel" | "board" | "aside" | "bento" | "lookbook" | "cells" | "shelf" | "stagger";
  benefits: "glass" | "strip" | "notes" | "ruled" | "cells" | "line" | "spec" | "bubbles" | "list";
  hero: "immersive" | "arch" | "statement" | "panel" | "editorial" | "campaign" | "spotlight" | "banner" | "room";
  card: "lift" | "menu" | "bold" | "retail" | "plain" | "couture" | "tech" | "fresh" | "gallery";
  categories: "mosaic" | "menu" | "blocks" | "rail" | "index" | "campaign" | "tech" | "bubbles" | "rooms";
  promo: "overlay" | "strip" | "band" | "caption" | "poster" | "bleed" | "feature" | "tiles" | "inset";
  story: "statement" | "plain" | "centered" | "offset" | "shout" | "manifesto" | "readme" | "note" | "spread";
  footer: "wordmark" | "columns" | "postcard" | "ledger" | "slab" | "couture" | "terminal" | "sheet" | "colophon";
  /** Customer account navigation: a side column, underlined tabs, or joined cells. */
  account: "rail" | "tabs" | "blocks";
  /** split: gallery beside details; stacked: large stacked images, sticky details; spec: split plus specification and option tables. */
  productPage: "split" | "stacked" | "spec";
  /** Stacked product images: one column, or a two-column grid. */
  gallery: "single" | "grid";
  catalog: "toolbar" | "sidebar";
  /** A looping strip of real category/benefit names under the hero. */
  marquee: boolean;
  /** A fixed quick-navigation dock on small screens. */
  dock: boolean;
}

/** Marks each theme's main container, so a content width can apply to it without knowing its size. */
const marked = (skin: StoreSkin): StoreSkin => ({ ...skin, container: `${skin.container} sf-container` });

export const STORE_SKINS: Record<ThemeId, StoreSkin> = {
  aurora: marked(aurora),
  market: marked(market),
  bistro: marked(bistro),
  studio: marked(studio),
  launch: marked(launch),
  atelier: marked(atelier),
  volt: marked(volt),
  harvest: marked(harvest),
  forma: marked(forma),
};

/**
 * A row of a few products fills the width instead of leaving empty columns
 * (from the tablet width up): `style` and `className` for the product grid.
 */
export function fewProductsGrid(count: number, skin: StoreSkin): { className: string; style?: React.CSSProperties } {
  const columns = Math.max(...[...skin.grid.matchAll(/grid-cols-(\d)/g)].map((match) => Number(match[1])));
  if (count <= 0 || count >= columns) return { className: "" };
  const size = count === 1 ? "sf-few-1" : count === 2 ? "sf-few-2" : "";
  return { className: `sf-few ${skin.layout.card === "menu" ? "" : size}`, style: { "--sf-few": count } as React.CSSProperties };
}

export function skinFor(themeId: string): StoreSkin {
  return STORE_SKINS[themeId as ThemeId] ?? STORE_SKINS.aurora;
}

/** The account tokens as CSS variables (the `sf-acc-*` classes in app/globals.css read them). */
export function accountVars(skin: StoreSkin): React.CSSProperties {
  const a = skin.account;
  return {
    "--acc-surface": a.surface,
    "--acc-text": a.text,
    "--acc-muted": a.muted,
    "--acc-line": a.line,
    "--acc-input-line": a.inputLine,
    "--acc-field": a.field,
    "--acc-danger": a.danger,
    "--acc-radius": a.radius,
    "--acc-control": a.control,
    "--acc-border-width": a.borderWidth,
    "--acc-shadow": a.shadow,
    "--acc-title-weight": a.titleWeight,
    "--acc-title-tracking": a.titleTracking,
    "--acc-title-case": a.titleCase,
    "--acc-button-case": a.buttonCase,
    "--acc-button-tracking": a.buttonTracking,
  } as React.CSSProperties;
}

/** Tokens for a store page's own surfaces (cart, order): the theme's look with a readable accent. */
export function surfaceVars(skin: StoreSkin, accent: string): React.CSSProperties {
  return { ...accountVars(skin), "--sf-accent": accent, "--sf-accent-text": readableOn(accent) } as React.CSSProperties;
}

/** Owner font choices other than the default replace the theme's typography everywhere (as before). */
const OWNER_FONTS: Record<string, string> = {
  serif: "var(--sf-font-serif)",
  mono: "var(--sf-font-mono)",
};

/**
 * Root element props for a storefront page: theme tokens as CSS variables
 * (fonts, motion, brand colours) and the base classes. "sans" (the default)
 * means the theme's own typography.
 */
export function storeRootProps(skin: StoreSkin, theme: Pick<StorefrontTheme, "font" | "primaryColor" | "accentColor"> & { design?: StoreDesign }) {
  const owner = OWNER_FONTS[theme.font ?? ""];
  // Filled in, so a design saved before a choice existed keeps the theme's look for that choice.
  const design = pickStoreDesign(theme.design ?? DEFAULT_STORE_DESIGN);
  const style = {
    "--sf-display": designFontValue(design.displayFont) ?? owner ?? skin.fonts.display,
    "--sf-body": designFontValue(design.bodyFont) ?? owner ?? skin.fonts.body,
    ...(textSizeZoom(design.textSize) ? { zoom: textSizeZoom(design.textSize) } : {}),
    "--sf-ease": skin.motion.ease,
    "--sf-dur": skin.motion.duration,
    "--sf-primary": theme.primaryColor,
    "--sf-accent": theme.accentColor,
    "--sf-on-primary": readableOn(theme.primaryColor),
    ...(design.headingWeight !== "theme" ? { "--sf-heading-weight": design.headingWeight } : {}),
    ...(design.bodyWeight !== "theme" ? { "--sf-body-weight": design.bodyWeight } : {}),
    ...(design.backgroundColor ? { "--sf-page-bg": design.backgroundColor } : {}),
    ...(design.textColor ? { "--sf-page-text": design.textColor } : {}),
  } as React.CSSProperties;
  return { className: `flex min-h-screen flex-col font-body antialiased ${skin.page} ${buttonShapeClass(design.buttonShape)} ${designClasses(design)}`, style };
}

/**
 * The brand colour for small text when it is readable (WCAG 4.5:1) on the
 * theme's page (white for light themes, near-black for dark ones); otherwise
 * undefined, so the text keeps the theme's own colour.
 */
export function brandTextColor(hex: string, dark: boolean): string | undefined {
  const lum = luminance(hex);
  if (lum === null) return undefined;
  const page = dark ? 0.006 : 1; // ~#0a0c10 or white
  const ratio = (Math.max(lum, page) + 0.05) / (Math.min(lum, page) + 0.05);
  return ratio >= 4.5 ? hex : undefined;
}

function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const n = parseInt(match[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** A class list without font-size utilities (where the page sets the size itself). */
export function sizeless(classes: string): string {
  return classes
    .split(/\s+/)
    .filter((c) => !/^(?:[a-z]+:)?text-(?:xs|sm|base|lg|[2-9]?xl|\[\d)/.test(c))
    .join(" ");
}

/** Readable text colour (black/white) on a hex background. */
export function readableOn(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#ffffff";
  const n = parseInt(match[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // WCAG relative luminance.
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Pick whichever of near-black / white has the higher contrast ratio.
  const darkLuminance = 0.0137; // #111827
  const onDark = (luminance + 0.05) / (darkLuminance + 0.05);
  const onWhite = 1.05 / (luminance + 0.05);
  return onDark > onWhite ? "#111827" : "#ffffff";
}
