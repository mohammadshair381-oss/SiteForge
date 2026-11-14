import type { Config } from "tailwindcss";

const scale = (name: string, stops: number[]) =>
  Object.fromEntries(stops.map((stop) => [stop, `rgb(var(--${name}-${stop}) / <alpha-value>)`]));

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./frontend/components/**/*.{ts,tsx}",
    "./frontend/themes/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Storefront typography: each theme sets these variables on its root
        // (components/storefront/commerce/skins.ts).
        display: ["var(--sf-display)"],
        body: ["var(--sf-body)"],
        // Platform typography (self-hosted, app/fonts). Never used by themes.
        heading: ["var(--font-heading)", "var(--font-ui)", "ui-sans-serif", "system-ui", "sans-serif"],
        ui: ["var(--font-ui)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      // Variables, so themes keep their own values (app/globals.css).
      colors: {
        slate: scale("slate", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        brand: scale("brand", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
        // Always the ember accent, for highlights on any background.
        ember: { DEFAULT: "#f4511e", soft: "#ffa578", deep: "#c93c10" },
        ink: { DEFAULT: "#191918", soft: "#292927", deep: "#0e0e0d" },
      },
      borderColor: {
        DEFAULT: "rgb(var(--border-default) / <alpha-value>)",
      },
      boxShadow: {
        sm: "var(--app-shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05))",
        md: "var(--app-shadow-md, 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1))",
        lg: "var(--app-shadow-lg, 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1))",
      },
    },
  },
  plugins: [],
};

export default config;
