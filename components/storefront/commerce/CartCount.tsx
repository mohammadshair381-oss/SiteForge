"use client";

import { useEffect, useRef, useState } from "react";
import { CART_UPDATED_EVENT } from "@/lib/cart-events";

/**
 * Live cart link. Reads the item count from the existing cart API (the cart
 * is resolved from the store Host and the HttpOnly cart cookie, never from a
 * client id) on mount and whenever the cart changes in this tab. In previews
 * (dashboard host, no store cart) it renders a plain link without a count.
 */
export default function CartCount({
  businessId,
  className,
  badgeStyle,
  preview = false,
  compact = false,
}: {
  businessId: string;
  className: string;
  badgeStyle: React.CSSProperties;
  preview?: boolean;
  compact?: boolean;
}) {
  const [count, setCount] = useState<number | null>(null);
  // Increments when the count goes up after the first load (badge bump).
  const [bump, setBump] = useState(0);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (preview) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/businesses/${businessId}/cart`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: Array<{ quantity?: number }> };
        const total = (data.items ?? []).reduce((n, item) => n + (Number(item.quantity) || 0), 0);
        if (cancelled) return;
        if (last.current !== null && total > last.current) setBump((b) => b + 1);
        last.current = total;
        setCount(total);
      } catch {
        // Count stays unknown; the link still works.
      }
    };
    void load();
    window.addEventListener(CART_UPDATED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(CART_UPDATED_EVENT, load);
    };
  }, [businessId, preview]);

  const label = count === null ? "Cart" : `Cart, ${count} item${count === 1 ? "" : "s"}`;
  return (
    <a href="/cart" aria-label={label} className={`relative inline-flex items-center gap-2 ${className}`}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 7h12l-1 13H7L6 7Z" />
        <path d="M9 7a3 3 0 0 1 6 0" />
      </svg>
      {!compact && <span className="hidden text-sm font-medium lg:inline">Cart</span>}
      {count !== null && count > 0 && (
        <span key={bump} aria-hidden="true" className={`${bump > 0 ? "sf-pop " : ""}absolute -right-1.5 -top-1.5 min-w-[1.25rem] rounded-full px-1 text-center text-[11px] font-bold leading-5`} style={badgeStyle}>
          {count > 99 ? "99+" : count}
        </span>
      )}
    </a>
  );
}
