/**
 * SiteForge identity: an ink tile holding three forged bars, the middle one
 * still hot. Decorative: pass the name to screen readers through the wordmark
 * (or the surrounding link).
 */
export function LogoMark({ className = "h-7 w-7", tone = "ink" }: { className?: string; tone?: "ink" | "light" }) {
  const tile = tone === "light" ? "#ffffff" : "#191918";
  const bar = tone === "light" ? "#191918" : "#ffffff";
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill={tile} />
      <path d="M9 11.5 12 8h11l-3 3.5z" fill={bar} />
      <path d="M23 14.25 20 17.75H9l3-3.5z" fill="#f4511e" />
      <path d="M9 20.5h14l-3 3.5H9z" fill={bar} />
    </svg>
  );
}

export function Logo({ className = "", tone = "ink", size = "md" }: { className?: string; tone?: "ink" | "light"; size?: "sm" | "md" | "lg" }) {
  const mark = size === "lg" ? "h-9 w-9" : size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const text = size === "lg" ? "text-2xl" : size === "sm" ? "text-base" : "text-lg";
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark className={mark} tone={tone} />
      <span className={`font-heading font-semibold tracking-tight ${text} ${tone === "light" ? "text-white" : "text-slate-900"}`}>SiteForge</span>
    </span>
  );
}
