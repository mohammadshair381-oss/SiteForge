"use client";

import React, { useState, useRef } from "react";
import type { StorefrontView, StorefrontProduct } from "@/lib/storefront";
import {
  editorElementStyleSchema,
  getVisibleSections,
  isSafeSectionHref,
  parseVideoUrl,
  type Section,
} from "@/lib/sections";
import { responsiveCss } from "@/lib/section-responsive";
import StorefrontNav from "@/components/storefront/StorefrontNav";
import ProductCard from "@/components/storefront/commerce/ProductCard";
import RichText from "@/components/storefront/RichText";
import { readableOn, skinFor, storeRootProps, type StoreSkin } from "@/components/storefront/commerce/skins";
import type { StoreDesign } from "@/lib/design-settings";
import { SectionOrnament } from "@/components/storefront/commerce/CommerceHome";

/** FAQ divider colours for themes whose cards are borderless (literal for Tailwind). */
const DIVIDERS: Record<string, string> = {
  studio: "divide-neutral-200",
  atelier: "divide-[#141414]/15",
  forma: "divide-[#2a2621]/15",
};

/** How a page's feature cards are arranged, in the same family as the homepage benefits (literal for Tailwind). */
const FEATURE_LAYOUT: Record<StoreSkin["layout"]["benefits"], { list: string; item: string }> = {
  glass: { list: "grid gap-5 sm:grid-cols-2 lg:grid-cols-3", item: "p-6 rounded-3xl border border-white/10 bg-white/[0.04]" },
  strip: { list: "grid divide-y rounded-xl border border-gray-200 bg-white sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3 lg:divide-x", item: "p-4 sm:p-5" },
  notes: { list: "grid gap-8 text-center sm:grid-cols-2 lg:grid-cols-3", item: "px-4" },
  ruled: { list: "grid gap-8 sm:grid-cols-2 lg:grid-cols-3", item: "border-t border-neutral-900 pt-4" },
  cells: { list: "grid gap-px border-2 border-neutral-950 bg-neutral-950 sm:grid-cols-2 lg:grid-cols-3", item: "bg-white p-5" },
  line: { list: "flex flex-wrap justify-center gap-x-14 gap-y-8 text-center", item: "w-full max-w-xs" },
  spec: { list: "divide-y divide-white/10 overflow-hidden rounded-2xl border border-white/10", item: "grid gap-1 bg-[#11141a] px-5 py-4 sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-center sm:gap-6" },
  bubbles: { list: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3", item: "rounded-3xl bg-[#f1f5ec] p-5" },
  list: { list: "grid gap-x-12 sm:grid-cols-2", item: "border-t border-[#2a2621]/20 py-6" },
};

/** How a page's product section is framed, like the homepage rails (literal for Tailwind). */
const RAIL_LAYOUT: Partial<Record<StoreSkin["layout"]["rail"], { frame?: string; list?: string; item?: string; flush?: boolean }>> = {
  scroller: { list: "sf-scroll-x flex snap-x gap-4 overflow-x-auto pb-4 sm:gap-6", item: "w-[72vw] max-w-[22rem] shrink-0 snap-start sm:w-[22rem]" },
  panel: { frame: "rounded-2xl border border-gray-200 bg-white p-3 sm:p-5" },
  board: { frame: "rounded-[2rem] border-4 border-double border-[#3b2417]/25 bg-[#fffaf2] p-3 sm:p-6 lg:p-10", flush: true },
  cells: { list: "grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-3 lg:grid-cols-4", item: "bg-[#0a0c10]", flush: true },
  shelf: { frame: "rounded-3xl bg-[#f1f5ec] p-2 sm:p-4", list: "sf-scroll-x flex snap-x gap-2.5 overflow-x-auto pb-1 sm:gap-4", item: "w-40 shrink-0 snap-start sm:w-52 lg:w-60" },
  stagger: { item: "lg:[&:nth-child(3n+2)]:mt-20" },
};

function editorTarget(
  editable: boolean | undefined,
  sectionId: string,
  key: string,
  label: string,
  contentPath?: string,
  selectedElementId?: string | null,
) {
  const id = `${sectionId}:${key}`;
  return {
    "data-style-id": id,
    ...(editable
      ? {
          "data-editor-id": id,
          "data-editor-section-id": sectionId,
          "data-editor-label": label,
          tabIndex: 0,
          ...(contentPath ? { "data-editor-content-path": contentPath } : {}),
          "data-editor-selected": selectedElementId === id ? "true" : undefined,
        }
      : {}),
  };
}

function editorStyleRules(sections: Section[]): string {
  const declarations: Record<string, (value: string | number) => string> = {
    color: (value) => `color:${value}`,
    backgroundColor: (value) => `background-color:${value}`,
    fontSize: (value) => `font-size:${value}`,
    fontWeight: (value) => `font-weight:${value}`,
    textAlign: (value) => `text-align:${value}`,
    lineHeight: (value) => `line-height:${value}`,
    letterSpacing: (value) => `letter-spacing:${value}`,
    width: (value) => `width:${value}`,
    maxWidth: (value) => `max-width:${value}`,
    margin: (value) => `margin:${value}`,
    padding: (value) => `padding:${value}`,
    borderColor: (value) => `border-color:${value}`,
    borderWidth: (value) => `border-width:${value}`,
    borderRadius: (value) => `border-radius:${value}`,
    boxShadow: (value) => {
      const shadows: Record<string, string> = {
        none: "none",
        sm: "0 1px 2px rgb(15 23 42 / 0.12)",
        md: "0 4px 12px rgb(15 23 42 / 0.16)",
        lg: "0 12px 28px rgb(15 23 42 / 0.2)",
      };
      return `box-shadow:${shadows[String(value)] ?? "none"}`;
    },
    opacity: (value) => `opacity:${value}`,
    objectFit: (value) => `object-fit:${value}`,
  };
  const rules: string[] = [];
  for (const section of sections) {
    for (const [key, responsive] of Object.entries(section.style?.elementStyles ?? {})) {
      if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/i.test(key)) continue;
      for (const device of ["desktop", "tablet", "mobile"] as const) {
        const validated = editorElementStyleSchema.safeParse(responsive[device]);
        if (!validated.success) continue;
        const declarationsList = Object.entries(validated.data)
          .map(([property, value]) => declarations[property]?.(value))
          .filter((declaration): declaration is string => Boolean(declaration));
        const x = validated.data.offsetX;
        const y = validated.data.offsetY;
        if (x !== undefined || y !== undefined) {
          declarationsList.push(`transform:translate(${x ?? 0}px,${y ?? 0}px)`);
        }
        const css = declarationsList.join(";");
        if (!css) continue;
        const selector = `[data-style-id="${section.id}:${key}"]`;
        const media =
          device === "desktop"
            ? "editor-preview (min-width:1024px)"
            : device === "tablet"
              ? "editor-preview (min-width:640px) and (max-width:1023px)"
              : "editor-preview (max-width:639px)";
        rules.push(`@container ${media}{${selector}{${css}}}`);
      }
    }
  }
  return rules.join("\n");
}

const PADDING: Record<string, string> = {
  none: "py-0",
  sm: "py-8",
  md: "py-16",
  lg: "py-24",
  xl: "py-32",
};

function sectionStyle(section: Section, designTokens?: Record<string, unknown>): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (section.style?.backgroundColor) style.backgroundColor = section.style.backgroundColor;
  if (section.style?.textColor) style.color = section.style.textColor;
  // Apply design token spacing as inline style
  const spacingTokens = (designTokens?.spacing ?? {}) as Record<string, string>;
  const paddingValue = spacingTokens[section.style?.padding ?? "md"];
  if (paddingValue) {
    style.paddingTop = paddingValue;
    style.paddingBottom = paddingValue;
  }
  return style;
}

function sectionPadding(section: Section, designTokens?: Record<string, unknown>): string {
  const spacingTokens = (designTokens?.spacing ?? {}) as Record<string, string>;
  const paddingMap: Record<string, string> = {
    none: "py-0",
    sm: spacingTokens.sm ? `py-[${spacingTokens.sm}]` : "py-8",
    md: spacingTokens.md ? `py-[${spacingTokens.md}]` : "py-16",
    lg: spacingTokens.lg ? `py-[${spacingTokens.lg}]` : "py-24",
    xl: spacingTokens.xl ? `py-[${spacingTokens.xl}]` : "py-32",
  };
  return paddingMap[section.style?.padding ?? "md"] ?? "py-16";
}

interface SectionRendererProps {
  view: StorefrontView;
  productHrefBase: string;
  preview?: boolean;
  showHeader?: boolean;
  /** Inside the commerce homepage: one section among others, never the page's h1. */
  embedded?: boolean;
  /** Inside a store root that already scales the text size: scaling again would multiply it. */
  insideStoreRoot?: boolean;
  selectedSectionId?: string | null;
  selectedElementId?: string | null;
  onSelectSection?: (id: string) => void;
  onSelectElement?: (id: string) => void;
  editable?: boolean;
  draggableSections?: boolean;
  onReorderSections?: (fromId: string, toId: string, position: "before" | "after") => void;
  onCommitElementOffset?: (id: string, x: number, y: number) => void;
  elementOffsetMap?: Record<string, { x: number; y: number }>;
}

export default function SectionRenderer({
  view,
  productHrefBase,
  preview,
  showHeader = true,
  embedded = false,
  insideStoreRoot = false,
  selectedSectionId,
  selectedElementId,
  onSelectSection,
  onSelectElement,
  editable,
  draggableSections,
  onReorderSections,
  onCommitElementOffset,
  elementOffsetMap,
}: SectionRendererProps) {
  const visible = getVisibleSections(view.theme.sections);
  const responsiveRules = responsiveCss(visible.map((section) => ({ id: section.id, responsive: section.style?.responsive })));

  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<"before" | "after" | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const pointerStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const hasDragged = useRef(false);
  const dragOrigin = useRef<{ x: number; y: number; offX: number; offY: number; scale: number } | null>(null);
  const finalOffsets = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!editable) return;
    const target = (e.target as Element).closest("[data-editor-id]");
    if (!target) return;
    const id = target.getAttribute("data-editor-id");
    if (!id || !id.includes(":")) return;
    dragOrigin.current = { x: e.clientX, y: e.clientY, offX: elementOffsetMap?.[id]?.x ?? 0, offY: elementOffsetMap?.[id]?.y ?? 0, scale: 1 };
    pointerStart.current = { id, x: e.clientX, y: e.clientY };
    hasDragged.current = false;
    finalOffsets.current = null;
    if (onSelectElement) onSelectElement(id);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointerStart.current || !dragOrigin.current) return;
    const dx = e.clientX - pointerStart.current.x;
    const dy = e.clientY - pointerStart.current.y;
    if (!hasDragged.current && Math.hypot(dx, dy) > 5) {
      hasDragged.current = true;
      setDraggingId(pointerStart.current.id);
      try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch {}
    }
    if (hasDragged.current && dragOrigin.current) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const el = (e.currentTarget as HTMLElement).ownerDocument.querySelector(`[data-editor-id="${draggingId ?? pointerStart.current.id}"]`) as HTMLElement | null;
      const scale = el && rect.width > 0 ? el.offsetWidth / (el.getBoundingClientRect().width || 1) : 1;
      // use scale from first move
      if (dragOrigin.current.scale === 1 && scale > 0) dragOrigin.current.scale = scale;
      const s = dragOrigin.current.scale || 1;
      const newX = dragOrigin.current.offX + dx / s;
      const newY = dragOrigin.current.offY + dy / s;
      const clampedX = Math.max(-2000, Math.min(2000, newX));
      const clampedY = Math.max(-2000, Math.min(2000, newY));
      finalOffsets.current = { x: clampedX, y: clampedY };
      if (el) {
        el.style.transform = `translate(${clampedX}px, ${clampedY}px)`;
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const wasDrag = hasDragged.current;
    const final = finalOffsets.current;
    if (wasDrag && e.type !== "pointercancel" && final && onCommitElementOffset && pointerStart.current) {
      e.preventDefault();
      e.stopPropagation();
      onCommitElementOffset(pointerStart.current.id, final.x, final.y);
    }
    const el = pointerStart.current ? (e.currentTarget as HTMLElement).ownerDocument.querySelector(`[data-editor-id="${pointerStart.current.id}"]`) as HTMLElement | null : null;
    if (el) el.style.transform = "";
    pointerStart.current = null;
    dragOrigin.current = null;
    finalOffsets.current = null;
    hasDragged.current = false;
    setDraggingId(null);
  };

  const primary = view.theme.primaryColor;
  const accent = view.theme.accentColor;
  const onPrimary = readableOn(primary);

  const designTokens = (view.theme as unknown as Record<string, unknown>)?.designTokens as Record<string, unknown> | undefined;

  // Theme-wide pages: every section is composed by the store's theme (its
  // skin: typography, colours, containers, cards, buttons, image frames,
  // hero composition), so About, Contact, FAQ, policy and custom pages match
  // the homepage, catalog and product pages. Owner "Serif"/"Mono" replace the
  // theme's typography; the default keeps the theme's own display/body fonts.
  const skin = skinFor(view.themeId);
  const layout = skin.layout;
  const rootProps = storeRootProps(skin, view.theme);
  const fontClass = view.theme.font === "serif" ? "font-serif" : view.theme.font === "mono" ? "font-mono" : "font-body";
  // This root paints the theme's page colours, so the owner's page colours must apply here too.
  const pageDesign = (view.theme as { design?: StoreDesign }).design;
  const customPage = `${pageDesign?.backgroundColor ? "sf-custom-bg" : ""} ${pageDesign?.textColor ? "sf-custom-text" : ""}`;

  // Apply font scale from design tokens
  const fontScale = (designTokens?.fontScale as string) || "1";
  const radiusTokens = ((designTokens?.radius ?? {}) as unknown) as Record<string, string>;

  // Without a hero, the first titled section's heading is the page's h1.
  const firstTitledId = embedded || visible.some((s) => s.type === "hero") ? null : visible.find((s) => s.type !== "footer")?.id ?? null;
  // Section headings carry the theme's mark and rule, like the homepage.
  const headingRule = layout.heading === "slab" ? "border-b-2 border-neutral-950 pb-3" : layout.heading === "bar" ? `border-b pb-2.5 ${skin.border}` : "";
  const heading = (section: Section, className: string, attrs: Record<string, unknown>, children: React.ReactNode) => {
    const introducing = className.includes("mb-");
    const classes = introducing ? `${className} ${headingRule}` : className;
    return (
      <>
        {introducing && <SectionOrnament skin={skin} theme={view.theme} centered={className.includes("text-center")} />}
        {section.id === firstTitledId ? <h1 className={classes} {...attrs}>{children}</h1> : <h2 className={classes} {...attrs}>{children}</h2>}
      </>
    );
  };

  const button = `inline-flex items-center justify-center px-6 py-3 text-sm font-semibold transition motion-safe:hover:-translate-y-0.5 ${skin.button} ${skin.focus}`;
  const buttonStyle = { background: primary, color: onPrimary };
  const cardClass = skin.card || `border ${skin.border}`;
  const readable = "mx-auto max-w-3xl";
  // Image frame per theme family (split heroes and about images).
  const frame =
    layout.hero === "statement"
      ? "border-2 border-neutral-950 shadow-[8px_8px_0_0_var(--sf-primary)]"
      : layout.hero === "spotlight"
        ? "rounded-3xl ring-1 ring-white/10 shadow-[0_30px_80px_-30px_var(--sf-accent)]"
        : layout.hero === "arch"
          ? "rounded-t-full"
          : layout.hero === "editorial"
            ? ""
            : layout.hero === "panel" || layout.hero === "banner"
              ? "rounded-2xl"
              : skin.cardImage;
  const centeredHeadings = layout.heading === "flourish" || layout.heading === "caps";

  if (visible.length === 0 && !(preview || editable)) return null;

  return (
    <div
      data-section-renderer
      data-editor-mode={editable ? "true" : undefined}
      className={`${fontClass} ${embedded ? "" : `${skin.page} min-h-screen ${customPage}`} ${draggingId ? "select-none" : ""}`}
      style={{
        ...rootProps.style,
        ...(insideStoreRoot ? { zoom: undefined } : {}),
        fontSize: `${parseFloat(fontScale) * 100}%`,
        containerType: "inline-size",
        containerName: "editor-preview",
      }}
      onPointerDown={editable ? handlePointerDown : undefined}
      onPointerMove={editable ? handlePointerMove : undefined}
      onPointerUp={editable ? handlePointerUp : undefined}
      onPointerCancel={editable ? handlePointerUp : undefined}
    >
      {editable && (
        <style>{`
          [data-editor-mode="true"] [data-editor-id]:hover { outline: 2px dashed #6366f1; outline-offset: 2px; cursor: pointer; }
          [data-editor-mode="true"] [data-editor-selected="true"] { outline: 2px solid #4f46e5; outline-offset: 2px; cursor: grab; }
          [data-editor-mode="true"] [data-editor-id]:focus-visible { outline: 2px solid #4f46e5; outline-offset: 3px; }
        `}</style>
      )}
      {draggingId && (
        <style>{`[data-editor-id="${draggingId}"] { outline: 2px dashed #f59e0b; outline-offset: 2px; cursor: grabbing; }`}</style>
      )}
      {editorStyleRules(visible) && <style>{editorStyleRules(visible)}</style>}
      {responsiveRules && <style>{responsiveRules}</style>}
      {showHeader && (preview || editable) && (
        <header className={`${skin.container} flex items-center justify-between gap-4 py-6`}>
          <div className="flex items-center gap-3">
            {view.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.logoUrl} alt={view.name} className="h-9 w-9 rounded-lg object-cover" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded-lg font-bold" style={buttonStyle}>
                {view.name.charAt(0)}
              </div>
            )}
            {!view.removeBranding && <span className={skin.brand}>{view.name}</span>}
          </div>
          {view.navigation ? (
            <StorefrontNav navigation={view.navigation} variant="header" theme={view.theme} />
          ) : (
            <nav className="hidden gap-6 text-sm opacity-70 sm:flex">
              <span>Products</span>
              <span>About</span>
              <span>Contact</span>
            </nav>
          )}
        </header>
      )}
      {visible.map((section) => {
        const pad = sectionPadding(section, designTokens);
        const style = sectionStyle(section, designTokens);
        const handleSelect = () => {
          if (editable && onSelectSection) onSelectSection(section.id);
        };
        const node = (() => {
          switch (section.type) {
          case "hero": {
            const s = section.settings as {
              headline?: string;
              subheadline?: string;
              ctaText?: string;
              ctaHref?: string;
              imageUrl?: string;
              imageAlt?: string;
            };
            const hasImage = Boolean(s.imageUrl);
            const overlay = hasImage && (layout.hero === "immersive" || layout.hero === "campaign" || layout.hero === "room");
            const centered = !hasImage && (layout.hero === "arch" || layout.hero === "campaign" || layout.hero === "immersive");
            const copy = (onImage: boolean) => (
              <div className={`${centered ? "mx-auto max-w-3xl text-center" : "max-w-2xl"}`} style={onImage ? { color: "#ffffff" } : undefined}>
                <p {...editorTarget(editable, section.id, "category", "Label")} className={`sf-enter ${skin.eyebrow} ${onImage ? "!text-white/85" : ""}`}>
                  {view.category}
                </p>
                <h1 {...editorTarget(editable, section.id, "headline", "Heading", "headline", selectedElementId)} className={`sf-enter mt-3 text-4xl leading-[1.05] sm:text-5xl lg:text-6xl ${skin.heroHeading}`}>
                  {s.headline || view.theme.heroHeadline}
                </h1>
                <p
                  {...editorTarget(editable, section.id, "subheadline", "Paragraph", "subheadline", selectedElementId)}
                  className={`sf-enter mt-5 max-w-xl text-lg leading-8 ${centered ? "mx-auto" : ""} ${onImage ? "text-white/90" : skin.muted}`}
                >
                  {s.subheadline || view.theme.heroSubheadline}
                </p>
                <div className={`sf-enter mt-8 flex gap-3 ${centered ? "justify-center" : ""}`}>
                  <a
                    {...editorTarget(editable, section.id, "cta", "Button", "ctaText", selectedElementId)}
                    href={isSafeSectionHref(s.ctaHref) ? s.ctaHref : "#products"}
                    className={button}
                    style={buttonStyle}
                  >
                    {s.ctaText || "Browse products"}
                  </a>
                </div>
              </div>
            );
            const image = (className: string) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                {...editorTarget(editable, section.id, "image", "Image", "imageUrl", selectedElementId)}
                src={s.imageUrl}
                alt={s.imageAlt || `${view.name} hero image`}
                width={1200}
                height={900}
                loading="eager"
                decoding="async"
                className={className}
              />
            );
            if (overlay) {
              return (
                <section key={section.id} style={style} data-page-hero="overlay" className={`relative isolate overflow-hidden ${pad}`}>
                  <div className="absolute inset-0 -z-10">{image("sf-settle h-full w-full object-cover")}</div>
                  <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/30 to-black/10" />
                  <div className={`${skin.container} flex min-h-[22rem] items-end sm:min-h-[28rem] ${layout.hero === "campaign" ? "justify-center text-center" : ""}`}>{copy(true)}</div>
                </section>
              );
            }
            if (hasImage) {
              return (
                <section key={section.id} style={style} data-page-hero="split" className={pad}>
                  <div className={`${skin.container} grid items-center gap-10 ${layout.hero === "editorial" ? "lg:grid-cols-12" : "lg:grid-cols-2"}`}>
                    <div className={layout.hero === "editorial" ? "lg:col-span-7" : ""}>{copy(false)}</div>
                    <div className={`overflow-hidden ${frame} ${layout.hero === "editorial" ? "lg:col-span-5 lg:mt-16" : ""} ${layout.hero === "arch" ? "mx-auto w-full max-w-md" : ""}`}>
                      {image(`w-full object-cover ${layout.hero === "arch" || layout.hero === "editorial" ? "aspect-[4/5]" : "aspect-[4/3]"}`)}
                    </div>
                  </div>
                </section>
              );
            }
            // Without an image: the theme's own composition of the words.
            switch (layout.hero) {
              case "immersive":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={`relative isolate overflow-hidden ${pad}`}>
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-50 blur-3xl" style={{ background: `radial-gradient(circle at 25% 20%, ${primary}, transparent 50%), radial-gradient(circle at 75% 35%, ${accent}, transparent 55%)` }} />
                    <div className={skin.container}>{copy(false)}</div>
                  </section>
                );
              case "panel":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={`${skin.container} py-4 sm:py-6`}>
                    <div className="rounded-2xl p-7 sm:p-12" style={{ background: `${primary}14` }}>{copy(false)}</div>
                  </section>
                );
              case "banner":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={`${skin.container} py-4 sm:py-6`}>
                    <div className="relative overflow-hidden rounded-3xl p-6 sm:p-10 lg:p-14" style={{ background: `${primary}14` }}>
                      <div aria-hidden="true" className="absolute -bottom-24 -right-16 h-64 w-64 rounded-full opacity-20" style={{ background: accent }} />
                      <div className="relative">{copy(false)}</div>
                    </div>
                  </section>
                );
              case "statement":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={`border-b-2 border-neutral-950 ${pad}`}>
                    <div className={skin.container}>{copy(false)}</div>
                  </section>
                );
              case "spotlight":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={`relative isolate overflow-hidden border-b border-white/10 ${pad}`}>
                    <div aria-hidden="true" className="sf-grid-lines absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
                    <div className={skin.container}>{copy(false)}</div>
                  </section>
                );
              case "editorial":
              case "room":
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={pad}>
                    <div className={skin.container}>
                      <span aria-hidden="true" className={`mb-8 block h-px w-16 bg-current ${skin.subtle}`} />
                      {copy(false)}
                    </div>
                  </section>
                );
              default:
                return (
                  <section key={section.id} style={style} data-page-hero="type" className={pad}>
                    <div className={skin.container}>
                      {layout.hero === "arch" && <p aria-hidden="true" className="mb-2 text-center text-2xl leading-none" style={{ color: primary }}>❦</p>}
                      {copy(false)}
                    </div>
                  </section>
                );
            }
          }
          case "products": {
            const s = section.settings as { title?: string; columns?: string; category?: string; collection?: "all" | "new" | "sale"; limit?: number };
            if (!view.theme.showProducts) return null;
            let list: StorefrontProduct[] = view.products;
            if (s.category) list = list.filter((p) => (p.category ?? "").trim().toLowerCase() === s.category!.trim().toLowerCase());
            if (s.collection === "sale") list = list.filter((p) => typeof p.compareAtPrice === "number" && p.compareAtPrice > p.price);
            if (s.collection === "new") list = [...list].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
            if (s.limit) list = list.slice(0, s.limit);
            // The theme decides product density; "2 columns" asks for wide cards.
            const rail = s.columns === "2" ? {} : RAIL_LAYOUT[layout.rail] ?? {};
            const grid = s.columns === "2" ? "grid gap-6 sm:grid-cols-2" : rail.list ?? skin.grid;
            return (
              <section key={section.id} id="products" style={style} className={pad}>
                <div className={skin.container}>
                  {heading(section, `mb-8 ${skin.heading} ${centeredHeadings ? "text-center" : ""}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Featured products"}</>)}
                  {list.length === 0 ? (
                    <p className={skin.muted}>{view.products.length === 0 ? "No products published yet." : "No products in this collection right now."}</p>
                  ) : (
                    <div className={rail.frame ?? ""}>
                      <ul className={grid}>
                        {list.map((product, i) => (
                          <li key={product.id} data-reveal="" style={{ "--sf-i": i % 4 } as React.CSSProperties} className={rail.item} {...editorTarget(editable, section.id, `product-${product.id}`, "Card", undefined, selectedElementId)}>
                            <ProductCard product={product} href={preview ? "#" : `${productHrefBase}/${product.slug}`} skin={skin} theme={view.theme} businessId={view.id} preview={preview} flush={rail.flush} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </section>
            );
          }
          case "about": {
            const s = section.settings as {
              title?: string;
              body?: string;
              imageUrl?: string;
              imageAlt?: string;
            };
            // Real text only: the section's own body, else the business
            // description. With neither (and no image) the live storefront
            // shows nothing instead of a placeholder; the editor shows a hint.
            const body = s.body || view.about || view.theme.about || "";
            if (!body && !s.imageUrl && !(preview || editable)) return null;
            // A custom title always shows; the default "About <name>" is
            // hidden when the store removes platform branding.
            const title = s.title || (view.removeBranding ? "" : `About ${view.name}`);
            const statement = (layout.story === "statement" || layout.story === "offset" || layout.story === "manifesto" || layout.story === "shout") && !s.imageUrl && body.length < 600;
            const copy = (
              <div className={layout.story === "centered" && !s.imageUrl ? "text-center" : ""}>
                {layout.story === "centered" && !s.imageUrl && <p aria-hidden="true" className="mb-2 text-2xl leading-none text-[#9a4a26]">❦</p>}
                {title && (
                  heading(section, `mb-6 ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{title}</>)
                )}
                {body ? (
                  <div
                    {...editorTarget(editable, section.id, "body", "Paragraph", "body", selectedElementId)}
                    className={`whitespace-pre-line ${statement ? "font-display text-2xl font-light leading-[1.45] tracking-tight sm:text-3xl" : `text-base leading-8 sm:text-lg ${skin.muted}`}`}
                  >
                    {body}
                  </div>
                ) : (
                  <p {...editorTarget(editable, section.id, "body", "Paragraph", "body", selectedElementId)} className="text-sm opacity-60">
                    Add your story in the editor, or a business description in Business settings.
                  </p>
                )}
              </div>
            );
            return (
              <section key={section.id} id="about" style={style} className={pad}>
                <div className={skin.container}>
                  {s.imageUrl ? (
                    <div className="grid items-center gap-10 md:grid-cols-2">
                      {copy}
                      <div className={`overflow-hidden ${frame}`}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          {...editorTarget(editable, section.id, "image", "Image", "imageUrl", selectedElementId)}
                          src={s.imageUrl}
                          alt={s.imageAlt || `${view.name} about image`}
                          width={1200}
                          height={900}
                          loading="lazy"
                          decoding="async"
                          className={`w-full object-cover ${layout.hero === "arch" || layout.hero === "editorial" ? "aspect-[4/5]" : "aspect-[4/3]"}`}
                        />
                      </div>
                    </div>
                  ) : layout.story === "plain" || layout.story === "readme" || layout.story === "note" ? (
                    // Retail and tech themes: readable text on a card surface.
                    <div className={`${readable} p-6 sm:p-10 ${cardClass}`}>{copy}</div>
                  ) : (
                    <div className={readable}>{copy}</div>
                  )}
                </div>
              </section>
            );
          }
          case "features": {
            const s = section.settings as { title?: string; items?: { title: string; description: string }[] };
            const items = s.items ?? [];
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {heading(section, `mb-8 ${centeredHeadings ? "text-center" : ""} ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Features"}</>)}
                  <div className={FEATURE_LAYOUT[layout.benefits].list}>
                    {items.map((item, i) => (
                      <div key={i} data-reveal="" style={{ "--sf-i": i % 3 } as React.CSSProperties} className={FEATURE_LAYOUT[layout.benefits].item}>
                        <h3 {...editorTarget(editable, section.id, `items.${i}.title`, "Card heading", `items.${i}.title`, selectedElementId)} className="font-display text-lg font-semibold">{item.title}</h3>
                        <p {...editorTarget(editable, section.id, `items.${i}.description`, "Card text", `items.${i}.description`, selectedElementId)} className={`mt-2 text-sm leading-6 ${skin.muted}`}>{item.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            );
          }
          case "cta": {
            const s = section.settings as { headline?: string; buttonText?: string; buttonHref?: string };
            const bg = style.backgroundColor ? String(style.backgroundColor) : primary;
            // Panel themes set the call to action in a rounded block; the others run it edge to edge.
            if (layout.rail === "panel" || layout.rail === "shelf" || layout.rail === "cells") {
              return (
                <section key={section.id} style={{ ...style, backgroundColor: undefined, color: undefined }} className="py-4 sm:py-6">
                  <div className={skin.container}>
                    <div className="flex flex-col items-start justify-between gap-5 rounded-3xl p-6 sm:flex-row sm:items-center sm:p-10" style={{ background: bg, color: style.color ?? readableOn(bg) }}>
                      {heading(section, `text-2xl sm:text-3xl ${skin.heroHeading}`, editorTarget(editable, section.id, "headline", "Heading", "headline", selectedElementId), <>{s.headline || "Get started today"}</>)}
                      <a
                        {...editorTarget(editable, section.id, "button", "Button", "buttonText", selectedElementId)}
                        href={isSafeSectionHref(s.buttonHref) ? s.buttonHref : "#contact"}
                        className={`shrink-0 ${button}`}
                        style={{ background: readableOn(bg), color: bg }}
                      >
                        {s.buttonText || "Contact us"}
                      </a>
                    </div>
                  </div>
                </section>
              );
            }
            return (
              <section
                key={section.id}
                style={{ ...style, background: bg, color: style.color ?? readableOn(bg) }}
                className={`${pad} text-center ${layout.hero === "statement" ? "border-y-2 border-neutral-950" : ""}`}
              >
                <div className={`${skin.container} max-w-3xl`}>
                  {heading(section, `text-3xl sm:text-4xl ${skin.heroHeading}`, editorTarget(editable, section.id, "headline", "Heading", "headline", selectedElementId), <>{s.headline || "Get started today"}</>)}
                  <a
                    {...editorTarget(editable, section.id, "button", "Button", "buttonText", selectedElementId)}
                    href={isSafeSectionHref(s.buttonHref) ? s.buttonHref : "#contact"}
                    className={`mt-8 ${button}`}
                    style={{ background: readableOn(bg), color: bg }}
                  >
                    {s.buttonText || "Contact us"}
                  </a>
                </div>
              </section>
            );
          }
          case "footer": {
            const s = section.settings as { text?: string };
            return (
              <footer
                key={section.id}
                id="contact"
                style={style}
                data-footer={layout.footer}
                className={`${pad} border-t text-sm ${skin.footer} ${layout.footer === "postcard" || layout.footer === "couture" ? "text-center" : layout.footer === "sheet" ? "rounded-t-[2.5rem] text-left" : "text-left"}`}
              >
                <div className={`${skin.container} ${layout.footer === "terminal" ? "font-mono" : ""} ${layout.footer === "ledger" || layout.footer === "colophon" ? "grid gap-x-8 gap-y-2 lg:grid-cols-2" : ""}`}>
                  {!view.removeBranding && <p {...editorTarget(editable, section.id, "business-name", "Business name")} className={skin.footerBrand}>{view.name}</p>}
                  {view.address && <p {...editorTarget(editable, section.id, "address", "Address")} className="mt-2">{view.address}</p>}
                  <p className="mt-2">
                    {view.contactEmail && <span>{view.contactEmail}</span>}
                    {view.phone && <span> · {view.phone}</span>}
                  </p>
                  {view.navigation?.footer && view.navigation.footer.length > 0 && (
                    <div className={`mt-4 flex ${layout.footer === "postcard" || layout.footer === "couture" ? "justify-center" : ""}`}>
                      <StorefrontNav navigation={view.navigation} variant="footer" theme={view.theme} />
                    </div>
                  )}
                  {s.text && <p {...editorTarget(editable, section.id, "text", "Footer text", "text", selectedElementId)} className="mt-2">{s.text}</p>}
                </div>
              </footer>
            );
          }
          case "faq": {
            const s = section.settings as { title?: string; items?: Array<{ question: string; answer: string }> };
            const items = s.items ?? [];
            if (items.length === 0 && !preview) return null;
            const divided = !skin.card;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={`${skin.container}`}>
                  <div className={readable}>
                    {heading(section, `mb-8 ${skin.heading} ${centeredHeadings ? "text-center" : ""}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Frequently asked questions"}</>)}
                    {items.length === 0 && (
                      <p className="text-center text-sm opacity-60">Add questions in the editor to show them here.</p>
                    )}
                    <div className={divided ? `divide-y border-y ${skin.border} ${DIVIDERS[skin.id] ?? "divide-neutral-200"}` : "space-y-3"}>
                      {items.map((item, i) => (
                        <details key={i} className={`group ${divided ? "py-5" : `p-5 ${cardClass}`}`}>
                          <summary {...editorTarget(editable, section.id, `items.${i}.question`, "FAQ question", `items.${i}.question`, selectedElementId)} className={`flex cursor-pointer list-none items-center justify-between gap-4 rounded font-display text-lg font-semibold ${skin.focus}`}>
                            {item.question}
                            <span aria-hidden="true" className="shrink-0 text-xl transition-transform group-open:rotate-45">+</span>
                          </summary>
                          <p {...editorTarget(editable, section.id, `items.${i}.answer`, "FAQ answer", `items.${i}.answer`, selectedElementId)} className={`mt-3 whitespace-pre-line leading-7 ${skin.muted}`}>{item.answer}</p>
                        </details>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          }
          case "testimonials": {
            const s = section.settings as { title?: string; items?: Array<{ quote: string; name: string; role?: string; imageUrl?: string; imageAlt?: string }> };
            const items = s.items ?? [];
            if (items.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {heading(section, `mb-8 text-center ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "What our customers say"}</>)}
                  {items.length === 0 && (
                    <p className="text-center text-sm opacity-60">Add customer quotes in the editor to show them here.</p>
                  )}
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((item, i) => (
                      <blockquote {...editorTarget(editable, section.id, `items.${i}.card`, "Testimonial card", undefined, selectedElementId)} key={i} className={`p-6 ${cardClass}`}>
                        <p {...editorTarget(editable, section.id, `items.${i}.quote`, "Quote", `items.${i}.quote`, selectedElementId)} className="font-display text-lg italic leading-relaxed">&ldquo;{item.quote}&rdquo;</p>
                        <footer className="mt-4 flex items-center gap-3">
                          {item.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img {...editorTarget(editable, section.id, `items.${i}.image`, "Image", `items.${i}.imageUrl`, selectedElementId)} src={item.imageUrl} alt={item.imageAlt || item.name} width={80} height={80} loading="lazy" decoding="async" className="h-10 w-10 rounded-full object-cover" />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold" style={buttonStyle}>
                              {item.name.charAt(0)}
                            </div>
                          )}
                          <div>
                            <p {...editorTarget(editable, section.id, `items.${i}.name`, "Attribution", `items.${i}.name`, selectedElementId)} className="text-sm font-semibold">{item.name}</p>
                            {item.role && <p {...editorTarget(editable, section.id, `items.${i}.role`, "Attribution detail", `items.${i}.role`, selectedElementId)} className={`text-xs ${skin.subtle}`}>{item.role}</p>}
                          </div>
                        </footer>
                      </blockquote>
                    ))}
                  </div>
                </div>
              </section>
            );
          }
          case "gallery": {
            const s = section.settings as { title?: string; images?: Array<{ url?: string; alt?: string; caption?: string }>; columns?: string };
            const images = (s.images ?? []).filter((img) => img.url);
            const cols = s.columns === "2" ? "sm:grid-cols-2" : s.columns === "4" ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-2 lg:grid-cols-3";
            if (images.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {heading(section, `mb-8 ${skin.heading} ${centeredHeadings ? "text-center" : ""}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Gallery"}</>)}
                  {images.length === 0 ? (
                    <p className="text-center text-sm opacity-60">Add images in the editor to show them here.</p>
                  ) : (
                    <div className={`grid gap-4 ${cols}`}>
                      {images.map((img, i) => (
                        <figure {...editorTarget(editable, section.id, `images.${i}.figure`, "Image card", undefined, selectedElementId)} key={i} style={radiusTokens.lg ? { borderRadius: radiusTokens.lg } : undefined} className="overflow-hidden">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img {...editorTarget(editable, section.id, `images.${i}.image`, "Image", `images.${i}.url`, selectedElementId)} src={img.url} alt={img.alt ?? ""} width={1200} height={1200} loading="lazy" decoding="async" className={`w-full object-cover ${skin.media} ${skin.cardImage}`} />
                          {img.caption && <figcaption {...editorTarget(editable, section.id, `images.${i}.caption`, "Image caption", `images.${i}.caption`, selectedElementId)} className={`mt-2 text-xs ${skin.subtle}`}>{img.caption}</figcaption>}
                        </figure>
                      ))}
                    </div>
                  )}
                </div>
              </section>
            );
          }
          case "pricing": {
            const s = section.settings as { title?: string; plans?: Array<{ title: string; price: string; period?: string; features?: string[]; ctaText?: string; ctaHref?: string; highlighted?: boolean }> };
            const plans = s.plans ?? [];
            if (plans.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {heading(section, `mb-8 text-center ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Pricing"}</>)}
                  {plans.length === 0 && (
                    <p className="text-center text-sm opacity-60">Add pricing plans in the editor to show them here.</p>
                  )}
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {plans.map((plan, i) => (
                      <div {...editorTarget(editable, section.id, `plans.${i}.card`, "Pricing card", undefined, selectedElementId)} key={i} className={`p-6 ${cardClass}`} style={plan.highlighted ? { boxShadow: `0 0 0 2px ${primary}` } : undefined}>
                        <h3 {...editorTarget(editable, section.id, `plans.${i}.title`, "Card heading", `plans.${i}.title`, selectedElementId)} className="font-display text-lg font-bold">{plan.title}</h3>
                        <p {...editorTarget(editable, section.id, `plans.${i}.price`, "Price", `plans.${i}.price`, selectedElementId)} className={`mt-2 text-3xl ${skin.price}`}>
                          {plan.price}
                          {plan.period && <span className={`text-sm font-normal ${skin.subtle}`}>{plan.period}</span>}
                        </p>
                        <ul className="mt-4 space-y-2 text-sm">
                          {(plan.features ?? []).map((f, j) => (
                            <li key={j} className="flex items-start gap-2">
                              <span style={{ color: skin.dark ? accent : primary }} aria-hidden="true">✓</span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                        {plan.ctaText && isSafeSectionHref(plan.ctaHref) && (
                          <a
                            {...editorTarget(editable, section.id, `plans.${i}.cta`, "Button", `plans.${i}.ctaText`, selectedElementId)}
                            href={plan.ctaHref}
                            className={`mt-6 w-full ${button}`}
                            style={buttonStyle}
                          >
                            {plan.ctaText}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            );
          }
          case "contact": {
            const s = section.settings as { title?: string; description?: string; email?: string; phone?: string; address?: string; ctaText?: string; ctaHref?: string };
            const items = [
              s.email ? { key: "email", label: "Email", value: s.email, href: `mailto:${s.email}` } : null,
              s.phone ? { key: "phone", label: "Phone", value: s.phone, href: `tel:${s.phone.replace(/[^\d+]/g, "")}` } : null,
              s.address ? { key: "address", label: "Address", value: s.address, href: null } : null,
            ].filter((item): item is { key: string; label: string; value: string; href: string | null } => item !== null);
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  <div className={`${readable} ${centeredHeadings ? "text-center" : ""}`}>
                    {heading(section, `mb-4 ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title || "Contact us"}</>)}
                    {s.description && <p {...editorTarget(editable, section.id, "description", "Paragraph", "description", selectedElementId)} className={`mb-8 leading-7 ${skin.muted}`}>{s.description}</p>}
                  </div>
                  {items.length > 0 && (
                    <address className={`mx-auto grid max-w-4xl gap-4 not-italic ${items.length >= 3 ? "sm:grid-cols-3" : items.length === 2 ? "sm:grid-cols-2" : ""}`}>
                      {items.map((item) => (
                        <div key={item.key} className={`p-5 ${skin.benefit}`}>
                          <p className={skin.eyebrow}>{item.label}</p>
                          {item.href ? (
                            <a href={item.href} className={`mt-2 block break-words font-display text-lg font-semibold underline-offset-4 hover:underline ${skin.focus}`}>{item.value}</a>
                          ) : (
                            <p className="mt-2 font-display text-lg font-semibold">{item.value}</p>
                          )}
                        </div>
                      ))}
                    </address>
                  )}
                  {s.ctaText && isSafeSectionHref(s.ctaHref) && (
                    <div className={`mt-8 ${centeredHeadings || items.length > 0 ? "text-center" : ""}`}>
                      <a
                        {...editorTarget(editable, section.id, "cta", "Button", "ctaText", selectedElementId)}
                        href={s.ctaHref}
                        className={button}
                        style={buttonStyle}
                      >
                        {s.ctaText}
                      </a>
                    </div>
                  )}
                </div>
              </section>
            );
          }
          case "richText": {
            const s = section.settings as { title?: string; body?: string };
            if (!s.title && !s.body && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={`${skin.container} ${readable} ${centeredHeadings ? "text-center" : ""}`}>
                  {s.title && heading(section, `mb-6 ${centeredHeadings ? "text-center" : ""} ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {s.body ? (
                    <div {...editorTarget(editable, section.id, "body", "Text", "body", selectedElementId)} className={`text-base leading-8 sm:text-lg ${skin.muted}`}>
                      <RichText body={s.body} headingClass="font-display text-xl font-semibold sm:text-2xl" />
                    </div>
                  ) : (
                    <p className="text-sm opacity-60">Add your text in the editor.</p>
                  )}
                </div>
              </section>
            );
          }
          case "imageText": {
            const s = section.settings as { title?: string; body?: string; imageUrl?: string; imageAlt?: string; imageSide?: "left" | "right"; ctaText?: string; ctaHref?: string };
            if (!s.title && !s.body && !s.imageUrl && !preview) return null;
            const centeredAlone = !s.imageUrl && !preview && centeredHeadings;
            const words = (
              <div className={centeredAlone ? "text-center" : ""}>
                {s.title && heading(section, `mb-5 ${centeredAlone ? "text-center" : ""} ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                {s.body && (
                  <div {...editorTarget(editable, section.id, "body", "Text", "body", selectedElementId)} className={`text-base leading-8 ${skin.muted}`}>
                    <RichText body={s.body} headingClass="font-display text-xl font-semibold" />
                  </div>
                )}
                {s.ctaText && isSafeSectionHref(s.ctaHref) && (
                  <a {...editorTarget(editable, section.id, "cta", "Button", "ctaText", selectedElementId)} href={s.ctaHref} className={`mt-7 ${button}`} style={buttonStyle}>{s.ctaText}</a>
                )}
              </div>
            );
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={s.imageUrl || preview ? skin.container : `${skin.container} ${readable}`}>
                  {s.imageUrl || preview ? (
                    <div className={`grid items-center gap-8 md:grid-cols-2 lg:gap-14 ${layout.rail === "aside" || layout.rail === "stagger" ? "lg:grid-cols-[3fr_2fr]" : ""}`}>
                      <div className={s.imageSide === "left" ? "md:order-2" : ""}>{words}</div>
                      <div className={`overflow-hidden ${frame} ${s.imageSide === "left" ? "md:order-1" : ""}`}>
                        {s.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img {...editorTarget(editable, section.id, "image", "Image", "imageUrl", selectedElementId)} src={s.imageUrl} alt={s.imageAlt || ""} width={1200} height={900} loading="lazy" decoding="async" className={`w-full object-cover ${layout.hero === "arch" || layout.hero === "editorial" ? "aspect-[4/5]" : "aspect-[4/3]"}`} />
                        ) : (
                          <div className="flex aspect-[4/3] items-center justify-center text-sm opacity-60" style={{ background: `${primary}14` }}>Choose an image in the editor</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    words
                  )}
                </div>
              </section>
            );
          }
          case "video": {
            const s = section.settings as { title?: string; url?: string; imageUrl?: string; imageAlt?: string; caption?: string };
            const video = parseVideoUrl(s.url);
            if (!video && !preview) return null;
            const poster = s.imageUrl || video?.poster || "";
            const face = (
              <span className={`group relative block aspect-video overflow-hidden ${frame}`} style={poster ? undefined : { background: `linear-gradient(135deg, ${primary}, ${accent})` }}>
                {poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img {...editorTarget(editable, section.id, "image", "Image", "imageUrl", selectedElementId)} src={poster} alt={s.imageAlt || ""} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                )}
                <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-black/15 transition-colors group-hover:bg-black/30">
                  <span className="flex h-16 w-16 items-center justify-center rounded-full shadow-lg transition-transform motion-safe:group-hover:scale-110" style={buttonStyle}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  </span>
                </span>
              </span>
            );
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={`${skin.container} max-w-4xl ${centeredHeadings ? "text-center" : ""}`}>
                  {s.title && heading(section, `mb-6 ${centeredHeadings ? "text-center" : ""} ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {video ? (
                    <a href={video.watchUrl} target="_blank" rel="noopener noreferrer" className={`block rounded ${skin.focus}`}>
                      <span className="sr-only">Watch {s.title || "the video"} on {video.provider} (opens in a new tab)</span>
                      {face}
                    </a>
                  ) : (
                    <div className="relative">
                      {face}
                      <p className="mt-2 text-center text-sm opacity-60">Paste a YouTube or Vimeo link in the editor.</p>
                    </div>
                  )}
                  {s.caption && <p {...editorTarget(editable, section.id, "caption", "Caption", "caption", selectedElementId)} className={`mt-3 text-sm leading-6 ${skin.muted}`}>{s.caption}</p>}
                </div>
              </section>
            );
          }
          case "logos": {
            const s = section.settings as { title?: string; items?: Array<{ imageUrl?: string; alt?: string; href?: string }> };
            const items = (s.items ?? []).filter((item) => item.imageUrl);
            if (items.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {s.title && heading(section, `mb-8 text-center ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {items.length === 0 && <p className="text-center text-sm opacity-60">Add logos in the editor to show them here.</p>}
                  <ul className="flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
                    {items.map((item, i) => {
                      const logo = (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.imageUrl} alt={item.alt || ""} loading="lazy" decoding="async" className="h-10 w-auto max-w-[9rem] object-contain opacity-80 transition-opacity hover:opacity-100 sm:h-12" />
                      );
                      return <li key={i}>{item.href && isSafeSectionHref(item.href) ? <a href={item.href} className={`block rounded ${skin.focus}`}>{logo}</a> : logo}</li>;
                    })}
                  </ul>
                </div>
              </section>
            );
          }
          case "team": {
            const s = section.settings as { title?: string; items?: Array<{ name: string; role?: string; bio?: string; imageUrl?: string; imageAlt?: string }> };
            const items = s.items ?? [];
            if (items.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {s.title && heading(section, `mb-8 ${skin.heading} ${centeredHeadings ? "text-center" : ""}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {items.length === 0 && <p className="text-sm opacity-60">Add people in the editor to show them here.</p>}
                  <ul className="grid grid-cols-2 gap-x-5 gap-y-10 md:grid-cols-3 lg:grid-cols-4">
                    {items.map((person, i) => (
                      <li key={i} data-reveal="" style={{ "--sf-i": i % 4 } as React.CSSProperties} className={centeredHeadings ? "text-center" : ""}>
                        <div className={`aspect-square overflow-hidden ${layout.hero === "arch" ? "rounded-t-full" : skin.cardImage}`} style={person.imageUrl ? undefined : { background: `${primary}14` }}>
                          {person.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={person.imageUrl} alt={person.imageAlt || person.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                          ) : (
                            <span aria-hidden="true" className="flex h-full items-center justify-center font-display text-4xl opacity-50">{person.name.charAt(0).toUpperCase()}</span>
                          )}
                        </div>
                        <p {...editorTarget(editable, section.id, `items.${i}.name`, "Name", `items.${i}.name`, selectedElementId)} className="mt-3 font-display text-lg font-semibold">{person.name}</p>
                        {person.role && <p {...editorTarget(editable, section.id, `items.${i}.role`, "Role", `items.${i}.role`, selectedElementId)} className={`text-sm ${skin.subtle}`}>{person.role}</p>}
                        {person.bio && <p {...editorTarget(editable, section.id, `items.${i}.bio`, "Bio", `items.${i}.bio`, selectedElementId)} className={`mt-2 text-sm leading-6 ${skin.muted}`}>{person.bio}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          }
          case "steps": {
            const s = section.settings as { title?: string; items?: Array<{ title: string; description?: string }> };
            const items = s.items ?? [];
            if (items.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {s.title && heading(section, `mb-8 ${centeredHeadings ? "text-center" : ""} ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {items.length === 0 && <p className="text-sm opacity-60">Add steps in the editor to show them here.</p>}
                  <ol className={FEATURE_LAYOUT[layout.benefits].list}>
                    {items.map((step, i) => (
                      <li key={i} data-reveal="" style={{ "--sf-i": i % 3 } as React.CSSProperties} className={FEATURE_LAYOUT[layout.benefits].item}>
                        <div>
                          <span aria-hidden="true" className="font-display text-3xl font-semibold leading-none" style={{ color: skin.dark ? accent : primary }}>{String(i + 1).padStart(2, "0")}</span>
                          <h3 {...editorTarget(editable, section.id, `items.${i}.title`, "Step", `items.${i}.title`, selectedElementId)} className="mt-3 font-display text-lg font-semibold">{step.title}</h3>
                        </div>
                        {step.description && <p {...editorTarget(editable, section.id, `items.${i}.description`, "Step text", `items.${i}.description`, selectedElementId)} className={`mt-2 text-sm leading-6 ${skin.muted}`}>{step.description}</p>}
                      </li>
                    ))}
                  </ol>
                </div>
              </section>
            );
          }
          case "spacer": {
            const s = section.settings as { size?: "small" | "medium" | "large"; line?: boolean };
            return (
              <div key={section.id} aria-hidden="true" style={style} className={s.size === "small" ? "py-4" : s.size === "large" ? "py-16 sm:py-24" : "py-8 sm:py-12"}>
                {s.line && <div className={skin.container}><hr className={`border-t ${skin.border}`} /></div>}
              </div>
            );
          }
          case "newsletter": {
            const s = section.settings as { headline?: string; description?: string; buttonText?: string; placeholder?: string; ctaHref?: string };
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={`${skin.container} max-w-2xl text-center`}>
                  {heading(section, `mb-4 ${skin.heading}`, editorTarget(editable, section.id, "headline", "Heading", "headline", selectedElementId), <>{s.headline || "Stay updated"}</>)}
                  {s.description && <p {...editorTarget(editable, section.id, "description", "Paragraph", "description", selectedElementId)} className={`mb-6 ${skin.muted}`}>{s.description}</p>}
                  {isSafeSectionHref(s.ctaHref) ? (
                    <a
                      {...editorTarget(editable, section.id, "button", "Button", "buttonText", selectedElementId)}
                      href={s.ctaHref}
                      className={button}
                      style={buttonStyle}
                    >
                      {s.buttonText || "Subscribe"}
                    </a>
                  ) : preview ? (
                    <p className="text-sm opacity-60">Add a CTA link to preview this action.</p>
                  ) : null}
                </div>
              </section>
            );
          }
          case "stats": {
            const s = section.settings as { title?: string; items?: Array<{ value: string; label: string }> };
            const items = s.items ?? [];
            if (items.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {s.title && heading(section, `mb-8 text-center ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {items.length === 0 && (
                    <p className="text-center text-sm opacity-60">Add highlights in the editor to show them here.</p>
                  )}
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    {items.map((item, i) => (
                      <div key={i} className="text-center">
                        <p {...editorTarget(editable, section.id, `items.${i}.value`, "Statistic", `items.${i}.value`, selectedElementId)} className={`text-4xl ${skin.heroHeading}`} style={{ color: skin.dark ? accent : primary }}>{item.value}</p>
                        <p {...editorTarget(editable, section.id, `items.${i}.label`, "Statistic label", `items.${i}.label`, selectedElementId)} className={`mt-1 text-sm ${skin.subtle}`}>{item.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            );
          }
          case "reviews": {
            const s = section.settings as { title?: string; limit?: number };
            const reviews = (view.reviews ?? []).slice(0, s.limit ?? 6);
            // Never invented: with no approved reviews, visitors see nothing at all.
            if (reviews.length === 0 && !preview) return null;
            return (
              <section key={section.id} style={style} className={pad}>
                <div className={skin.container}>
                  {s.title && heading(section, `mb-8 text-center ${skin.heading}`, editorTarget(editable, section.id, "title", "Heading", "title", selectedElementId), <>{s.title}</>)}
                  {reviews.length === 0 && <p className="text-center text-sm opacity-60">Reviews you approve from real orders appear here. Visitors see nothing until there are some.</p>}
                  <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {reviews.map((review) => (
                      <li key={review.id} className={`${skin.card} p-5`}>
                        <p aria-label={`${review.rating} out of 5 stars`} style={{ color: view.theme.accentColor }}>{"★".repeat(review.rating)}<span aria-hidden="true" className="opacity-30">{"★".repeat(5 - review.rating)}</span></p>
                        {review.title && <p className="mt-2 font-semibold">{review.title}</p>}
                        {review.body && <p className={`mt-1 text-sm leading-6 ${skin.muted}`}>{review.body}</p>}
                        <p className={`mt-3 text-xs ${skin.subtle}`}>{review.authorName}{review.productName ? ` on ${review.productName}` : ""}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          }
          default:
            return null;
        }
        })();
        if (node === null) return null;
        return (
          <div
            key={section.id}
            {...(editable
              ? {
                  "data-editor-id": section.id,
                  "data-editor-section-id": section.id,
                  "data-editor-label": `${section.type} section`,
                  role: "group",
                  "aria-label": `${section.type} section`,
                }
              : {})}
            tabIndex={editable ? 0 : undefined}
            data-editor-selected={editable && selectedElementId === section.id ? "true" : undefined}
            data-section-wrap=""
            data-rs={section.style?.responsive ? section.id : undefined}
            className={`${editable ? "relative" : ""} ${section.hideOn === "mobile" ? "max-md:hidden" : section.hideOn === "desktop" ? "md:hidden" : ""}`.trim() || undefined}
            onClick={editable ? handleSelect : undefined}
            draggable={editable && draggableSections ? true : undefined}
            onDragStart={
              editable && draggableSections
                ? (e) => {
                    const target = (e.target as Element).closest("[data-editor-id]");
                    const id = target?.getAttribute("data-editor-id");
                    if (id && id.includes(":")) {
                      // Element-level: cancel native section drag
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", section.id);
                  }
                : undefined
            }
            onDragOver={
              editable && draggableSections
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const mid = rect.top + rect.height / 2;
                    setDragOverId(section.id);
                    setDragPosition(e.clientY < mid ? "before" : "after");
                  }
                : undefined
            }
            onDragLeave={
              editable && draggableSections
                ? () => {
                    setDragOverId(null);
                    setDragPosition(null);
                  }
                : undefined
            }
            onDrop={
              editable && draggableSections
                ? (e) => {
                    e.preventDefault();
                    const fromId = e.dataTransfer.getData("text/plain");
                    if (fromId && fromId !== section.id && onReorderSections) {
                      onReorderSections(fromId, section.id, dragPosition === "before" ? "before" : "after");
                    }
                    setDragOverId(null);
                    setDragPosition(null);
                  }
                : undefined
            }
            onDragEnd={
              editable && draggableSections
                ? () => {
                    setDragOverId(null);
                    setDragPosition(null);
                  }
                : undefined
            }
          >
            {dragOverId === section.id && dragPosition === "before" && (
              <div className="absolute -top-1 left-0 right-0 h-1 bg-brand-500 rounded" aria-hidden="true" />
            )}
            {node}
            {dragOverId === section.id && dragPosition === "after" && (
              <div className="absolute -bottom-1 left-0 right-0 h-1 bg-brand-500 rounded" aria-hidden="true" />
            )}
            {editable && draggableSections && (
              <div
                className="absolute right-2 top-2 cursor-grab rounded bg-white/80 px-1.5 py-0.5 text-xs text-slate-500 shadow"
                aria-hidden="true"
                title="Drag to reorder"
              >
                ⋮⋮
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}