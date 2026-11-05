/**
 * Visual-identity starting points per business type (pure; no I/O). Used by
 * the store setup wizard: a recommended theme and a few colour palettes that
 * suit the kind of business. Owners can pick any theme and any colours; these
 * are suggestions, never enforced, and every theme keeps its own look (the
 * palette only sets the store's primary and accent colours).
 */
import type { ThemeId } from "./constants";
import { contrastRatio, parseHexColor } from "./color-contrast";
import { presetForBusinessType, type PresetKey } from "./storefront-presets";

export interface BrandPalette {
  id: string;
  name: string;
  /** Buttons and links. */
  primary: string;
  /** Badges and highlights. */
  accent: string;
}

export interface BrandPreset {
  /** The theme that suits this kind of store best (a suggestion). */
  theme: ThemeId;
  font: "sans" | "serif" | "mono";
  palettes: BrandPalette[];
}

const p = (id: string, name: string, primary: string, accent: string): BrandPalette => ({ id, name, primary, accent });

export const BRAND_PRESETS: Record<PresetKey, BrandPreset> = {
  general: {
    theme: "market",
    font: "sans",
    palettes: [p("indigo", "Indigo", "#4338ca", "#0ea5e9"), p("charcoal-amber", "Charcoal and amber", "#1f2937", "#f59e0b"), p("teal", "Teal and coral", "#0f766e", "#f97316")],
  },
  clothing: {
    theme: "atelier",
    font: "sans",
    palettes: [p("noir", "Noir", "#111827", "#b45309"), p("blush", "Blush", "#be185d", "#f472b6"), p("sage", "Sage", "#3f6212", "#a3a380")],
  },
  shoes: {
    theme: "launch",
    font: "sans",
    palettes: [p("sport", "Sport red", "#dc2626", "#111827"), p("street", "Street", "#111827", "#f59e0b"), p("trail", "Trail", "#166534", "#ea580c")],
  },
  electronics: {
    theme: "volt",
    font: "sans",
    palettes: [p("electric", "Electric blue", "#2563eb", "#06b6d4"), p("graphite", "Graphite", "#111827", "#22c55e"), p("violet", "Violet", "#6d28d9", "#0ea5e9")],
  },
  grocery: {
    theme: "harvest",
    font: "sans",
    palettes: [p("fresh", "Fresh green", "#15803d", "#f59e0b"), p("harvest", "Harvest", "#c2410c", "#16a34a"), p("market", "Market blue", "#1d4ed8", "#facc15")],
  },
  furniture: {
    theme: "forma",
    font: "serif",
    palettes: [p("walnut", "Walnut", "#78350f", "#a16207"), p("nordic", "Nordic", "#334155", "#94a3b8"), p("olive", "Olive", "#4d7c0f", "#d97706")],
  },
  cosmetics: {
    theme: "aurora",
    font: "serif",
    palettes: [p("rose", "Rose", "#9d174d", "#f472b6"), p("lavender", "Lavender", "#6d28d9", "#f0abfc"), p("nude", "Nude", "#7c2d12", "#fdba74")],
  },
  services: {
    theme: "studio",
    font: "sans",
    palettes: [p("navy", "Navy", "#1e3a8a", "#0ea5e9"), p("slate-amber", "Slate and amber", "#334155", "#f59e0b"), p("forest", "Forest", "#166534", "#84cc16")],
  },
  realestate: {
    theme: "forma",
    font: "serif",
    palettes: [p("estate", "Estate", "#1f2937", "#b08d57"), p("coast", "Coast", "#0f766e", "#f59e0b"), p("brick", "Brick", "#7c2d12", "#d97706")],
  },
  fitness: {
    theme: "launch",
    font: "sans",
    palettes: [p("power", "Power red", "#dc2626", "#111827"), p("pulse", "Pulse", "#1d4ed8", "#f97316"), p("trail", "Trail", "#047857", "#a3e635")],
  },
  education: {
    theme: "market",
    font: "sans",
    palettes: [p("campus", "Campus", "#1d4ed8", "#f59e0b"), p("scholar", "Scholar", "#6d28d9", "#f472b6"), p("chalk", "Chalkboard", "#0f766e", "#facc15")],
  },
  creative: {
    theme: "atelier",
    font: "serif",
    palettes: [p("gallery", "Gallery", "#111827", "#ec4899"), p("stage", "Stage", "#7c3aed", "#fbbf24"), p("poster", "Poster", "#be123c", "#fb923c")],
  },
  hardware: {
    theme: "launch",
    font: "sans",
    palettes: [p("safety", "Safety yellow", "#a16207", "#1f2937"), p("steel", "Steel", "#334155", "#f97316"), p("workshop", "Workshop red", "#b91c1c", "#334155")],
  },
};

/** The starting visual identity for a business type (any type; unknown types get the general one). */
export function brandPresetFor(businessType: string | null | undefined): BrandPreset & { key: PresetKey } {
  const key = presetForBusinessType(businessType);
  return { key, ...BRAND_PRESETS[key] };
}

/**
 * Whether white button text is readable on `primary` (WCAG AA for normal
 * text, 4.5:1). The storefront picks black or white text automatically; this
 * only tells the owner when white text would be hard to read.
 */
export function primaryContrastWithWhite(primary: string): { ratio: number; readable: boolean } | null {
  const rgb = parseHexColor(primary);
  if (!rgb) return null;
  const ratio = contrastRatio(rgb, [255, 255, 255]);
  return { ratio: Math.round(ratio * 10) / 10, readable: ratio >= 4.5 };
}
