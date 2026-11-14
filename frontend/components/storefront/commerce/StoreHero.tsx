import React from "react";
import type { StorefrontView } from "@/lib/storefront";
import type { CommerceData } from "@/lib/storefront-home";
import { readableOn, type StoreSkin } from "./skins";

type Hero = NonNullable<CommerceData["hero"]>;

/** The rounding of the theme's buttons, for buttons drawn on images. */
function buttonRadius(skin: StoreSkin): string {
  const match = /rounded-(none|full|lg|xl|md)\b/.exec(skin.button);
  return `sf-btn ${match ? `rounded-${match[1]}` : "rounded-lg"}`;
}

/** Staggered entrance (CSS only; off with reduced motion). */
const enter = (i: number) => ({ className: "sf-enter", style: { "--sf-i": i } as React.CSSProperties });

/**
 * The homepage hero in the theme's composition (`skin.layout.hero`). Every
 * variant shows the same owner content (eyebrow, one h1, description, up to
 * two buttons) and the same media: the owner's hero image (the only eager
 * image on the page), or real product images when there is none, or no media.
 */
export default function StoreHero({ view, commerce, skin }: { view: StorefrontView; commerce: CommerceData; skin: StoreSkin }) {
  const hero = commerce.hero!;
  const { theme } = view;
  const variant = skin.layout.hero;
  const hasImage = Boolean(hero.imageUrl);
  const centered = hero.align === "center";
  const primaryStyle = { background: theme.primaryColor, color: readableOn(theme.primaryColor) };
  const radius = buttonRadius(skin);

  const picture = (imgClass = "") =>
    hasImage ? (
      <picture>
        {hero.mobileImageUrl && hero.mobileImageUrl !== hero.imageUrl && <source media="(max-width: 767px)" srcSet={hero.mobileImageUrl} />}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={hero.imageUrl} alt={hero.imageAlt} fetchPriority="high" decoding="async" className={`h-full w-full object-cover ${imgClass}`} />
      </picture>
    ) : null;

  /**
   * Text block. `tone`: "image" (white text on a photo), "panel" (readable
   * text on the brand-colour panel) or "page" (the theme's own colours).
   */
  const text = (opts: { tone: "image" | "panel" | "page"; size: string; className?: string; center?: boolean; links?: boolean }) => {
    const onImage = opts.tone === "image";
    const panelText = opts.tone === "panel" ? readableOn(theme.primaryColor) : undefined;
    const center = opts.center ?? centered;
    const soft = onImage || panelText ? "opacity-90" : skin.muted;
    return (
      <div className={`${center ? "mx-auto text-center" : ""} ${opts.className ?? "max-w-2xl"}`} style={onImage ? { color: "#ffffff" } : panelText ? { color: panelText } : undefined}>
        {hero.eyebrow && (
          <p {...enter(0)} className={`sf-enter ${skin.eyebrow} ${onImage || panelText ? "!text-current opacity-90" : ""}`}>
            {hero.eyebrow}
          </p>
        )}
        <h1 {...enter(1)} className={`sf-enter mt-3 ${opts.size} ${skin.heroHeading}`}>{hero.headline}</h1>
        {hero.description && (
          <p {...enter(2)} className={`sf-enter mt-5 max-w-xl text-base leading-7 sm:text-lg ${center ? "mx-auto" : ""} ${soft}`}>{hero.description}</p>
        )}
        {(hero.primaryCta || hero.secondaryCta) && (
          <div {...enter(3)} className={`sf-enter mt-8 flex flex-wrap items-center gap-3 ${center ? "justify-center" : ""}`}>
            {hero.primaryCta &&
              (opts.links ? (
                <a href={hero.primaryCta.href} className={`inline-flex items-center border border-current px-7 py-3 text-[11px] uppercase tracking-[0.28em] transition-colors hover:bg-white hover:text-[#141414] ${radius} ${skin.focus}`}>
                  {hero.primaryCta.label}
                </a>
              ) : (
                <a
                  href={hero.primaryCta.href}
                  className={`inline-flex items-center px-6 py-3 text-sm font-semibold shadow-sm transition motion-safe:hover:-translate-y-0.5 ${skin.button} ${skin.focus}`}
                  // On the brand-colour panel a brand-colour button would vanish: invert it.
                  style={panelText ? { background: panelText, color: theme.primaryColor } : primaryStyle}
                >
                  {hero.primaryCta.label}
                </a>
              ))}
            {hero.secondaryCta && (
              <a
                href={hero.secondaryCta.href}
                className={
                  opts.links
                    ? `inline-flex items-center px-2 py-3 text-[11px] uppercase tracking-[0.28em] underline decoration-1 underline-offset-8 ${skin.focus}`
                    : `inline-flex items-center px-6 py-3 text-sm font-semibold ${onImage || panelText ? `${radius} border border-current` : skin.buttonOutline} ${skin.focus}`
                }
              >
                {hero.secondaryCta.label}
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  // A new store without images still gets a composed hero: brand colours and its initial.
  const art = (className: string) => <HeroArt name={view.name} primary={theme.primaryColor} accent={theme.accentColor} className={className} />;

  const overlay = <div className="absolute inset-0 -z-10 bg-black" style={{ opacity: hero.overlay / 100 }} />;
  const collage = (rounded: string, className = "") =>
    hero.collage.length > 0 ? <Collage items={hero.collage} rounded={rounded} className={className} /> : null;

  switch (variant) {
    case "immersive":
      if (hasImage) {
        return (
          <section aria-label="Introduction" data-hero={variant} className="relative isolate -mt-20 overflow-hidden">
            <div className="absolute inset-0 -z-10">{picture("sf-settle")}</div>
            {overlay}
            <div className="absolute inset-0 -z-10 bg-gradient-to-t from-[#070a13] via-[#070a13]/25 to-transparent" />
            <div className={`${skin.container} flex min-h-[38rem] items-end pb-14 pt-36 sm:min-h-[44rem] lg:min-h-[min(92vh,58rem)] lg:pb-24`}>
              <div className="w-full">{text({ tone: "image", size: "text-5xl leading-[1.02] sm:text-6xl lg:text-7xl", className: "max-w-3xl" })}</div>
            </div>
          </section>
        );
      }
      // Centred type in a glow, with the store's real products fanned out below.
      return (
        <section aria-label="Introduction" data-hero={variant} className="relative isolate -mt-20 overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0 -z-10 opacity-50 blur-3xl"
            style={{ background: `radial-gradient(circle at 25% 20%, ${theme.primaryColor}, transparent 50%), radial-gradient(circle at 75% 35%, ${theme.accentColor}, transparent 55%)` }}
          />
          <div className={`${skin.container} pb-16 pt-36 sm:pb-24 sm:pt-44`}>
            {text({ tone: "page", size: "text-5xl leading-[1.02] sm:text-7xl lg:text-8xl", className: "max-w-5xl", center: true })}
            {hero.collage.length > 0 && (
              <ul className="mx-auto mt-14 flex max-w-4xl items-end justify-center">
                {hero.collage.slice(0, 3).map((item, index, all) => (
                  <li
                    key={`${item.src}-${index}`}
                    className={`aspect-[4/5] w-1/3 overflow-hidden rounded-[1.75rem] shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)] ${all.length === 3 && index === 1 ? "z-10 -mb-4 scale-110" : all.length === 3 && index === 0 ? "-rotate-3 translate-x-3" : all.length === 3 ? "translate-x-[-0.75rem] rotate-3" : "mx-2"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.src} alt={item.alt} decoding="async" className="h-full w-full object-cover" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      );

    case "arch": {
      const archSrc = hasImage ? picture() : hero.collage[0] ? <ArchImage src={hero.collage[0].src} alt={hero.collage[0].alt} /> : null;
      const secondArch = hasImage ? hero.collage[0] : hero.collage[1];
      if (archSrc && secondArch && !centered) {
        const frame = "relative aspect-[3/4] overflow-hidden rounded-t-full bg-[#ead9c0] shadow-[0_30px_60px_-30px_rgba(59,36,23,0.6)]";
        return (
          <section aria-label="Introduction" data-hero={variant} className="relative overflow-hidden">
            <div className={`${skin.container} grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1fr_1.6fr_1fr] lg:gap-12`}>
              <div className={`mx-auto hidden w-full max-w-xs lg:block ${frame}`}>{archSrc}</div>
              <div className="text-center">
                <p aria-hidden="true" className="mb-2 text-2xl leading-none text-[#9a4a26]">❦</p>
                {text({ tone: "page", size: "text-4xl leading-[1.08] sm:text-5xl lg:text-6xl", className: "", center: true })}
              </div>
              <div className={`mx-auto w-full max-w-xs ${frame}`}><ArchImage src={secondArch.src} alt={secondArch.alt} /></div>
            </div>
          </section>
        );
      }
      const arch = (
        <div className={`relative mx-auto w-full ${centered ? "max-w-sm" : "max-w-md"}`}>
          <div aria-hidden="true" className="absolute inset-0 translate-x-3 translate-y-3 rounded-t-full border border-current opacity-25" />
          <div className="relative aspect-[4/5] overflow-hidden rounded-t-full bg-[#ead9c0] shadow-[0_30px_60px_-30px_rgba(59,36,23,0.6)]">{archSrc ?? art("h-full w-full")}</div>
        </div>
      );
      return (
        <section aria-label="Introduction" data-hero={variant} className="relative overflow-hidden">
          <div className={`${skin.container} grid items-center gap-12 py-14 sm:py-20 ${arch && !centered ? "lg:grid-cols-[1.1fr_1fr]" : ""}`}>
            <div>
              <p aria-hidden="true" className={`mb-2 text-2xl leading-none ${centered ? "text-center" : ""} text-[#9a4a26]`}>❦</p>
              {text({ tone: "page", size: "text-4xl leading-[1.08] sm:text-5xl lg:text-6xl" })}
            </div>
            {arch}
          </div>
        </section>
      );
    }

    case "statement": {
      const media = hasImage ? picture("motion-safe:transition-transform motion-safe:duration-700 hover:scale-[1.03]") : hero.collage[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={hero.collage[0].src} alt={hero.collage[0].alt} decoding="async" className="h-full w-full object-cover" />
      ) : (
        art("h-full w-full")
      );
      return (
        <section aria-label="Introduction" data-hero={variant} className="relative overflow-hidden border-b-2 border-neutral-950">
          <div className={`${skin.container} grid gap-10 py-10 sm:py-14 lg:grid-cols-12 lg:items-end lg:py-16`}>
            <div className={media ? "lg:col-span-8" : "lg:col-span-12"}>
              {text({ tone: "page", size: "text-[2.75rem] leading-[0.9] sm:text-7xl lg:text-[7.5rem]", className: "", center: false })}
            </div>
            {media && (
              <div className="relative mr-3 sm:mr-5 lg:col-span-4">
                <div aria-hidden="true" className="absolute inset-0 translate-x-3 translate-y-3 sm:translate-x-5 sm:translate-y-5" style={{ background: theme.primaryColor }} />
                <div className="relative aspect-[4/5] overflow-hidden border-2 border-neutral-950 bg-white">{media}</div>
              </div>
            )}
          </div>
        </section>
      );
    }

    case "panel": {
      const shortcuts = commerce.categories.slice(0, 2);
      const main = hasImage ? (
        <div className="relative isolate overflow-hidden rounded-2xl">
          <div className="absolute inset-0 -z-10">{picture()}</div>
          {overlay}
          <div className="flex min-h-[22rem] items-center px-6 py-14 sm:min-h-[26rem] sm:px-12 lg:min-h-[30rem]">
            <div className="w-full">{text({ tone: "image", size: "text-4xl leading-[1.05] sm:text-5xl lg:text-6xl" })}</div>
          </div>
        </div>
      ) : (
        <div className="grid items-center gap-8 overflow-hidden rounded-2xl p-7 sm:p-12 lg:grid-cols-2" style={{ background: `linear-gradient(120deg, ${theme.primaryColor}, ${theme.accentColor})` }}>
          {text({ tone: "panel", size: "text-4xl leading-[1.05] sm:text-5xl lg:text-6xl" })}
          {collage("rounded-xl")}
        </div>
      );
      return (
        <section aria-label="Introduction" data-hero={variant} className={`${skin.container} pt-4 sm:pt-6`}>
          <div className={`grid gap-3 lg:gap-4 ${shortcuts.length === 2 ? "lg:grid-cols-[2fr_1fr]" : ""}`}>
            {main}
            {shortcuts.length === 2 && (
              <ul className="hidden gap-3 lg:grid lg:gap-4" aria-label="Popular categories">
                {shortcuts.map((category) => (
                  <li key={category.href}>
                    <a href={category.href} className={`group relative flex h-full min-h-[8rem] overflow-hidden rounded-2xl ${skin.focus}`}>
                      {category.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={category.imageUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-500 group-hover:scale-105" />
                      ) : (
                        <span aria-hidden="true" className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${theme.accentColor}, ${theme.primaryColor})` }} />
                      )}
                      <span className="relative mt-auto w-full bg-gradient-to-t from-black/75 to-transparent p-5 pt-12 text-white">
                        <span className="block text-xl font-extrabold">{category.name}</span>
                        <span className="text-sm text-white/90">{category.count} {category.count === 1 ? "product" : "products"}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      );
    }

    case "editorial": {
      const media = hasImage ? picture() : hero.collage[0] ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={hero.collage[0].src} alt={hero.collage[0].alt} decoding="async" className="h-full w-full object-cover" />
      ) : (
        art("h-full w-full")
      );
      return (
        <section aria-label="Introduction" data-hero={variant} className={`${skin.container} py-12 sm:py-20`}>
          <div className={`grid gap-10 ${media ? "lg:grid-cols-12 lg:gap-8" : ""}`}>
            <div className={media ? "lg:col-span-7 lg:pt-6" : ""}>
              <span aria-hidden="true" className={`mb-8 block h-px w-16 bg-current ${skin.subtle}`} />
              {text({ tone: "page", size: "text-5xl leading-[0.98] sm:text-6xl lg:text-[5.25rem]", className: "max-w-3xl", center: false })}
            </div>
            {media && <div className="aspect-[4/5] overflow-hidden bg-neutral-100 lg:col-span-5 lg:mt-28">{media}</div>}
          </div>
        </section>
      );
    }

    case "campaign":
      if (hasImage) {
        return (
          <section aria-label="Introduction" data-hero={variant} className="relative isolate overflow-hidden">
            <div className="absolute inset-0 -z-10">{picture("sf-settle")}</div>
            {overlay}
            <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/55 via-transparent to-transparent" />
            <div className={`flex min-h-[36rem] px-5 pb-16 pt-28 sm:min-h-[44rem] sm:px-10 lg:min-h-[min(92vh,58rem)] lg:px-16 lg:pb-24 ${centered ? "items-end justify-center" : "items-end"}`}>
              {text({ tone: "image", size: "text-5xl leading-[1.02] sm:text-7xl lg:text-8xl", className: "max-w-3xl", links: true })}
            </div>
          </section>
        );
      }
      return (
        <section aria-label="Introduction" data-hero={variant} className={`${skin.container} py-16 sm:py-24`}>
          {text({ tone: "page", size: "text-5xl leading-[1.02] sm:text-7xl lg:text-8xl", className: "max-w-4xl", center: true, links: false })}
          {hero.collage.length > 0 && (
            <ul className="mx-auto mt-14 grid max-w-5xl grid-cols-3 gap-3 sm:gap-6">
              {hero.collage.slice(0, 3).map((item, index) => (
                <li key={`${item.src}-${index}`} className={`aspect-[3/4] overflow-hidden bg-[#ece7dd] ${index === 1 ? "sm:-translate-y-8" : ""}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.src} alt={item.alt} decoding="async" className="h-full w-full object-cover" />
                </li>
              ))}
            </ul>
          )}
        </section>
      );

    case "spotlight": {
      const inner = hasImage ? (
        <div className="aspect-[4/3] overflow-hidden">{picture()}</div>
      ) : hero.collage.length > 0 ? (
        <div className="p-3">{collage("rounded-xl")}</div>
      ) : (
        art("aspect-[4/3]")
      );
      const media = (
        <div className="overflow-hidden rounded-2xl border border-white/15 bg-[#11141a] shadow-[0_40px_120px_-40px_var(--sf-accent)]">
          <div aria-hidden="true" className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
            <span className="h-2 w-2 rounded-full" style={{ background: theme.primaryColor }} />
            <span className="h-2 w-2 rounded-full" style={{ background: theme.accentColor }} />
            <span className="h-2 w-2 rounded-full bg-white/25" />
          </div>
          {inner}
        </div>
      );
      const stats = [
        { value: commerce.totalProducts, label: commerce.totalProducts === 1 ? "product" : "products" },
        { value: commerce.categories.length, label: commerce.categories.length === 1 ? "category" : "categories" },
      ].filter((stat) => stat.value > 0);
      return (
        <section aria-label="Introduction" data-hero={variant} className="relative isolate overflow-hidden">
          <div aria-hidden="true" className="sf-grid-lines absolute inset-0 -z-10 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
          <div aria-hidden="true" className="absolute -right-[10%] -top-[30%] -z-10 h-[34rem] w-[34rem] rounded-full opacity-25 blur-3xl" style={{ background: theme.accentColor }} />
          <div className={`${skin.container} grid items-center gap-10 py-12 sm:py-16 lg:py-20 ${!centered ? "lg:grid-cols-[1.1fr_1fr]" : ""}`}>
            {text({ tone: "page", size: "text-4xl leading-[1.05] sm:text-6xl" })}
            {!centered && media}
          </div>
          {stats.length > 0 && (
            <div className="border-t border-white/10">
              <dl className={`${skin.container} flex flex-wrap gap-x-10 gap-y-1 py-3 font-mono text-xs ${skin.subtle}`}>
                {stats.map((stat) => (
                  <div key={stat.label} className="flex gap-2">
                    <dd className="text-white">{stat.value}</dd>
                    <dt>{stat.label}</dt>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>
      );
    }

    case "banner": {
      const media = hasImage ? <div className="aspect-[4/3] overflow-hidden rounded-2xl">{picture()}</div> : collage("rounded-2xl") ?? art("aspect-[4/3] rounded-2xl");
      return (
        <section aria-label="Introduction" data-hero={variant} className={`${skin.container} pt-4 sm:pt-6`}>
          <div className="relative overflow-hidden rounded-3xl" style={{ background: `${theme.primaryColor}14` }}>
            <div aria-hidden="true" className="absolute -bottom-24 -left-16 h-64 w-64 rounded-full opacity-20" style={{ background: theme.accentColor }} />
            <div className={`relative grid items-center gap-8 p-6 sm:p-10 lg:p-14 ${media && !centered ? "lg:grid-cols-2" : ""}`}>
              {text({ tone: "page", size: "text-4xl leading-[1.05] sm:text-5xl lg:text-6xl" })}
              {!centered && media}
            </div>
          </div>
        </section>
      );
    }

    case "room":
    default:
      if (hasImage) {
        return (
          <section aria-label="Introduction" data-hero="room" className={`${skin.container} pt-6 sm:pt-10`}>
            <div className="relative">
              <div className="aspect-[4/5] overflow-hidden bg-[#e6e0d6] sm:aspect-[16/9] lg:aspect-[21/9]">{picture("sf-settle")}</div>
              <div className="relative mx-3 -mt-20 bg-[#f4f1ec] p-6 shadow-[0_30px_60px_-40px_rgba(42,38,33,0.6)] sm:mx-10 sm:p-10 lg:absolute lg:bottom-10 lg:left-10 lg:mx-0 lg:mt-0 lg:max-w-xl">
                {text({ tone: "page", size: "text-4xl leading-[1.05] sm:text-5xl", className: "", center: false })}
              </div>
            </div>
          </section>
        );
      }
      return (
        <section aria-label="Introduction" data-hero="room" className={`${skin.container} pt-6 sm:pt-10`}>
          <div className="relative">
            <div className="aspect-[4/5] overflow-hidden bg-[#e6e0d6] sm:aspect-[16/9] lg:aspect-[21/9]">
              {hero.collage[0] ? <ArchImage src={hero.collage[0].src} alt={hero.collage[0].alt} /> : art("h-full w-full")}
            </div>
            <div className="relative mx-3 -mt-20 bg-[#f4f1ec] p-6 shadow-[0_30px_60px_-40px_rgba(42,38,33,0.6)] sm:mx-10 sm:p-10 lg:absolute lg:bottom-10 lg:left-10 lg:mx-0 lg:mt-0 lg:max-w-xl">
              {text({ tone: "page", size: "text-4xl leading-[1.05] sm:text-5xl", className: "", center: false })}
            </div>
          </div>
        </section>
      );
  }
}

/** Decorative: the store's initial on its brand colours, for a hero with no image yet. */
function HeroArt({ name, primary, accent, className }: { name: string; primary: string; accent: string; className: string }) {
  return (
    <div aria-hidden="true" className={`relative isolate flex items-center justify-center overflow-hidden ${className}`} style={{ background: `linear-gradient(135deg, ${primary}, ${accent})`, color: readableOn(primary) }}>
      <span className="sf-tile-dots absolute inset-0 -z-10" />
      <span className="absolute left-1/2 top-1/2 -z-10 aspect-square w-[85%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-current opacity-20" />
      <span className="absolute left-1/2 top-1/2 -z-10 aspect-square w-[55%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-current opacity-30" />
      <span className="font-display text-[clamp(5rem,14vw,11rem)] leading-none">{name.trim().charAt(0).toUpperCase()}</span>
    </div>
  );
}

function ArchImage({ src, alt }: { src: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} decoding="async" className="h-full w-full object-cover" />;
}

/** Real product images for a hero without its own image. */
export function Collage({ items, rounded, className = "" }: { items: Array<{ src: string; alt: string }>; rounded: string; className?: string }) {
  if (items.length === 1) {
    return (
      <div className={`aspect-[4/3] overflow-hidden ${rounded} ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={items[0].src} alt={items[0].alt} decoding="async" className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className={`grid grid-cols-2 gap-3 ${className}`}>
      {items.slice(0, 3).map((item, index) => (
        <div key={`${item.src}-${index}`} className={`overflow-hidden ${rounded} ${index === 0 ? "row-span-2 aspect-[3/4] h-full" : "aspect-square"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.src} alt={item.alt} decoding="async" className="h-full w-full object-cover" />
        </div>
      ))}
    </div>
  );
}
