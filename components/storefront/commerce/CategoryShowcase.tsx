import React from "react";
import type { StorefrontTheme } from "@/lib/storefront";
import type { CommerceCategory } from "@/lib/storefront-home";
import { readableOn, type StoreSkin } from "./skins";

const countLabel = (count: number) => `${count} ${count === 1 ? "product" : "products"}`;

/**
 * "Shop by category" in the theme's composition (`skin.layout.categories`).
 * Categories are real (built by buildCommerceData: two or more categories
 * with active products); images are the owner's category images, else a
 * product image, else a brand-colour tile. Links are the same in every theme.
 */
export default function CategoryShowcase({ categories, skin, theme }: { categories: CommerceCategory[]; skin: StoreSkin; theme: StorefrontTheme }) {
  const gradient = { background: `linear-gradient(135deg, ${theme.primaryColor}, ${theme.accentColor})` };
  const image = (category: CommerceCategory, className: string) =>
    category.imageUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={category.imageUrl} alt="" loading="lazy" decoding="async" className={`h-full w-full object-cover ${className}`} />
    ) : (
      <span aria-hidden="true" className="relative block h-full w-full" style={gradient}>
        <span className="sf-tile-dots absolute inset-0" />
      </span>
    );
  const zoom = "motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out motion-safe:group-hover:scale-105";
  const reveal = (i: number) => ({ "data-reveal": "", style: { "--sf-i": i } as React.CSSProperties });

  switch (skin.layout.categories) {
    case "mosaic":
      return (
        <ul className="grid auto-rows-[11rem] grid-cols-2 gap-3 sm:auto-rows-[14rem] sm:gap-4 lg:auto-rows-[15rem] lg:grid-cols-4">
          {categories.map((category, i) => (
            // The first tile is large; the rest stretch so the block has no gaps.
            <li key={category.href} {...reveal(i)} className={i === 0 ? "col-span-2 row-span-2" : categories.length === 2 ? "col-span-2 row-span-2" : categories.length === 3 ? "lg:col-span-2" : categories.length === 4 && i === 3 ? "col-span-2" : ""}>
              <a href={category.href} className={`group relative block h-full overflow-hidden ${skin.categoryCard} ${skin.focus}`}>
                {image(category, zoom)}
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-4 pt-14 text-white sm:p-6">
                  <span className={`block font-display font-semibold leading-tight ${i === 0 ? "text-2xl sm:text-4xl" : "text-lg sm:text-xl"}`}>{category.name}</span>
                  <span className="text-xs text-white/85 sm:text-sm">{countLabel(category.count)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "menu":
      return (
        <ul className="flex flex-wrap justify-center gap-3">
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)}>
              <a
                href={category.href}
                className={`group inline-flex items-center gap-3 rounded-full border border-[#3b2417]/15 bg-[#fffaf2] py-1.5 pl-1.5 pr-5 transition-colors hover:border-[#3b2417]/45 ${skin.focus}`}
              >
                <span className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-[#ead9c0]">{image(category, zoom)}</span>
                <span className="font-display text-lg font-semibold">{category.name}</span>
                <span className={`text-xs ${skin.subtle}`}>{category.count}</span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "blocks":
      return (
        <ul className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {categories.map((category, i) => {
            const bg = i % 2 === 0 ? theme.primaryColor : "#0a0a0a";
            return (
              <li key={category.href} {...reveal(i)}>
                <a
                  href={category.href}
                  className={`group relative flex aspect-[16/10] overflow-hidden border-2 border-neutral-950 transition-transform duration-200 motion-safe:hover:-translate-y-1 ${skin.focus}`}
                  style={{ background: bg, color: readableOn(bg) }}
                >
                  <span className="absolute inset-y-0 right-0 w-2/5 overflow-hidden border-l-2 border-neutral-950">{image(category, zoom)}</span>
                  {/* Wide enough for a long name, so it never breaks mid-word. */}
                  <span className="relative mt-auto w-3/5 p-3 sm:p-4">
                    <span className="block break-words font-display text-base font-black uppercase leading-none tracking-tight sm:text-lg">{category.name}</span>
                    <span className="mt-2 block text-xs font-bold uppercase tracking-wider opacity-85">
                      {countLabel(category.count)}
                      <span aria-hidden="true" className="ml-1 inline-block transition-transform group-hover:translate-x-1">→</span>
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      );

    case "rail":
      return (
        <ul
          className={`sf-scroll-x -mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-2 sm:-mx-5 sm:px-5 lg:mx-0 lg:grid lg:overflow-visible lg:px-0 ${categories.length < 6 ? "lg:[grid-template-columns:repeat(var(--sf-cols),minmax(0,14rem))]" : "lg:grid-cols-6"}`}
          style={{ "--sf-cols": categories.length } as React.CSSProperties}
        >
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)} className="w-36 shrink-0 snap-start sm:w-44 lg:w-auto">
              <a href={category.href} className={`group block h-full rounded-xl border border-gray-200 bg-white p-2 transition-shadow hover:shadow-md ${skin.focus}`}>
                <span className="block aspect-square overflow-hidden rounded-lg bg-gray-100">{image(category, zoom)}</span>
                <span className="mt-2 block truncate px-1 text-sm font-bold">{category.name}</span>
                <span className={`block px-1 pb-1 text-xs ${skin.subtle}`}>{countLabel(category.count)}</span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "index":
      return (
        <ul className="border-t border-neutral-900">
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)} className="border-b border-neutral-200">
              <a href={category.href} className={`group flex items-center gap-4 py-5 sm:gap-8 sm:py-7 ${skin.focus}`}>
                <span aria-hidden="true" className="w-8 text-[11px] tabular-nums text-neutral-500">{String(i + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1 break-words font-display text-3xl font-light tracking-tight transition-transform duration-500 motion-safe:group-hover:translate-x-2 sm:text-5xl">
                  {category.name}
                </span>
                <span aria-hidden="true" className="hidden h-16 w-12 shrink-0 overflow-hidden bg-neutral-100 opacity-0 transition-opacity duration-500 group-hover:opacity-100 sm:block">
                  {image(category, "")}
                </span>
                <span className="shrink-0 text-xs uppercase tracking-[0.2em] text-neutral-600">{countLabel(category.count)}</span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "campaign":
      return (
        <ul className="grid gap-3 sm:gap-5 md:grid-cols-2 lg:grid-cols-3">
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)}>
              <a href={category.href} className={`group relative block aspect-[3/4] overflow-hidden bg-[#ece7dd] ${skin.focus}`}>
                {image(category, zoom)}
                <span className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/5 to-transparent" />
                <span className="absolute inset-x-0 bottom-0 p-6 text-center text-white sm:p-8">
                  <span className="block font-display text-3xl sm:text-4xl">{category.name}</span>
                  <span className="mt-3 inline-block text-[11px] uppercase tracking-[0.3em] underline decoration-1 underline-offset-8">{countLabel(category.count)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "tech":
      return (
        <ul className={`grid gap-3 sm:grid-cols-2 ${categories.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)}>
              <a
                href={category.href}
                className={`group flex items-center gap-4 rounded-2xl border border-white/10 bg-[#11141a] p-3 transition-[border-color,box-shadow] duration-300 hover:border-white/25 hover:shadow-[0_0_0_1px_var(--sf-accent)] ${skin.focus}`}
              >
                <span className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[#1b202a]">{image(category, zoom)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-white">{category.name}</span>
                  <span className="font-mono text-xs text-zinc-400">{countLabel(category.count)}</span>
                </span>
                <span aria-hidden="true" className="text-zinc-400 transition-transform group-hover:translate-x-1 group-hover:text-white">→</span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "bubbles":
      return (
        <ul className="sf-scroll-x -mx-3 flex snap-x gap-4 overflow-x-auto px-3 pb-2 sm:mx-0 sm:flex-wrap sm:gap-6 sm:overflow-visible sm:px-0">
          {categories.map((category, i) => (
            <li key={category.href} {...reveal(i)} className="w-20 shrink-0 snap-start sm:w-24">
              <a href={category.href} className={`group flex flex-col items-center gap-2 rounded-2xl text-center ${skin.focus}`}>
                <span className="block h-20 w-20 overflow-hidden rounded-full bg-[#eef4e6] ring-2 ring-transparent ring-offset-2 transition group-hover:ring-[color:var(--sf-primary)] sm:h-24 sm:w-24">
                  {image(category, zoom)}
                </span>
                <span className="text-sm font-semibold leading-tight">{category.name}</span>
                <span className={`text-xs ${skin.subtle}`}>{category.count}</span>
              </a>
            </li>
          ))}
        </ul>
      );

    case "rooms": {
      const stories = categories.slice(0, 3);
      const rest = categories.slice(3);
      return (
        <div>
          <ul className="space-y-14 sm:space-y-20">
            {stories.map((category, i) => (
              <li key={category.href} data-reveal="">
                <a href={category.href} className={`group grid items-center gap-8 lg:grid-cols-5 lg:gap-14 ${skin.focus}`}>
                  <span className={`block aspect-[4/3] overflow-hidden bg-[#e6e0d6] lg:col-span-3 ${i % 2 === 1 ? "lg:order-last" : ""}`}>{image(category, zoom)}</span>
                  <span className="lg:col-span-2">
                    <span className={`block ${skin.eyebrow}`}>{countLabel(category.count)}</span>
                    <span className="mt-3 block font-display text-4xl font-light tracking-tight sm:text-5xl">{category.name}</span>
                    <span aria-hidden="true" className="mt-6 inline-flex items-center gap-2 border-b border-current pb-1 text-sm">
                      Explore
                      <span className="transition-transform group-hover:translate-x-1">→</span>
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {rest.length > 0 && (
            <ul className="mt-14 flex flex-wrap gap-x-8 gap-y-3 border-t border-[#2a2621]/15 pt-8">
              {rest.map((category) => (
                <li key={category.href}>
                  <a href={category.href} className={`font-display text-2xl font-light underline-offset-8 hover:underline ${skin.focus}`}>
                    {category.name} <span className={`text-sm ${skin.subtle}`}>({category.count})</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
  }
}
