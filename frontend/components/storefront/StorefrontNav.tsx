import Link from "next/link";
import type { StorefrontNavigation, StorefrontTheme } from "@/lib/storefront";

export default function StorefrontNav({
  navigation,
  variant = "header",
  theme,
}: {
  navigation?: StorefrontNavigation;
  variant?: "header" | "footer";
  theme?: StorefrontTheme;
}) {
  const items = variant === "header" ? navigation?.header : navigation?.footer;
  // Shown flat, as the store footer does: a dropdown has nothing to open here, and its heading goes nowhere.
  const links = (items ?? []).flatMap((item) => [...(item.href === "#" ? [] : [item]), ...(item.children ?? [])]);
  if (links.length === 0) return null;

  const primaryColor = theme?.primaryColor;
  const isDark = theme?.primaryColor && isDarkColor(theme.primaryColor);

  return (
    <nav
      className="flex flex-wrap gap-2 sm:gap-4 text-sm"
      aria-label={`${variant} navigation`}
    >
      {links.map((item) => (
        <Link
          key={`${item.href ?? item.slug}-${item.label}`}
          href={item.href ?? `/${item.slug}`}
          {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className={`transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 rounded px-1 ${variant === "header" && item.showOn === "desktop" ? "max-md:hidden" : variant === "header" && item.showOn === "mobile" ? "md:hidden" : ""}`}
          style={primaryColor ? { color: "inherit" } : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function isDarkColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}