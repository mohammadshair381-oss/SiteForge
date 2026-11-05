import React from "react";
import type { StorefrontProduct, StorefrontView } from "@/lib/storefront";
import type { CommerceBenefit, CommerceData, CommerceSection } from "@/lib/storefront-home";
import type { SectionAppearance } from "@/lib/storefront-config";
import { repeatedRailIds } from "@/lib/storefront-home";
import { responsiveCss } from "@/lib/section-responsive";
import { brandTextColor, fewProductsGrid, readableOn, type StoreSkin } from "./skins";
import ProductCard from "./ProductCard";
import StoreHero from "./StoreHero";
import CategoryShowcase from "./CategoryShowcase";
import SectionRenderer from "../SectionRenderer";

const SECTION_LABELS: Record<CommerceSection["type"], string> = {
  categories: "Categories",
  featured: "Product collection",
  bestSellers: "Best sellers",
  newArrivals: "New arrivals",
  sale: "On sale",
  promotions: "Promotions",
  benefits: "Shopping information",
  story: "About",
  block: "Content",
};

/** Scroll reveal target (MotionRoot), staggered by position. */
const reveal = (i = 0) => ({ "data-reveal": "", style: { "--sf-i": i } as React.CSSProperties });

type ProductSection = Extract<CommerceSection, { products: StorefrontProduct[] }>;

/**
 * Commerce homepage body shared by every theme: hero, then the owner's
 * enabled sections in the owner's order. Every section is already filtered
 * to real, non-empty data by `buildCommerceData`; this component only lays
 * it out in the theme's composition (`skin.layout`): how a section introduces
 * itself, how products are arranged, and how benefits, promotions and the
 * story are built. The SAME component renders the public store, the dashboard
 * preview and the website editor; `editable` only adds selection targets
 * (never different content).
 */
export default function CommerceHome({
  view,
  commerce,
  skin,
  productHrefBase,
  preview,
  editable,
  selectedSectionId,
}: {
  view: StorefrontView;
  commerce: CommerceData;
  skin: StoreSkin;
  productHrefBase: string;
  preview?: boolean;
  editable?: boolean;
  /** Editor only: the selected homepage section ("hero" or a section id). */
  selectedSectionId?: string | null;
}) {
  const { theme } = view;
  const layout = skin.layout;
  const productHref = (p: StorefrontProduct) => `${productHrefBase}/${p.slug}`;
  const primaryButton = { background: theme.primaryColor, color: readableOn(theme.primaryColor) };
  const columns = layout.card === "menu" ? 2 : 4;

  /** Editor selection target with a visible selected outline (editor only). */
  const editorWrap = (id: string, label: string, node: React.ReactNode) =>
    editable ? (
      <div
        key={id}
        data-editor-id={`home:${id}`}
        data-editor-section-id={`home:${id}`}
        data-editor-label={label}
        tabIndex={0}
        aria-current={selectedSectionId === id ? "true" : undefined}
        className={`relative cursor-pointer outline-offset-[-3px] hover:outline hover:outline-2 hover:outline-sky-400/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
          selectedSectionId === id ? "outline outline-[3px] outline-sky-500" : ""
        }`}
      >
        {node}
      </div>
    ) : (
      node
    );

  const background = (appearance: SectionAppearance): { className: string; style?: React.CSSProperties } =>
    appearance.background === "alt"
      ? { className: skin.sectionAlt }
      : appearance.background === "accent"
        ? { className: "", style: { background: `${skin.dark ? theme.accentColor : theme.primaryColor}14` } }
        : { className: "" };

  const repeated = repeatedRailIds(commerce.sections);
  const rendered = commerce.sections.filter((section) => !repeated.has(section.id));
  // Numbered headings count the sections that have a heading.
  const headingNumber = new Map(rendered.filter((section) => section.title).map((section, i) => [section.id, i + 1]));

  const titleNode = (section: CommerceSection, className = skin.heading) =>
    section.title ? <h2 id={`home-${section.id}`} className={className}>{section.title}</h2> : null;
  const subtitleNode = (section: CommerceSection, className = skin.eyebrow) =>
    section.subtitle ? (
      <p className={className} style={skin.id === "launch" ? { color: brandTextColor(theme.primaryColor, skin.dark) } : undefined}>{section.subtitle}</p>
    ) : null;

  const viewAll = (href: string) => {
    const arrow = <span aria-hidden="true" className="ml-1 inline-block transition-transform group-hover:translate-x-1">→</span>;
    const base = `group inline-flex shrink-0 items-center ${skin.focus}`;
    switch (layout.heading) {
      case "slab":
        return <a href={href} className={`${base} border-2 border-neutral-950 px-3 py-1.5 text-xs font-black uppercase tracking-wide transition-colors hover:bg-neutral-950 hover:text-white`}>View all{arrow}</a>;
      case "chip":
        return <a href={href} className={`${base} min-h-9 rounded-full px-4 text-sm font-bold`} style={{ background: `${theme.primaryColor}14` }}>See all{arrow}</a>;
      case "caps":
        return <a href={href} className={`${base} text-[11px] uppercase tracking-[0.3em] underline decoration-1 underline-offset-8`}>View all</a>;
      case "path":
        return <a href={href} className={`${base} rounded font-mono text-xs underline-offset-4 hover:underline`}>view all{arrow}</a>;
      case "bar":
        return <a href={href} className={`${base} rounded text-sm font-bold underline-offset-4 hover:underline`} style={{ color: brandTextColor(theme.primaryColor, skin.dark) }}>View all{arrow}</a>;
      default:
        return <a href={href} className={`${base} rounded text-sm font-semibold underline-offset-4 hover:underline`}>View all{arrow}</a>;
    }
  };

  /**
   * The section's introduction in the theme's composition. A section the owner
   * aligned to the centre keeps its centred heading in every theme.
   */
  const head = (section: CommerceSection, action?: React.ReactNode, stacked = false): React.ReactNode => {
    if (!section.title && !section.subtitle && !action) return null;
    const composition = section.appearance.align === "center" && layout.heading !== "flourish" && layout.heading !== "caps" ? "centered" : layout.heading;
    switch (composition) {
      case "centered":
        return (
          <div {...reveal()} className="mb-6 flex flex-col items-center gap-3 text-center sm:mb-10">
            <div>
              <SectionOrnament skin={skin} theme={theme} centered />
              {subtitleNode(section)}
              {titleNode(section, `mt-2 ${skin.heading}`)}
            </div>
            {action}
          </div>
        );
      case "bar":
        return (
          <div {...reveal()} className={`relative mb-4 flex items-end justify-between gap-4 border-b pb-2.5 ${skin.border}`}>
            <div className="min-w-0">
              {subtitleNode(section)}
              {titleNode(section)}
            </div>
            {action}
            <span aria-hidden="true" className="absolute -bottom-px left-0 h-0.5 w-16" style={{ background: theme.primaryColor }} />
          </div>
        );
      case "flourish":
        return (
          <div {...reveal()} className="mb-8 text-center sm:mb-12">
            <div aria-hidden="true" className="flex items-center justify-center gap-4">
              <span className="h-px w-12 bg-current opacity-25 sm:w-24" />
              <span className="text-lg leading-none" style={{ color: theme.primaryColor }}>❦</span>
              <span className="h-px w-12 bg-current opacity-25 sm:w-24" />
            </div>
            {subtitleNode(section, `mt-3 ${skin.eyebrow}`)}
            {titleNode(section, `mt-2 ${skin.heading}`)}
            {action && <div className="mt-3 flex justify-center">{action}</div>}
          </div>
        );
      case "index": {
        const number = String(headingNumber.get(section.id) ?? 0).padStart(2, "0");
        const label = (
          <div className="flex items-baseline gap-3">
            <span aria-hidden="true" className={`text-[11px] tabular-nums ${skin.subtle}`}>{number}</span>
            {subtitleNode(section)}
          </div>
        );
        // Beside its products, the heading is one narrow column.
        if (stacked) {
          return (
            <div {...reveal()} className="mb-6 lg:mb-0">
              {label}
              {titleNode(section, `mt-4 ${skin.heading}`)}
              {action && <div className="mt-6">{action}</div>}
            </div>
          );
        }
        return (
          <div {...reveal()} className="mb-8 grid items-baseline gap-3 sm:mb-12 lg:grid-cols-12">
            <div className="lg:col-span-3">{label}</div>
            <div className="lg:col-span-7">{titleNode(section)}</div>
            {action && <div className="lg:col-span-2 lg:text-right">{action}</div>}
          </div>
        );
      }
      case "slab":
        return (
          <div {...reveal()} className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b-2 border-neutral-950 pb-3 sm:mb-8">
            <div className="min-w-0">
              <SectionOrnament skin={skin} theme={theme} centered={false} />
              {subtitleNode(section)}
              {titleNode(section, `mt-1 ${skin.heading}`)}
            </div>
            {action}
          </div>
        );
      case "caps":
        return (
          <div {...reveal()} className="mb-8 text-center sm:mb-14">
            {subtitleNode(section)}
            {titleNode(section, `mt-3 ${skin.heading}`)}
            <span aria-hidden="true" className={`mx-auto mt-5 block h-px w-10 bg-current opacity-40`} />
            {action && <div className="mt-5 flex justify-center">{action}</div>}
          </div>
        );
      case "path": {
        const count = "products" in section ? section.products.length : null;
        return (
          <div {...reveal()} className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-7">
            <div className="min-w-0">
              <p className="font-mono text-xs" style={{ color: brandTextColor(theme.primaryColor, skin.dark) ?? theme.accentColor }}>
                <span aria-hidden="true">{"// "}</span>{section.subtitle}
              </p>
              {titleNode(section, `mt-1.5 ${skin.heading}`)}
            </div>
            <div className="flex items-center gap-4">
              {count !== null && <span className={`rounded border px-2 py-0.5 font-mono text-xs ${skin.border} ${skin.subtle}`}>{count} {count === 1 ? "item" : "items"}</span>}
              {action}
            </div>
          </div>
        );
      }
      case "chip":
        return (
          <div {...reveal()} className="mb-3 flex items-center justify-between gap-3 sm:mb-4">
            <div className="flex min-w-0 items-center gap-3">
              <span aria-hidden="true" className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: theme.primaryColor }} />
              <div className="min-w-0">
                {titleNode(section)}
                {subtitleNode(section, "text-sm font-semibold opacity-80")}
              </div>
            </div>
            {action}
          </div>
        );
      case "quiet":
        return (
          <div {...reveal()} className="mb-8 grid items-end gap-4 sm:mb-14 lg:grid-cols-2">
            {titleNode(section)}
            <div className="flex items-baseline justify-between gap-6 lg:justify-end">
              {subtitleNode(section)}
              {action}
            </div>
          </div>
        );
      case "glow":
      default:
        return (
          <div {...reveal()} className="mb-6 flex items-end justify-between gap-4 sm:mb-10">
            <div className="min-w-0">
              <SectionOrnament skin={skin} theme={theme} centered={false} />
              {subtitleNode(section)}
              {titleNode(section, `mt-2 ${skin.heading}`)}
            </div>
            {action}
          </div>
        );
    }
  };

  const frame = (section: CommerceSection, body: React.ReactNode, override?: { className?: string; style?: React.CSSProperties; flush?: boolean }) => {
    const bg = background(section.appearance);
    return (
      <section
        key={section.id}
        {...(section.title ? { "aria-labelledby": `home-${section.id}` } : { "aria-label": SECTION_LABELS[section.type] })}
        data-section={section.type}
        className={`${override?.flush ? "" : skin.spacing[section.appearance.spacing]} ${skin.divider} ${override?.className ?? bg.className}`}
        style={override?.style ?? bg.style}
      >
        {body}
      </section>
    );
  };

  const card = (product: StorefrontProduct, flush = false) => (
    <ProductCard product={product} href={productHref(product)} skin={skin} theme={theme} businessId={commerce.businessId} preview={preview} flush={flush} />
  );

  /** The theme's ordinary product grid (a few products fill the width). */
  const plainGrid = (products: StorefrontProduct[]) => {
    const few = fewProductsGrid(products.length, skin);
    return (
      <ul className={`${skin.grid} ${few.className}`} style={few.style}>
        {products.map((product, i) => (
          <li key={product.id} {...reveal(i % columns)}>{card(product)}</li>
        ))}
      </ul>
    );
  };

  const productRail = (section: ProductSection): React.ReactNode => {
    const { products } = section;
    const action = section.viewAll ? viewAll(section.viewAll) : null;

    switch (layout.rail) {
      case "scroller":
        // Large products that scroll sideways, past the container's right edge.
        return (
          <div className={skin.container}>
            {head(section, action)}
            {products.length >= 4 ? (
              <ul className="sf-scroll-x -mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:gap-6 sm:px-6 lg:-mx-10 lg:px-10">
                {products.map((product, i) => (
                  <li key={product.id} {...reveal(Math.min(i, 3))} className="w-[72vw] max-w-[22rem] shrink-0 snap-start sm:w-[22rem]">{card(product)}</li>
                ))}
              </ul>
            ) : (
              plainGrid(products)
            )}
          </div>
        );

      case "panel":
        return (
          <div className={skin.container}>
            <div className="rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
              {head(section, action)}
              {plainGrid(products)}
            </div>
          </div>
        );

      case "board": {
        const few = fewProductsGrid(products.length, skin);
        return (
          <div className={skin.container}>
            {head(section, action)}
            <div className="rounded-[2rem] border-4 border-double border-[#3b2417]/25 bg-[#fffaf2] p-3 sm:p-6 lg:p-10">
              <ul className={`${skin.grid} ${few.className}`} style={few.style}>
                {products.map((product, i) => (
                  <li key={product.id} {...reveal(i % columns)}>{card(product, true)}</li>
                ))}
              </ul>
            </div>
          </div>
        );
      }

      case "aside":
        return (
          <div className={`${skin.container} lg:grid lg:grid-cols-12 lg:gap-8`}>
            <div className="lg:col-span-3">
              <div className="lg:sticky lg:top-8">{head(section, action, true)}</div>
            </div>
            <div className="lg:col-span-9">{plainGrid(products)}</div>
          </div>
        );

      case "bento": {
        if (products.length < 5) {
          return (
            <div className={skin.container}>
              {head(section, action)}
              {plainGrid(products)}
            </div>
          );
        }
        // One large product, then a brand-coloured tile fills the row's gap.
        const rest = products.length - 1;
        const gapLarge = (4 - ((4 + rest) % 4)) % 4;
        const tileLarge = gapLarge === 3 ? "lg:col-span-3" : gapLarge === 2 ? "lg:col-span-2" : gapLarge === 1 ? "lg:col-span-1" : "lg:hidden";
        const tileSmall = rest % 2 === 1 ? "col-span-1" : "col-span-2";
        return (
          <div className={skin.container}>
            {head(section)}
            <ul className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
              {products.map((product, i) => (
                <li key={product.id} {...reveal(i % 4)} className={i === 0 ? "col-span-2 lg:row-span-2" : ""}>{card(product)}</li>
              ))}
              <li {...reveal(3)} className={`${tileSmall} ${tileLarge}`}>
                <a
                  href={section.viewAll ?? "/products"}
                  className={`group flex h-full min-h-28 items-end justify-between gap-2 border-2 border-neutral-950 p-4 font-display text-xl font-black uppercase leading-none tracking-tight sm:text-3xl ${skin.focus}`}
                  style={primaryButton}
                >
                  View all
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
                </a>
              </li>
            </ul>
          </div>
        );
      }

      case "lookbook": {
        if (products.length < 5) {
          return (
            <div className={skin.container}>
              {head(section, action)}
              {plainGrid(products)}
            </div>
          );
        }
        const [lead, ...others] = products;
        const beside = others.slice(0, 4);
        const below = others.slice(4);
        return (
          <div className={skin.container}>
            {head(section, action)}
            <div className="grid gap-x-6 gap-y-12 lg:grid-cols-2 lg:gap-x-10">
              <div {...reveal()}>{card(lead)}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-12 sm:gap-x-6">
                {beside.map((product, i) => (
                  <li key={product.id} {...reveal(i)}>{card(product)}</li>
                ))}
              </ul>
            </div>
            {below.length > 0 && <div className="mt-12">{plainGrid(below)}</div>}
          </div>
        );
      }

      case "cells": {
        const few = fewProductsGrid(products.length, skin);
        return (
          <div className={skin.container}>
            {head(section, action)}
            <ul className={`grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3 lg:grid-cols-4 ${few.className}`} style={few.style}>
              {products.map((product, i) => (
                <li key={product.id} {...reveal(i % columns)} className="bg-[#0a0c10]">{card(product, true)}</li>
              ))}
            </ul>
          </div>
        );
      }

      case "shelf":
        return (
          <div className={skin.container}>
            {head(section, action)}
            <div className="w-fit max-w-full rounded-3xl p-2 sm:p-4" style={{ background: `${theme.primaryColor}0f` }}>
              <ul className="sf-scroll-x flex snap-x gap-2.5 overflow-x-auto pb-1 sm:gap-4">
                {products.map((product, i) => (
                  <li key={product.id} {...reveal(Math.min(i, 3))} className="w-40 shrink-0 snap-start sm:w-52 lg:w-60">{card(product)}</li>
                ))}
              </ul>
            </div>
          </div>
        );

      case "stagger": {
        const few = fewProductsGrid(products.length, skin);
        return (
          <div className={skin.container}>
            {head(section, action)}
            <ul className={`${skin.grid} ${few.className}`} style={few.style}>
              {products.map((product, i) => (
                <li key={product.id} {...reveal(i % columns)} className="lg:[&:nth-child(3n+2)]:mt-20">{card(product)}</li>
              ))}
            </ul>
          </div>
        );
      }
    }
  };

  const benefitIconColor = { color: skin.dark ? theme.accentColor : theme.primaryColor };

  const benefitsBody = (section: Extract<CommerceSection, { type: "benefits" }>): React.ReactNode => {
    const items = section.benefits;
    const wide = items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "lg:grid-cols-3" : "";
    const intro = section.title ? head(section) : <h2 className="sr-only">Shopping information</h2>;
    const body = (() => {
      switch (layout.benefits) {
        case "strip":
          return (
            <ul className={`grid divide-y rounded-xl border border-gray-200 bg-white sm:grid-cols-2 sm:divide-y-0 lg:divide-x ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="flex items-center gap-3 p-3 sm:p-4">
                  <span className="shrink-0" style={benefitIconColor}><BenefitIcon benefit={benefit} /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold leading-5">{benefit.title}</p>
                    <p className={`text-xs leading-5 ${skin.muted}`}>{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          );
        case "notes":
          return (
            <ul className={`grid gap-8 divide-[#3b2417]/20 text-center sm:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-dashed ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="px-6">
                  <span className="inline-block" style={benefitIconColor}><BenefitIcon benefit={benefit} /></span>
                  <p className="mt-3 font-display text-lg font-semibold">{benefit.title}</p>
                  <p className={`mt-1 text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                </li>
              ))}
            </ul>
          );
        case "ruled":
          return (
            <ol className={`grid gap-8 sm:grid-cols-2 lg:gap-8 ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="border-t border-neutral-900 pt-4">
                  <span aria-hidden="true" className={`block text-[11px] tabular-nums ${skin.subtle}`}>{String(i + 1).padStart(2, "0")}</span>
                  <p className="mt-6 font-display text-xl font-light tracking-tight">{benefit.title}</p>
                  <p className={`mt-2 text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                </li>
              ))}
            </ol>
          );
        case "cells":
          return (
            <ul className={`grid gap-px border-2 border-neutral-950 bg-neutral-950 sm:grid-cols-2 ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="flex flex-col gap-4 bg-white p-5" style={i === 0 ? primaryButton : undefined}>
                  <BenefitIcon benefit={benefit} />
                  <div>
                    <p className="font-display text-lg font-black uppercase leading-tight tracking-tight">{benefit.title}</p>
                    <p className="mt-1 text-sm leading-6 opacity-85">{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          );
        case "line":
          return (
            <ul className="flex flex-wrap justify-center gap-x-14 gap-y-8 text-center">
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="w-full max-w-[16rem]">
                  <p className="text-[11px] uppercase tracking-[0.28em]">{benefit.title}</p>
                  <p className={`mt-3 text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                </li>
              ))}
            </ul>
          );
        case "spec":
          return (
            <ul className={`divide-y divide-white/10 overflow-hidden rounded-2xl border ${skin.border}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="grid gap-1 bg-[#11141a] px-4 py-3 sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-center sm:gap-6 sm:px-5">
                  <p className="flex items-center gap-3 font-mono text-sm text-white">
                    <span className="shrink-0" style={benefitIconColor}><BenefitIcon benefit={benefit} /></span>
                    {benefit.title}
                  </p>
                  <p className={`text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                </li>
              ))}
            </ul>
          );
        case "bubbles":
          return (
            <ul className={`grid gap-2.5 sm:grid-cols-2 sm:gap-4 ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className="flex items-center gap-3 rounded-3xl p-3" style={{ background: `${theme.primaryColor}12` }}>
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white" style={benefitIconColor}><BenefitIcon benefit={benefit} /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-extrabold">{benefit.title}</p>
                    <p className={`text-xs leading-5 ${skin.muted}`}>{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          );
        case "list":
          return (
            <ul className="grid gap-x-12 sm:grid-cols-2">
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className={`flex gap-6 border-t py-6 ${skin.border}`}>
                  <span className="shrink-0 opacity-70"><BenefitIcon benefit={benefit} /></span>
                  <div>
                    <p className="font-display text-xl font-light tracking-tight">{benefit.title}</p>
                    <p className={`mt-1 text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          );
        case "glass":
        default:
          return (
            <ul className={`grid gap-4 sm:grid-cols-2 ${wide}`}>
              {items.map((benefit, i) => (
                <li key={benefit.key} {...reveal(i)} className={`flex flex-col gap-6 p-6 ${skin.benefit}`}>
                  <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/5" style={benefitIconColor}><BenefitIcon benefit={benefit} /></span>
                  <div>
                    <p className="font-semibold">{benefit.title}</p>
                    <p className={`mt-1 text-sm leading-6 ${skin.muted}`}>{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          );
      }
    })();
    return (
      <div className={skin.container}>
        {intro}
        {body}
      </div>
    );
  };

  const storySection = (section: Extract<CommerceSection, { type: "story" }>): React.ReactNode => {
    const center = section.appearance.align === "center";
    const body = (className: string) => <p className={`whitespace-pre-line ${className}`}>{section.text}</p>;
    const display = "font-display text-2xl font-light leading-[1.45] tracking-tight sm:text-3xl sm:leading-[1.4]";
    const reading = `text-base leading-7 sm:text-lg sm:leading-8 ${skin.muted}`;
    const stackedHead = (className = "") => (
      <div className={className}>
        {subtitleNode(section)}
        {titleNode(section, `mt-2 ${skin.heading}`)}
      </div>
    );

    switch (layout.story) {
      case "plain":
        return frame(
          section,
          <div className={skin.container}>
            <div id="about" {...reveal()} className={`rounded-2xl border border-gray-200 bg-white p-6 sm:p-10 lg:grid lg:grid-cols-3 lg:gap-10 ${center ? "text-center lg:text-left" : ""}`}>
              {stackedHead()}
              {body(`mt-4 lg:col-span-2 lg:mt-0 ${reading}`)}
            </div>
          </div>,
        );
      case "centered":
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} max-w-3xl text-center`}>
            <p aria-hidden="true" className="text-2xl leading-none" style={{ color: theme.primaryColor }}>❦</p>
            {stackedHead("mt-3")}
            {body(`mt-6 ${reading}`)}
            <p aria-hidden="true" className="mt-6 text-2xl leading-none" style={{ color: theme.primaryColor }}>❦</p>
          </div>,
        );
      case "offset":
        // The heading in its own column, the words in a larger one.
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} grid gap-6 lg:grid-cols-12 lg:gap-8`}>
            {stackedHead("lg:col-span-3")}
            {body(`lg:col-span-9 ${display} sm:text-4xl sm:leading-[1.25]`)}
          </div>,
        );
      case "shout":
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} ${center ? "text-center" : ""}`}>
            {section.subtitle && <p className="text-xs font-black uppercase tracking-[0.2em] opacity-85">{section.subtitle}</p>}
            {titleNode(section, `mt-2 ${skin.heading} !text-current`)}
            {body("mt-6 max-w-5xl font-display text-2xl font-black uppercase leading-[1.1] tracking-tight sm:text-4xl lg:text-5xl")}
          </div>,
          { className: "border-y-2 border-neutral-950", style: primaryButton },
        );
      case "manifesto":
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} max-w-4xl text-center`}>
            {stackedHead()}
            <span aria-hidden="true" className="mx-auto mt-6 block h-px w-10 bg-current opacity-40" />
            {body("mt-8 font-display text-2xl leading-[1.5] sm:text-4xl sm:leading-[1.4]")}
          </div>,
        );
      case "readme":
        return frame(
          section,
          <div className={skin.container}>
            <div id="about" {...reveal()} className={`overflow-hidden rounded-2xl border bg-[#11141a] ${skin.border}`}>
              <div className={`flex items-center gap-2 border-b px-4 py-2.5 ${skin.border}`}>
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: theme.primaryColor }} />
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: theme.accentColor }} />
                {section.subtitle && <p className={`ml-2 font-mono text-xs ${skin.subtle}`}>{section.subtitle}</p>}
              </div>
              <div className={`p-5 sm:p-8 ${center ? "text-center" : ""}`}>
                {titleNode(section)}
                {body(`mt-4 max-w-4xl ${center ? "mx-auto" : ""} ${reading}`)}
              </div>
            </div>
          </div>,
        );
      case "note":
        return frame(
          section,
          <div className={skin.container}>
            <div id="about" {...reveal()} className={`relative overflow-hidden rounded-3xl p-6 sm:p-10 ${center ? "text-center" : ""}`} style={{ background: `${theme.primaryColor}14` }}>
              <span aria-hidden="true" className="absolute -right-12 -top-12 h-40 w-40 rounded-full opacity-20" style={{ background: theme.accentColor }} />
              <div className="relative">
                {stackedHead()}
                {body(`mt-4 max-w-3xl ${center ? "mx-auto" : ""} ${reading}`)}
              </div>
            </div>
          </div>,
        );
      case "spread":
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} grid gap-8 lg:grid-cols-2 lg:gap-16`}>
            {stackedHead()}
            {body(reading)}
          </div>,
        );
      case "statement":
      default:
        return frame(
          section,
          <div id="about" {...reveal()} className={`${skin.container} max-w-5xl ${center ? "text-center" : ""}`}>
            <SectionOrnament skin={skin} theme={theme} centered={center} />
            {stackedHead()}
            {body(`mt-6 ${display}`)}
          </div>,
        );
    }
  };

  const renderSection = (section: CommerceSection): React.ReactNode => {
    const centered = section.appearance.align === "center";
    switch (section.type) {
      case "featured":
      case "bestSellers":
      case "newArrivals":
      case "sale":
        return frame(section, productRail(section));
      case "categories":
        return frame(
          section,
          <div className={skin.container}>
            {head(section)}
            <CategoryShowcase categories={section.categories} skin={skin} theme={theme} />
          </div>,
        );
      case "promotions":
        return frame(
          section,
          <>
            {(section.title || section.subtitle) && <div className={skin.container}>{head(section)}</div>}
            {layout.promo === "bleed" ? (
              <Promotions promotions={section.promotions} skin={skin} view={view} centered={centered} primaryButton={primaryButton} />
            ) : (
              <div className={skin.container}>
                <Promotions promotions={section.promotions} skin={skin} view={view} centered={centered} primaryButton={primaryButton} />
              </div>
            )}
          </>,
        );
      case "benefits":
        return frame(section, benefitsBody(section));
      case "story":
        return storySection(section);
      case "block":
        return (
          <div key={section.id} data-section="block" className={skin.divider}>
            <SectionRenderer embedded insideStoreRoot showHeader={false} view={{ ...view, theme: { ...view.theme, sections: [section.block] } }} productHrefBase={productHrefBase} preview={preview} />
          </div>
        );
    }
  };

  const responsiveRules = responsiveCss(Object.entries(commerce.sectionResponsive).map(([id, responsive]) => ({ id, responsive })));

  // Launch: a looping strip of real category names (or benefit titles).
  const marqueeItems = layout.marquee
    ? commerce.categories.length >= 2
      ? commerce.categories.map((c) => ({ label: c.name, href: c.href }))
      : commerce.benefits.map((b) => ({ label: b.title, href: null as string | null }))
    : [];

  return (
    <main id="main">
      {commerce.hero && editorWrap("hero", "Hero banner", <StoreHero view={view} commerce={commerce} skin={skin} />)}
      {marqueeItems.length >= 2 && <Marquee items={marqueeItems} skin={skin} color={theme.primaryColor} />}
      {responsiveRules && <style>{responsiveRules}</style>}
      {rendered.map((section) => {
        const node = editorWrap(section.id, SECTION_LABELS[section.type], renderSection(section));
        return commerce.sectionResponsive[section.id] ? <div key={section.id} data-rs={section.id} className="contents">{node}</div> : node;
      })}
      {commerce.totalProducts === 0 && !commerce.hero?.primaryCta && commerce.sections.length === 0 && (
        <section className="py-20">
          <div className={`${skin.container} max-w-xl text-center`}>
            <h2 className={skin.heading}>Our shop is being prepared</h2>
            <p className={`mt-3 ${skin.muted}`}>Products will appear here once they are published.</p>
          </div>
        </section>
      )}
    </main>
  );
}

/** The small mark above a section heading: each theme has its own. */
export function SectionOrnament({ skin, theme, centered }: { skin: StoreSkin; theme: StorefrontView["theme"]; centered: boolean }) {
  const align = centered ? "mx-auto" : "";
  switch (skin.ornament) {
    case "glow":
      return <span aria-hidden="true" className={`mb-4 block h-px w-16 ${align}`} style={{ background: `linear-gradient(90deg, ${theme.primaryColor}, ${theme.accentColor})` }} />;
    case "flourish":
      return <span aria-hidden="true" className={`mb-1 block text-lg leading-none ${centered ? "text-center" : ""}`} style={{ color: theme.primaryColor }}>❦</span>;
    case "rule":
      return <span aria-hidden="true" className={`mb-4 block h-px w-10 bg-current opacity-40 ${align}`} />;
    case "block":
      return <span aria-hidden="true" className={`mb-3 block h-2 w-14 ${align}`} style={{ background: theme.primaryColor }} />;
    case "slash":
      return <span aria-hidden="true" className={`mb-1 block font-mono text-xs ${centered ? "text-center" : ""}`} style={{ color: theme.primaryColor }}>{"//"}</span>;
    case "pill":
      return <span aria-hidden="true" className={`mb-3 block h-1.5 w-10 rounded-full ${align}`} style={{ background: theme.primaryColor }} />;
    default:
      return null;
  }
}

function Marquee({ items, skin, color }: { items: Array<{ label: string; href: string | null }>; skin: StoreSkin; color: string }) {
  // Repeat short lists so one copy is wider than the screen; the second copy
  // only exists for the seamless loop (hidden from assistive tech, and from
  // everyone with reduced motion).
  const copies = Math.max(1, Math.ceil(8 / items.length));
  const row = Array.from({ length: copies }, () => items).flat();
  const entry = (item: { label: string; href: string | null }, key: string, decorative: boolean) => (
    // Spacing is inside each item, so the two halves are exactly equal (seamless -50% loop).
    <li key={key} className={`flex shrink-0 items-center gap-10 pr-10 ${decorative ? "sf-marquee-copy" : ""}`} aria-hidden={decorative || undefined}>
      {item.href ? (
        <a href={item.href} tabIndex={decorative ? -1 : undefined} className={`rounded hover:underline ${skin.focus}`}>{item.label}</a>
      ) : (
        <span>{item.label}</span>
      )}
      <span aria-hidden="true">✦</span>
    </li>
  );
  return (
    <div className="sf-marquee-wrap overflow-hidden border-b-2 border-neutral-950 py-3 sm:py-4" style={{ background: color, color: readableOn(color) }}>
      <ul aria-label="Shop" className="sf-marquee flex w-max font-display text-lg font-black uppercase tracking-tight sm:text-2xl">
        {items.map((item, i) => entry(item, `a-${i}`, false))}
        {row.slice(items.length).map((item, i) => entry(item, `b-${i}`, true))}
        {row.map((item, i) => entry(item, `c-${i}`, true))}
      </ul>
    </div>
  );
}

function Promotions({
  promotions,
  skin,
  view,
  centered,
  primaryButton,
}: {
  promotions: CommerceData["promotions"];
  skin: StoreSkin;
  view: StorefrontView;
  centered: boolean;
  primaryButton: React.CSSProperties;
}) {
  const { theme } = view;
  const count = promotions.length;
  const layout = skin.layout.promo;
  type Promo = CommerceData["promotions"][number];
  const key = (promo: Promo, index: number) => `${promo.title}-${index}`;
  const cols = count === 1 ? "" : count === 2 ? "md:grid-cols-2" : "md:grid-cols-3";

  const cta = (promo: Promo, onImage = false) =>
    promo.cta ? (
      <a
        href={promo.cta.href}
        className={`mt-6 inline-flex w-fit items-center px-6 py-3 text-sm font-semibold transition motion-safe:hover:-translate-y-0.5 ${skin.button} ${skin.focus}`}
        style={onImage ? { background: "#ffffff", color: "#111827" } : primaryButton}
      >
        {promo.cta.label}
      </a>
    ) : null;

  const image = (promo: Promo, className = "h-full w-full object-cover") =>
    promo.imageUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={promo.imageUrl} alt={promo.imageAlt} loading="lazy" decoding="async" className={className} />
    ) : null;

  switch (layout) {
    case "overlay":
      return (
        <div className={`grid gap-4 sm:gap-5 ${cols}`}>
          {promotions.map((promo, index) =>
            promo.imageUrl ? (
              <div key={key(promo, index)} data-reveal="" className={`group relative isolate flex overflow-hidden ${count === 1 ? "min-h-[24rem] sm:min-h-[30rem]" : "min-h-[22rem]"} ${skin.categoryCard}`}>
                {image(promo, "absolute inset-0 -z-10 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-1000 motion-safe:group-hover:scale-105")}
                <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
                <div className={`mt-auto w-full p-6 text-white sm:p-10 ${centered ? "text-center" : ""}`}>
                  {promo.eyebrow && <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-white/85">{promo.eyebrow}</p>}
                  <h3 className={`mt-2 text-2xl sm:text-4xl ${skin.heroHeading}`}>{promo.title}</h3>
                  {promo.text && <p className="mt-2 max-w-xl text-white/90">{promo.text}</p>}
                  <div className={centered ? "flex justify-center" : ""}>{cta(promo, true)}</div>
                </div>
              </div>
            ) : (
              <div key={key(promo, index)} data-reveal="" className={`flex flex-col justify-center p-6 sm:p-10 ${skin.promo} ${centered ? "items-center text-center" : ""}`}>
                {promo.eyebrow && <p className={skin.eyebrow}>{promo.eyebrow}</p>}
                <h3 className={`mt-2 text-2xl sm:text-4xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-2 ${skin.promoMuted}`}>{promo.text}</p>}
                {cta(promo)}
              </div>
            ),
          )}
        </div>
      );

    case "strip":
      // Compact banners that do not push the products down the page.
      return (
        <div className={`grid gap-3 ${count >= 2 ? "md:grid-cols-2" : ""}`}>
          {promotions.map((promo, index) => (
            <div key={key(promo, index)} data-reveal="" className={`flex items-center gap-4 overflow-hidden p-3 sm:p-4 ${skin.promo}`} style={{ background: `${index % 2 === 0 ? theme.primaryColor : theme.accentColor}14` }}>
              {promo.imageUrl && <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg sm:h-24 sm:w-32">{image(promo)}</div>}
              <div className="min-w-0 flex-1">
                {promo.eyebrow && <p className={skin.eyebrow} style={{ color: brandTextColor(theme.primaryColor, skin.dark) }}>{promo.eyebrow}</p>}
                <h3 className={`text-lg leading-tight sm:text-xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-1 line-clamp-2 text-sm ${skin.promoMuted}`}>{promo.text}</p>}
              </div>
              {promo.cta && (
                <a href={promo.cta.href} className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm font-bold sm:px-4 ${skin.button} ${skin.focus}`} style={primaryButton}>
                  {promo.cta.label}
                </a>
              )}
            </div>
          ))}
        </div>
      );

    case "band":
      return (
        <div className={`grid gap-4 sm:gap-5 ${count >= 2 ? "md:grid-cols-2" : ""}`}>
          {promotions.map((promo, index) => (
            <div key={key(promo, index)} data-reveal="" className={`flex flex-col items-center gap-6 p-6 sm:flex-row sm:p-8 ${skin.promo} ${centered ? "text-center sm:text-left" : ""}`}>
              {promo.imageUrl && <div className="aspect-square w-36 shrink-0 overflow-hidden rounded-full border-4 border-[#f8f1e6]/20 sm:w-40">{image(promo)}</div>}
              <div className="flex flex-1 flex-col">
                {promo.eyebrow && <p className="text-xs font-medium uppercase tracking-[0.35em] text-[#f3c9a5]">{promo.eyebrow}</p>}
                <h3 className={`mt-1 text-2xl sm:text-3xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-2 ${skin.promoMuted}`}>{promo.text}</p>}
                {cta(promo)}
              </div>
            </div>
          ))}
        </div>
      );

    case "caption":
      // A picture and a plain caption under it, on the page itself.
      return (
        <div className={`grid gap-x-8 gap-y-12 ${cols}`}>
          {promotions.map((promo, index) => (
            <figure key={key(promo, index)} data-reveal="" className={centered ? "text-center" : ""}>
              {promo.imageUrl && <div className={`overflow-hidden bg-neutral-100 ${count === 1 ? "aspect-[21/9]" : "aspect-[4/3]"}`}>{image(promo)}</div>}
              <figcaption className={`grid gap-3 ${promo.imageUrl ? "mt-4" : ""} ${count === 1 ? "lg:grid-cols-12" : ""}`}>
                <div className={count === 1 ? "lg:col-span-4" : ""}>
                  {promo.eyebrow && <p className={skin.eyebrow}>{promo.eyebrow}</p>}
                  <h3 className={`mt-1 text-2xl ${skin.heroHeading}`}>{promo.title}</h3>
                </div>
                <div className={count === 1 ? "lg:col-span-8" : ""}>
                  {promo.text && <p className={`text-sm leading-6 ${skin.promoMuted}`}>{promo.text}</p>}
                  {promo.cta && (
                    <a href={promo.cta.href} className={`mt-3 inline-block rounded text-sm font-medium underline underline-offset-4 ${skin.focus}`}>{promo.cta.label}</a>
                  )}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      );

    case "poster":
      return (
        <div className={`grid gap-5 ${count >= 2 ? "lg:grid-cols-2" : ""}`}>
          {promotions.map((promo, index) => {
            const bg = index % 2 === 0 ? theme.primaryColor : "#0a0a0a";
            const text = readableOn(bg);
            return (
              <div key={key(promo, index)} data-reveal="" className="grid overflow-hidden border-2 border-neutral-950 sm:grid-cols-[3fr_2fr]" style={{ background: bg, color: text }}>
                <div className="flex flex-col p-6 sm:p-8">
                  {promo.eyebrow && <p className="text-xs font-black uppercase tracking-[0.2em] opacity-85">{promo.eyebrow}</p>}
                  <h3 className="mt-2 break-words font-display text-3xl font-black uppercase leading-[0.95] tracking-tight sm:text-5xl">{promo.title}</h3>
                  {promo.text && <p className="mt-3 text-sm font-medium leading-6 opacity-90">{promo.text}</p>}
                  {promo.cta && (
                    <a href={promo.cta.href} className={`mt-6 inline-flex w-fit items-center border-2 border-current px-5 py-2.5 text-sm font-black uppercase tracking-wide ${skin.focus}`}>{promo.cta.label}</a>
                  )}
                </div>
                {promo.imageUrl && <div className="aspect-[16/10] overflow-hidden border-t-2 border-neutral-950 sm:aspect-auto sm:border-l-2 sm:border-t-0">{image(promo)}</div>}
              </div>
            );
          })}
        </div>
      );

    case "bleed":
      // The full width of the screen, one picture after another.
      return (
        <div className="space-y-1">
          {promotions.map((promo, index) =>
            promo.imageUrl ? (
              <div key={key(promo, index)} data-reveal="" className="relative isolate flex min-h-[30rem] items-end justify-center overflow-hidden sm:min-h-[40rem]">
                {image(promo, "absolute inset-0 -z-10 h-full w-full object-cover")}
                <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
                <div className="max-w-2xl px-6 pb-12 text-center text-white sm:pb-20">
                  {promo.eyebrow && <p className="text-[11px] uppercase tracking-[0.3em] text-white/85">{promo.eyebrow}</p>}
                  <h3 className={`mt-3 text-4xl sm:text-6xl ${skin.heroHeading}`}>{promo.title}</h3>
                  {promo.text && <p className="mt-3 text-white/90">{promo.text}</p>}
                  {promo.cta && (
                    <a href={promo.cta.href} className={`mt-7 inline-flex items-center border border-current px-7 py-3 text-[11px] uppercase tracking-[0.28em] transition-colors hover:bg-white hover:text-[#141414] ${skin.focus}`}>{promo.cta.label}</a>
                  )}
                </div>
              </div>
            ) : (
              <div key={key(promo, index)} data-reveal="" className={`px-6 py-16 text-center sm:py-24 ${skin.promo}`}>
                {promo.eyebrow && <p className={skin.eyebrow}>{promo.eyebrow}</p>}
                <h3 className={`mt-3 text-4xl sm:text-6xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mx-auto mt-3 max-w-2xl ${skin.promoMuted}`}>{promo.text}</p>}
                <div className="flex justify-center">{cta(promo)}</div>
              </div>
            ),
          )}
        </div>
      );

    case "feature":
      return (
        <div className={`grid gap-3 ${count >= 2 ? "lg:grid-cols-2" : ""}`}>
          {promotions.map((promo, index) => (
            <div key={key(promo, index)} data-reveal="" className={`relative isolate grid items-center gap-6 overflow-hidden p-5 sm:p-8 ${promo.imageUrl ? "sm:grid-cols-2" : ""} ${skin.promo}`}>
              <div aria-hidden="true" className="sf-grid-lines absolute inset-0 -z-10 [mask-image:linear-gradient(to_right,black,transparent)]" />
              <div aria-hidden="true" className="absolute -left-20 -top-20 -z-10 h-56 w-56 rounded-full opacity-25 blur-3xl" style={{ background: theme.accentColor }} />
              <div>
                {promo.eyebrow && <p className="font-mono text-xs" style={{ color: brandTextColor(theme.primaryColor, skin.dark) ?? theme.accentColor }}><span aria-hidden="true">{"// "}</span>{promo.eyebrow}</p>}
                <h3 className={`mt-2 text-2xl sm:text-3xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-2 text-sm leading-6 ${skin.promoMuted}`}>{promo.text}</p>}
                {cta(promo)}
              </div>
              {promo.imageUrl && <div className="aspect-[4/3] overflow-hidden rounded-xl ring-1 ring-white/10">{image(promo)}</div>}
            </div>
          ))}
        </div>
      );

    case "tiles":
      return (
        <div className={`grid gap-3 sm:gap-4 ${cols}`}>
          {promotions.map((promo, index) => (
            <div key={key(promo, index)} data-reveal="" className={`flex overflow-hidden ${skin.promo}`} style={{ background: `${index % 2 === 0 ? theme.primaryColor : theme.accentColor}1f` }}>
              <div className={`flex flex-1 flex-col justify-center p-5 sm:p-7 ${centered ? "items-center text-center" : ""}`}>
                {promo.eyebrow && <p className={skin.eyebrow}>{promo.eyebrow}</p>}
                <h3 className={`mt-1 text-xl sm:text-2xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-2 text-sm ${skin.promoMuted}`}>{promo.text}</p>}
                {cta(promo)}
              </div>
              {promo.imageUrl && <div className="w-2/5 shrink-0 overflow-hidden">{image(promo)}</div>}
            </div>
          ))}
        </div>
      );

    case "inset":
    default:
      // A large picture with a caption card set into its corner.
      return (
        <div className="space-y-14 sm:space-y-20">
          {promotions.map((promo, index) => (
            <div key={key(promo, index)} data-reveal="" className="relative">
              {promo.imageUrl && <div className="aspect-[4/3] overflow-hidden bg-[#e6e0d6] lg:aspect-[21/9]">{image(promo)}</div>}
              <div className={`bg-[#f4f1ec] ${promo.imageUrl ? `relative mx-3 -mt-16 p-6 shadow-[0_30px_60px_-40px_rgba(42,38,33,0.6)] sm:mx-10 sm:p-10 lg:absolute lg:bottom-10 lg:mx-0 lg:mt-0 lg:max-w-lg ${index % 2 === 0 ? "lg:left-10" : "lg:right-10"}` : "p-6 sm:p-10"}`}>
                {promo.eyebrow && <p className={skin.eyebrow}>{promo.eyebrow}</p>}
                <h3 className={`mt-2 text-3xl sm:text-4xl ${skin.heroHeading}`}>{promo.title}</h3>
                {promo.text && <p className={`mt-3 ${skin.promoMuted}`}>{promo.text}</p>}
                {cta(promo)}
              </div>
            </div>
          ))}
        </div>
      );
  }
}

function BenefitIcon({ benefit }: { benefit: CommerceBenefit }) {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (benefit.key) {
    case "shipping":
      return <svg {...common}><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="1.8" /><circle cx="17" cy="18" r="1.8" /></svg>;
    case "returns":
      return <svg {...common}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>;
    case "secure":
      return <svg {...common}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case "cod":
      return <svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></svg>;
    case "support":
      return <svg {...common}><path d="M4 13a8 8 0 0 1 16 0v4a2 2 0 0 1-2 2h-1v-6h3M4 13v4a2 2 0 0 0 2 2h1v-6H4" /></svg>;
    default:
      return <svg {...common}><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
  }
}
