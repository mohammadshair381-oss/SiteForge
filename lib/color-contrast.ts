/**
 * WCAG 2.x contrast helpers (pure; safe in client and server code).
 *
 * `readableTextColor` picks black or white text for a theme colour, whichever
 * contrasts more. For any opaque sRGB colour the better of the two reaches at
 * least ~4.58:1, so text on a theme-coloured button meets WCAG AA (4.5:1) for
 * normal-size text without inventing new theme colours.
 */

export type Rgb = [number, number, number];

/** Parses `#rgb` or `#rrggbb` (case-insensitive); anything else is null. */
export function parseHexColor(value: string | null | undefined): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? "").trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * How readable text is on a background: below 3:1 is hard to read at any size, and below 4.5:1
 * (WCAG AA) small text is. Null if either colour cannot be read. Advice only, never a rule.
 */
export function textReadability(text: string | null | undefined, background: string | null | undefined): { ratio: number; level: "low" | "fair" | "good" } | null {
  const foreground = parseHexColor(text);
  const back = parseHexColor(background);
  if (!foreground || !back) return null;
  const ratio = contrastRatio(foreground, back);
  return { ratio, level: ratio < 3 ? "low" : ratio < 4.5 ? "fair" : "good" };
}

/** "#ffffff" or "#000000", whichever is more readable on `background`; null if unparsable. */
export function readableTextColor(background: string | null | undefined): "#ffffff" | "#000000" | null {
  const rgb = parseHexColor(background);
  if (!rgb) return null;
  return contrastRatio(rgb, [255, 255, 255]) >= contrastRatio(rgb, [0, 0, 0]) ? "#ffffff" : "#000000";
}
