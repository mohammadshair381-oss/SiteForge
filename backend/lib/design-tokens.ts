/**
 * Design token system for SiteForge dashboard and editor.
 *
 * These tokens provide a consistent visual language for the dashboard UI
 * without forcing them onto storefront themes, which maintain their
 * distinct visual identities.
 */

// Color tokens - semantic names for consistent usage across dashboard components
export const colors = {
  // Brand colors (used for primary actions, links, focus states)
  brand: {
    50: "#eef2ff",
    100: "#e0e7ff",
    200: "#c7d2fe",
    300: "#a5b4fc",
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
    800: "#3730a3",
    900: "#312e81",
    950: "#1e1b4b",
  },

  // Neutral/slate colors for surfaces, text, borders
  slate: {
    50: "#f8fafc",
    100: "#f1f5f9",
    200: "#e2e8f0",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#64748b",
    600: "#475569",
    700: "#334155",
    800: "#1e293b",
    900: "#0f172a",
    950: "#020617",
  },

  // Semantic colors for status states
  success: {
    50: "#f0fdf4",
    100: "#dcfce7",
    500: "#22c55e",
    600: "#16a34a",
    700: "#15803d",
  },
  warning: {
    50: "#fffbeb",
    100: "#fef3c7",
    500: "#f59e0b",
    600: "#d97706",
    700: "#b45309",
  },
  error: {
    50: "#fef2f2",
    100: "#fee2e2",
    500: "#ef4444",
    600: "#dc2626",
    700: "#b91c1c",
  },
  info: {
    50: "#eff6ff",
    100: "#dbeafe",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
  },
} as const;

// Spacing scale - consistent spacing values
export const spacing = {
  0: "0",
  1: "0.25rem",   // 4px
  2: "0.5rem",    // 8px
  3: "0.75rem",   // 12px
  4: "1rem",      // 16px
  5: "1.25rem",   // 20px
  6: "1.5rem",    // 24px
  8: "2rem",      // 32px
  10: "2.5rem",   // 40px
  12: "3rem",     // 48px
  16: "4rem",     // 64px
} as const;

// Border radius scale
export const radius = {
  none: "0",
  sm: "0.25rem",   // 4px
  md: "0.375rem",  // 6px
  lg: "0.5rem",    // 8px
  xl: "0.75rem",   // 12px
  "2xl": "1rem",   // 16px
  full: "9999px",
} as const;

// Shadow scale
export const shadows = {
  sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
  md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
  lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
} as const;

// Typography scale
export const typography = {
  fontFamily: {
    sans: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    serif: "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
  fontSize: {
    xs: ["0.75rem", { lineHeight: "1rem" }],      // 12px
    sm: ["0.875rem", { lineHeight: "1.25rem" }],  // 14px
    base: ["1rem", { lineHeight: "1.5rem" }],     // 16px
    lg: ["1.125rem", { lineHeight: "1.75rem" }],  // 18px
    xl: ["1.25rem", { lineHeight: "1.75rem" }],   // 20px
    "2xl": ["1.5rem", { lineHeight: "2rem" }],    // 24px
    "3xl": ["1.875rem", { lineHeight: "2.25rem" }], // 30px
    "4xl": ["2.25rem", { lineHeight: "2.5rem" }], // 36px
  },
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "700",
    extrabold: "800",
  },
} as const;

// Breakpoints (matching Tailwind defaults)
export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

// Z-index scale
export const zIndex = {
  hide: -1,
  base: 0,
  dropdown: 1000,
  sticky: 1100,
  modal: 1200,
  popover: 1300,
  tooltip: 1400,
  toast: 1500,
} as const;

// Transition durations
export const transitions = {
  fast: "150ms",
  normal: "200ms",
  slow: "300ms",
} as const;

// Focus ring styles (consistent across components)
export const focusRing = {
  base: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
  inset: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-inset",
  none: "focus-visible:outline-none focus-visible:ring-0",
} as const;

// Semantic color aliases for easier usage in components
// These map to the appropriate color scales above
export const semanticColors = {
  // Backgrounds
  bg: {
    primary: "bg-white",
    secondary: "bg-slate-50",
    tertiary: "bg-slate-100",
    inverse: "bg-slate-900",
    brand: "bg-brand-600",
    brandHover: "hover:bg-brand-700",
  },
  // Text colors
  text: {
    primary: "text-slate-900",
    secondary: "text-slate-600",
    muted: "text-slate-500",
    inverse: "text-white",
    brand: "text-brand-600",
    brandHover: "hover:text-brand-700",
    success: "text-success-700",
    warning: "text-warning-700",
    error: "text-error-700",
  },
  // Border colors
  border: {
    default: "border-slate-200",
    muted: "border-slate-100",
    strong: "border-slate-300",
    brand: "border-brand-500",
    success: "border-success-500",
    warning: "border-warning-500",
    error: "border-error-500",
  },
  // Ring colors (for focus states)
  ring: {
    default: "ring-slate-200",
    brand: "ring-brand-500",
    success: "ring-success-500",
    warning: "ring-warning-500",
    error: "ring-error-500",
  },
  // Background with text color combos for badges/status
  badge: {
    success: "bg-success-50 text-success-700 ring-success-200",
    warning: "bg-warning-50 text-warning-700 ring-warning-200",
    error: "bg-error-50 text-error-700 ring-error-200",
    info: "bg-info-50 text-info-700 ring-info-200",
    neutral: "bg-slate-50 text-slate-600 ring-slate-200",
    brand: "bg-brand-50 text-brand-700 ring-brand-200",
  },
} as const;

// Component-specific token composites for common patterns
export const components = {
  card: {
    base: "rounded-2xl border bg-white shadow-sm",
    interactive: "rounded-2xl border bg-white shadow-sm transition hover:shadow-md",
    selected: "rounded-2xl border border-brand-500 ring-1 ring-brand-500 bg-brand-50",
  },
  button: {
    primary: "rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60",
    secondary: "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50",
    subtle: "rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50",
    danger: "rounded-lg bg-error-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-error-700 disabled:cursor-not-allowed disabled:opacity-60",
    ghost: "rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50",
  },
  input: {
    base: "w-full rounded-lg border px-3 py-2 outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70",
    error: "w-full rounded-lg border border-error-500 px-3 py-2 outline-none transition placeholder:text-slate-400 focus:border-error-500 focus-visible:ring-2 focus-visible:ring-error-500 focus-visible:ring-offset-1",
  },
  badge: {
    base: "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
  },
  emptyState: {
    container: "rounded-2xl border border-dashed bg-white p-10 text-center shadow-sm",
    icon: "mx-auto text-brand-500",
    title: "mt-5 text-xl font-bold text-slate-900",
    description: "mx-auto mt-2 max-w-md text-sm text-slate-600",
    action: "mt-6 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2.5 font-semibold text-white shadow-sm hover:bg-brand-700",
  },
  skeleton: {
    base: "animate-pulse bg-slate-200 rounded",
    text: "h-4 bg-slate-200 rounded animate-pulse",
    card: "rounded-2xl border bg-white p-5 shadow-sm animate-pulse",
    avatar: "h-10 w-10 rounded-full bg-slate-200 animate-pulse",
  },
} as const;

// Type exports for consumers
export type Colors = typeof colors;
export type Spacing = typeof spacing;
export type Radius = typeof radius;
export type Shadows = typeof shadows;
export type Typography = typeof typography;
export type Breakpoints = typeof breakpoints;
export type ZIndex = typeof zIndex;
export type Transitions = typeof transitions;
export type FocusRing = typeof focusRing;
export type SemanticColors = typeof semanticColors;
export type Components = typeof components;