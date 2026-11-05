"use client";

import { useEffect, useRef } from "react";

/**
 * Scroll reveals for a storefront page (one tiny island per page).
 *
 * Server-rendered content is always visible: after mount, only `[data-reveal]`
 * elements that are still BELOW the fold are marked "pending" (hidden off
 * screen) and revealed as they scroll into view. Content on screen is never
 * hidden or delayed, the page works without JavaScript, and nothing differs
 * between the server and the first client render (no hydration mismatch).
 * Off with reduced motion. Uses the element's own document and window (the
 * editor renders the store in a frame) and disconnects on unmount.
 */
export default function MotionRoot() {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const doc = marker.current?.ownerDocument;
    const win = doc?.defaultView;
    const root = marker.current?.closest("[data-theme]");
    if (!doc || !win || !root || typeof win.IntersectionObserver !== "function") return;
    if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const targets = [...root.querySelectorAll<HTMLElement>("[data-reveal]")].filter(
      (el) => el.getBoundingClientRect().top > win.innerHeight,
    );
    if (targets.length === 0) return;
    const observer = new win.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.revealState = "in";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.01 },
    );
    for (const el of targets) {
      el.dataset.revealState = "pending";
      observer.observe(el);
    }
    return () => {
      observer.disconnect();
      // Never leave content hidden if the page is torn down mid-scroll.
      for (const el of targets) if (el.dataset.revealState === "pending") el.dataset.revealState = "in";
    };
  }, []);

  return <span ref={marker} hidden />;
}
