import React from "react";
import type { StorefrontProduct, StorefrontTheme } from "@/lib/storefront";
import { formatPrice } from "@/lib/format";
import { discountPercent } from "@/lib/storefront-home";
import { readableOn, type StoreSkin } from "./skins";
import QuickAddButton from "./QuickAddButton";
import RatingStars from "./RatingStars";

const LINK_ACTION = "!px-0 text-left underline decoration-1 underline-offset-4";

/**
 * Product card: image (or a styled initial tile when there is none), name,
 * price, real compare-at price and discount, availability from real stock,
 * an add-to-cart button and a link to the product page. Every theme shows the
 * same facts; `skin.layout.card` arranges them:
 * lift (Aurora), menu (Bistro), bold (Launch), retail (Market), plain
 * (Studio), couture (Atelier), tech (Volt), fresh (Harvest), gallery (Forma).
 */
export default function ProductCard({
  product,
  href,
  skin,
  theme,
  businessId,
  preview,
  flush = false,
}: {
  product: StorefrontProduct;
  href: string;
  skin: StoreSkin;
  theme: StorefrontTheme;
  businessId: string;
  preview?: boolean;
  /** Set inside a shared surface (a menu board, joined cells): no frame of its own. */
  flush?: boolean;
}) {
  const variant = skin.layout.card;
  const discount = discountPercent(product);
  const outOfStock = product.availability === "out_of_stock";
  const lowStock = product.availability === "low_stock";
  // Variant products show their price range and are chosen on the product page.
  const range = product.variants && product.variants.length > 0
    ? { min: Math.min(...product.variants.map((v) => v.price)), max: Math.max(...product.variants.map((v) => v.price)) }
    : null;
  const primary = { background: theme.primaryColor, color: readableOn(theme.primaryColor) };
  const accent = { background: theme.accentColor, color: readableOn(theme.accentColor) };
  const rollover = variant === "lift" || variant === "couture" || variant === "plain" || variant === "gallery";

  const priceText = range && range.min !== range.max ? `From ${formatPrice(range.min, product.currency)}` : formatPrice(range ? range.min : product.price, product.currency);
  const compare = discount !== null && !range ? (
    <span className={`text-sm line-through ${skin.subtle}`}>
      <span className="sr-only">Original price </span>
      {formatPrice(product.compareAtPrice as number, product.currency)}
    </span>
  ) : null;

  const discountBadge = (className: string, style?: React.CSSProperties) =>
    discount !== null ? <span className={`px-2 py-0.5 text-xs font-bold ${skin.badge} ${className}`} style={style}>−{discount}%</span> : null;
  const soldOutBadge = (className: string) =>
    outOfStock ? <span className={`px-2 py-0.5 text-xs font-semibold ${skin.badge} ${className}`}>Sold out</span> : null;

  const stockNote = (className = "") => (
    <>
      {lowStock && <p className={`mt-1 text-xs font-medium ${skin.muted} ${className}`}>Only a few left</p>}
      {outOfStock && <p className={`mt-1 text-xs font-medium ${skin.muted} ${className}`}>Out of stock</p>}
    </>
  );

  const rating = product.rating ? <RatingStars average={product.rating.average} count={product.rating.count} className="mt-1" /> : null;

  const name = (className = "") => (
    <h3 className={`text-sm sm:text-base ${skin.productName} ${className}`}>
      <a href={href} className={`rounded ${skin.focus}`}>{product.name}</a>
    </h3>
  );

  /** The add-to-cart control; `outline` uses the theme's quiet button, `link` plain underlined text. */
  const action = (className = "", outline = false, link = false) => (
    <div className={className}>
      {range ? (
        <a
          href={href}
          aria-label={outOfStock ? `${product.name} is sold out` : `Choose options for ${product.name}`}
          className={`block w-full px-3 py-2 text-sm font-semibold transition hover:brightness-110 ${link ? "" : "text-center"} motion-safe:active:scale-[0.98] ${link ? LINK_ACTION : outline ? skin.buttonOutline : skin.button} ${skin.focus} ${outOfStock ? "pointer-events-none opacity-60" : ""}`}
          style={outline || link ? undefined : primary}
        >
          {outOfStock ? "Sold out" : "Choose options"}
        </a>
      ) : (
        <QuickAddButton
          businessId={businessId}
          productId={product.id}
          productName={product.name}
          outOfStock={outOfStock}
          preview={Boolean(preview)}
          className={`${link ? LINK_ACTION : outline ? skin.buttonOutline : skin.button} ${skin.focus}`}
          style={outline || link ? {} : primary}
        />
      )}
    </div>
  );

  /** Image link (hidden from assistive tech: the name is the card's one link). */
  const media = (frame: string, children?: React.ReactNode, imgClass = "") => (
    <a href={href} className={`relative block ${skin.focus}`} tabIndex={-1} aria-hidden="true">
      <div className={`relative overflow-hidden ${frame}`}>
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.imageAlt || product.name}
            loading="lazy"
            decoding="async"
            className={`h-full w-full object-cover motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-out ${imgClass}`}
          />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden" style={{ background: `linear-gradient(135deg, ${theme.primaryColor}26, ${theme.accentColor}3d)` }}>
            <span aria-hidden="true" className="absolute aspect-square w-3/4 rounded-full border border-current opacity-10" />
            <span aria-hidden="true" className="absolute aspect-square w-1/2 rounded-full" style={{ background: `${theme.primaryColor}1f` }} />
            <span className="relative font-display text-5xl opacity-60">{product.name.charAt(0).toUpperCase()}</span>
          </div>
        )}
        {rollover && product.hoverImageUrl && product.imageUrl && (
          // A second real image, shown on hover (pointer devices).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.hoverImageUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-700 group-hover:opacity-100" />
        )}
        {children}
      </div>
    </a>
  );

  const category = (className = "") =>
    product.category ? <p className={`truncate text-xs uppercase tracking-wide ${skin.subtle} ${className}`}>{product.category}</p> : null;

  switch (variant) {
    case "menu":
      return (
        <article className={`group flex h-full gap-4 p-3 sm:p-4 ${flush ? "border-b border-dashed border-[#3b2417]/20" : `transition-shadow hover:shadow-md ${skin.card}`}`} data-card={variant}>
          <div className="w-24 shrink-0 sm:w-28">
            {media(`aspect-square ${skin.cardImage}`, soldOutBadge("absolute inset-x-1 bottom-1 bg-black/75 text-center text-white"), "motion-safe:group-hover:scale-105")}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-baseline gap-2">
              {name("min-w-0 line-clamp-2")}
              <span aria-hidden="true" className="mb-1 hidden min-w-[1.5rem] flex-1 border-b border-dotted border-current opacity-40 sm:block" />
              <p className={`shrink-0 whitespace-nowrap ${skin.price}`}>{priceText}</p>
            </div>
            {(compare || discount !== null) && (
              <p className="mt-0.5 flex items-center gap-2">
                {compare}
                {discountBadge("", accent)}
              </p>
            )}
            {product.description && <p className={`mt-1 line-clamp-2 text-sm leading-6 ${skin.muted}`}>{product.description}</p>}
            {rating}
            {stockNote()}
            {action("mt-auto w-40 pt-3 text-sm")}
          </div>
        </article>
      );

    case "bold":
      return (
        <article
          className={`group flex h-full flex-col ${skin.card} transition-[transform,box-shadow] duration-200 motion-safe:hover:-translate-x-1 motion-safe:hover:-translate-y-1 hover:shadow-[6px_6px_0_0_var(--sf-primary)]`}
          data-card={variant}
        >
          {media(
            `${skin.media} border-b-2 border-neutral-950`,
            <>
              {discountBadge("absolute left-0 top-0 px-2.5 py-1 text-sm", accent)}
              {soldOutBadge("absolute right-0 top-0 bg-neutral-950 px-2.5 py-1 text-white")}
            </>,
            "motion-safe:group-hover:scale-105",
          )}
          <div className="flex flex-1 flex-col p-3 sm:p-4">
            {category("mb-1 font-bold")}
            {name("line-clamp-2")}
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <span className={`text-lg sm:text-xl ${skin.price}`}>{priceText}</span>
              {compare}
            </p>
            {rating}
            {stockNote()}
            {action("mt-auto pt-3")}
          </div>
        </article>
      );

    case "retail":
      return (
        <article className={`group flex h-full flex-col p-2 transition-shadow hover:shadow-lg sm:p-2.5 ${skin.card}`} data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discountBadge("absolute left-1.5 top-1.5", accent)}
              {soldOutBadge("absolute right-1.5 top-1.5 bg-black/75 text-white")}
            </>,
            "motion-safe:group-hover:scale-[1.04]",
          )}
          <div className="flex flex-1 flex-col px-1 pt-3">
            {category("mb-1 text-[11px]")}
            {name("line-clamp-2 leading-snug")}
            {rating}
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
              <span className={skin.price}>{priceText}</span>
              {compare}
            </p>
            {stockNote()}
            {action("mt-auto pt-3")}
          </div>
        </article>
      );

    case "plain":
      return (
        <article className="group flex h-full flex-col" data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discountBadge("absolute left-0 top-0 bg-white text-neutral-900")}
              {soldOutBadge("absolute right-0 top-0 bg-neutral-900 text-white")}
            </>,
          )}
          <div className="flex flex-1 flex-col pt-3">
            <div className="flex items-baseline justify-between gap-3">
              {name("min-w-0 line-clamp-2")}
              <p className={`shrink-0 whitespace-nowrap ${skin.price}`}>{priceText}</p>
            </div>
            {compare && <p className="mt-0.5 text-right">{compare}</p>}
            {category("mt-1 tracking-[0.2em]")}
            {rating}
            {stockNote()}
            {action("mt-auto pt-2", false, true)}
          </div>
        </article>
      );

    case "couture":
      return (
        <article className="group flex h-full flex-col text-center" data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discount !== null && (
                <span className="absolute left-3 top-3 bg-[#faf8f4] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[#141414]">−{discount}%</span>
              )}
              {outOfStock && <span className="absolute right-3 top-3 bg-[#141414] px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-[#faf8f4]">Sold out</span>}
            </>,
            "motion-safe:group-hover:scale-[1.03]",
          )}
          <div className="flex flex-1 flex-col items-center pt-4">
            {name("line-clamp-2")}
            <p className="mt-1.5 flex flex-wrap items-baseline justify-center gap-x-2">
              <span className={skin.price}>{priceText}</span>
              {compare}
            </p>
            {rating}
            {stockNote()}
            {action("mt-auto w-full max-w-[14rem] pt-4", true)}
          </div>
        </article>
      );

    case "tech": {
      const option = product.options?.[0];
      return (
        <article className={`group flex h-full flex-col p-2.5 sm:p-3 ${flush ? "bg-[#11141a] transition-colors duration-300 hover:bg-[#161a22]" : `transition-[border-color,box-shadow] duration-300 hover:border-white/25 hover:shadow-[0_0_0_1px_var(--sf-accent),0_12px_40px_-12px_var(--sf-accent)] ${skin.card}`}`} data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discountBadge("absolute left-2 top-2 font-mono", accent)}
              {soldOutBadge("absolute right-2 top-2 bg-white/90 text-zinc-900")}
            </>,
            "motion-safe:group-hover:scale-105",
          )}
          <div className="flex flex-1 flex-col px-1 pt-3">
            {category("mb-1 font-mono text-[11px] tracking-[0.15em]")}
            {name("line-clamp-2 leading-snug")}
            {option && option.values.length > 0 && (
              // Real option values (e.g. storage sizes): easy to compare at a glance.
              <ul className="mt-2 flex flex-wrap gap-1" aria-label={`${option.name} options`}>
                {option.values.slice(0, 3).map((value) => (
                  <li key={value} className="rounded border border-white/15 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{value}</li>
                ))}
                {option.values.length > 3 && <li className="px-1 py-0.5 font-mono text-[11px] text-zinc-400">+{option.values.length - 3}</li>}
              </ul>
            )}
            {rating}
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <span className={`text-lg ${skin.price}`}>{priceText}</span>
              {compare}
            </p>
            {stockNote()}
            {action("mt-auto pt-3")}
          </div>
        </article>
      );
    }

    case "fresh":
      return (
        <article className={`group flex h-full flex-col p-2 transition-shadow hover:shadow-md sm:p-2.5 ${skin.card}`} data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discountBadge("absolute left-2 top-2", accent)}
              {soldOutBadge("absolute right-2 top-2 bg-[#17261b]/85 text-white")}
            </>,
            "motion-safe:group-hover:scale-105",
          )}
          <div className="flex flex-1 flex-col px-1 pt-2.5">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className={skin.price}>{priceText}</span>
              {compare}
            </p>
            {name("mt-0.5 line-clamp-2 leading-snug")}
            {category("mt-0.5 text-[11px] normal-case tracking-normal")}
            {rating}
            {stockNote()}
            {action("mt-auto pt-2.5")}
          </div>
        </article>
      );

    case "gallery":
      return (
        <article className="group flex h-full flex-col" data-card={variant}>
          {media(
            `${skin.media} ${skin.cardImage}`,
            <>
              {discountBadge("absolute left-3 top-3 bg-[#f4f1ec] text-[#2a2621]")}
              {soldOutBadge("absolute right-3 top-3 bg-[#2a2621] text-[#f4f1ec]")}
            </>,
            "motion-safe:group-hover:scale-[1.03]",
          )}
          <div className="flex flex-1 flex-col pt-5">
            {category("mb-1 text-[11px] tracking-[0.25em]")}
            {name("line-clamp-2")}
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
              <span className={skin.price}>{priceText}</span>
              {compare}
            </p>
            {rating}
            {stockNote()}
            {action("mt-auto w-full max-w-[13rem] pt-4", true)}
          </div>
        </article>
      );

    default:
      // lift (Aurora): the details sit on the image from the tablet width up.
      return (
        <article className="group relative flex h-full flex-col" data-card={variant}>
          <div className="motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out motion-safe:group-hover:-translate-y-1">
            {media(
              `${skin.media} ${skin.cardImage} shadow-[0_20px_50px_-30px_rgba(0,0,0,0.8)]`,
              <>
                {discountBadge("absolute left-3 top-3", accent)}
                {soldOutBadge("absolute right-3 top-3 bg-black/70 text-white backdrop-blur")}
              </>,
              "motion-safe:group-hover:scale-[1.04]",
            )}
          </div>
          <div className="flex flex-1 flex-col px-1 pt-3 sm:absolute sm:inset-x-3 sm:bottom-3 sm:rounded-3xl sm:border sm:border-white/10 sm:bg-[#070a13]/80 sm:p-4 sm:backdrop-blur-md">
            {category("mb-1 text-[11px] tracking-[0.2em]")}
            <div className="flex items-baseline justify-between gap-3">
              {name("min-w-0 line-clamp-2")}
              <p className={`shrink-0 whitespace-nowrap ${skin.price}`}>{priceText}</p>
            </div>
            {compare && <p className="mt-0.5 text-right">{compare}</p>}
            {rating}
            {stockNote()}
            {action("mt-auto pt-3")}
          </div>
        </article>
      );
  }
}
