import type { ThemeId } from "@/lib/constants";

/**
 * A real screenshot of a theme: the storefront renderer with its sample store
 * (components/marketing/sample-store.ts), saved in public/theme-previews. A
 * theme change means taking these again (docs/storefront-commerce.md).
 * Decorative: the surrounding text names the theme.
 */
export default function ThemePreviewImage({ themeId, device = "desktop", className = "aspect-[4/3]" }: { themeId: ThemeId; device?: "desktop" | "mobile"; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/theme-previews/${themeId}${device === "mobile" ? "-mobile" : ""}.webp`}
      alt=""
      aria-hidden="true"
      data-thumb={themeId}
      loading="lazy"
      decoding="async"
      className={`block w-full bg-slate-100 object-cover object-top ${className}`}
    />
  );
}
