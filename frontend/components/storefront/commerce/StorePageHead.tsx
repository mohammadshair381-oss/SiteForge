import React from "react";
import type { StoreSkin } from "./skins";

/**
 * The heading of a store page (catalog, category) in the same composition as
 * the theme's homepage sections, so inner pages are recognisably the same
 * store. Purely presentational: one h1, then what the page passes in.
 */
export default function StorePageHead({
  skin,
  primary,
  title,
  children,
}: {
  skin: StoreSkin;
  primary: string;
  title: string;
  children?: React.ReactNode;
}) {
  const h1 = `text-3xl sm:text-4xl ${skin.heroHeading}`;
  switch (skin.layout.heading) {
    case "bar":
      return (
        <div className={`relative border-b pb-3 ${skin.border}`}>
          <h1 className={h1}>{title}</h1>
          {children}
          <span aria-hidden="true" className="absolute -bottom-px left-0 h-0.5 w-16" style={{ background: primary }} />
        </div>
      );
    case "flourish":
      return (
        <div className="text-center">
          <div aria-hidden="true" className="mb-3 flex items-center justify-center gap-4">
            <span className="h-px w-12 bg-current opacity-25 sm:w-24" />
            <span className="text-lg leading-none" style={{ color: primary }}>❦</span>
            <span className="h-px w-12 bg-current opacity-25 sm:w-24" />
          </div>
          <h1 className={h1}>{title}</h1>
          {children}
        </div>
      );
    case "index":
      return (
        <div className="grid gap-3 lg:grid-cols-12">
          <span aria-hidden="true" className={`block h-px w-16 self-center bg-current lg:col-span-3 ${skin.subtle}`} />
          <div className="lg:col-span-9">
            <h1 className={`text-4xl sm:text-6xl ${skin.heroHeading}`}>{title}</h1>
            {children}
          </div>
        </div>
      );
    case "slab":
      return (
        <div className="border-b-2 border-neutral-950 pb-3">
          <span aria-hidden="true" className="mb-3 block h-2 w-14" style={{ background: primary }} />
          <h1 className={`text-4xl sm:text-6xl ${skin.heroHeading}`}>{title}</h1>
          {children}
        </div>
      );
    case "caps":
      return (
        <div className="text-center">
          <h1 className={`text-4xl sm:text-6xl ${skin.heroHeading}`}>{title}</h1>
          <span aria-hidden="true" className="mx-auto mt-5 block h-px w-10 bg-current opacity-40" />
          {children}
        </div>
      );
    case "path":
      return (
        <div>
          <p aria-hidden="true" className="font-mono text-xs" style={{ color: primary }}>{"//"}</p>
          <h1 className={`mt-1 ${h1}`}>{title}</h1>
          {children}
        </div>
      );
    case "chip":
      return (
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: primary }} />
          <div className="min-w-0">
            <h1 className={h1}>{title}</h1>
            {children}
          </div>
        </div>
      );
    case "quiet":
      return (
        <div>
          <h1 className={`text-4xl sm:text-6xl ${skin.heroHeading}`}>{title}</h1>
          {children}
        </div>
      );
    case "glow":
    default:
      return (
        <div>
          <span aria-hidden="true" className="mb-4 block h-px w-16" style={{ background: primary }} />
          <h1 className={`text-4xl sm:text-5xl ${skin.heroHeading}`}>{title}</h1>
          {children}
        </div>
      );
  }
}
