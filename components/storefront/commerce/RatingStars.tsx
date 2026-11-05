/**
 * Approved-review rating display. Rendered only from real data (callers pass
 * nothing when a product has no approved reviews). `count` is omitted for a
 * single review's own rating.
 */
export default function RatingStars({ average, count, className = "", size = "sm" }: { average: number; count?: number; className?: string; size?: "sm" | "md" }) {
  const filled = Math.round(average);
  const px = size === "md" ? 18 : 14;
  const label =
    count === undefined
      ? `Rated ${average} out of 5`
      : `Rated ${average.toFixed(1)} out of 5 from ${count} ${count === 1 ? "review" : "reviews"}`;
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="inline-flex text-amber-500">
        {[1, 2, 3, 4, 5].map((n) => (
          <svg key={n} width={px} height={px} viewBox="0 0 24 24" fill={filled >= n ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5">
            <path d="m12 3 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9L12 3Z" />
          </svg>
        ))}
      </span>
      {count !== undefined && <span aria-hidden="true" className="text-xs opacity-80">{average.toFixed(1)} ({count})</span>}
    </span>
  );
}
