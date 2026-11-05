import type React from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { formatPrice } from "@/lib/format";
import AddToCartButton from "@/components/storefront/AddToCartButton";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import ProductCard from "@/components/storefront/commerce/ProductCard";
import VariantPicker from "@/components/storefront/commerce/VariantPicker";
import RatingStars from "@/components/storefront/commerce/RatingStars";
import ProductGallery from "@/components/storefront/commerce/ProductGallery";
import VariantImage from "@/components/storefront/commerce/VariantImage";
import { approvedReviews } from "@/lib/reviews";
import { fewProductsGrid, readableOn, sizeless, skinFor, type StoreSkin } from "@/components/storefront/commerce/skins";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { categoryHref, discountPercent } from "@/lib/storefront-home";
import { readShippingSettings } from "@/lib/checkout-pricing";
import { breadcrumbJsonLd, jsonLdScript, productJsonLd } from "@/lib/structured-data";
import { productCanonicalUrl, storefrontOrigin } from "@/lib/seo";
import { getProductMetadata } from "@/lib/seo";
import type { StorefrontProduct } from "@/lib/storefront";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const headerList = await headers();
  return getProductMetadata(headerList.get("host"), slug);
}

export default async function StorefrontProduct({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const headerList = await headers();
  const host = headerList.get("host");
  const result = await getPublicStorefront(host);
  if (!result) notFound();

  const product = result.products.find((item) => item.slug === slug);
  if (!product) notFound();

  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  const item = view.products.find((p) => p.slug === slug)!;
  const skin = skinFor(view.themeId);
  const shipping = readShippingSettings(result.business.shippingSettings);
  const origin = storefrontOrigin(result.business.subdomain);
  const canonical = productCanonicalUrl(result.business.subdomain, item.slug);
  // Real, approved reviews only (none shown or claimed otherwise).
  const ratingSummary = item.rating ?? null;
  const reviews = ratingSummary ? await approvedReviews(result.business._id, product._id, 10) : [];
  const { primaryColor, accentColor } = view.theme;
  const discount = discountPercent(item);
  const images = [item.imageUrl, ...(Array.isArray(product.images) ? product.images : [])]
    .filter((src): src is string => typeof src === "string" && src.length > 0)
    .filter((src, index, all) => all.indexOf(src) === index)
    .slice(0, 5);
  const layout = skin.layout.productPage;
  const availabilityText = item.availability === "out_of_stock" ? "Out of stock — check back soon" : item.availability === "low_stock" ? "In stock — only a few left" : "In stock";
  const placeholder = (
    <div className="flex h-full w-full items-center justify-center" style={{ background: `linear-gradient(135deg, ${primaryColor}22, ${accentColor}33)` }}>
      <span className="text-7xl font-bold opacity-40" aria-hidden="true">{item.name.charAt(0).toUpperCase()}</span>
    </div>
  );
  const related = view.products
    .filter((p) => p.id !== item.id && item.category && p.category?.toLowerCase() === item.category.toLowerCase())
    .slice(0, 4);

  const shippingNote = shipping.enabled && (shipping.deliveryInfo || shipping.freeOver !== null) ? (
    <p className={`rounded-lg border px-4 py-3 text-sm ${skin.border}`}>
      {shipping.deliveryInfo && <>Delivery: {shipping.deliveryInfo}</>}
      {shipping.freeOver !== null && (
        <span className="block font-medium">Free shipping on orders of {formatPrice(shipping.freeOver, item.currency)} or more.</span>
      )}
    </p>
  ) : null;
  const benefitList = commerce.benefits.length > 0 || commerce.hasPolicies ? (
    <ul className="space-y-3 text-sm">
      {commerce.benefits.map((benefit) => (
        <li key={benefit.key}>
          <span className="font-semibold">{benefit.title}:</span> <span className={skin.muted}>{benefit.text}</span>
        </li>
      ))}
      {commerce.hasPolicies && (
        <li>
          <Link href="/policies" className={`rounded font-semibold underline underline-offset-4 ${skin.focus}`}>Shipping &amp; returns policy</Link>
        </li>
      )}
    </ul>
  ) : null;
  const description = item.description ? <p className={`whitespace-pre-line leading-7 ${skin.muted}`}>{item.description}</p> : null;
  const hasVariants = Boolean(item.variants && item.options && item.options.length > 0);

  // Price, availability and the add-to-cart controls (identical in every layout).
  const purchase = hasVariants ? (
    <div className="mt-6">
      <VariantPicker
        businessId={view.id}
        productId={String(product._id)}
        options={item.options!}
        variants={item.variants!}
        currency={item.currency}
        color={primaryColor}
        priceClass={sizeless(skin.price)}
        mutedClass={skin.muted}
        badgeStyle={{ background: accentColor, color: readableOn(accentColor) }}
        buttonClass={sizeless(skin.button)}
        inputClass={skin.input}
      />
    </div>
  ) : (
    <>
      <p className="mt-4 flex flex-wrap items-baseline gap-3">
        <span className={`text-3xl ${sizeless(skin.price)}`}>{formatPrice(item.price, item.currency)}</span>
        {discount !== null && (
          <>
            <span className={`text-lg line-through ${skin.subtle}`}>
              <span className="sr-only">Original price </span>
              {formatPrice(item.compareAtPrice as number, item.currency)}
            </span>
            <span className={`px-2 py-0.5 text-sm font-bold ${skin.badge}`} style={{ background: accentColor, color: readableOn(accentColor) }}>
              Save {discount}%
            </span>
          </>
        )}
      </p>
      <p className={`mt-2 text-sm font-medium ${skin.muted}`}>{availabilityText}</p>
      <div className="mt-8">
        <AddToCartButton
          businessId={view.id}
          productId={String(product._id)}
          inStock={item.availability !== "out_of_stock"}
          color={primaryColor}
          buttonClass={sizeless(skin.button)}
          inputClass={skin.input}
        />
      </div>
    </>
  );

  const titleBlock = (
    <>
      {item.category && <p className={skin.eyebrow}>{item.category}</p>}
      <h1 className={`mt-2 text-3xl sm:text-4xl ${layout === "stacked" ? "lg:text-5xl" : ""} ${skin.heroHeading}`}>{item.name}</h1>
      {ratingSummary && (
        <a href="#reviews" className={`mt-2 inline-block rounded ${skin.focus}`}>
          <RatingStars average={ratingSummary.average} count={ratingSummary.count} size="md" />
        </a>
      )}
    </>
  );

  // Large stacked images (editorial themes): a swipeable row on phones, a
  // column or a two-column grid beside sticky details on desktop.
  const grid = skin.layout.gallery === "grid";
  const stackedImages =
    images.length > 0 ? (
      <ul
        aria-label="Product images"
        className={`sf-scroll-x -mx-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:gap-4 lg:overflow-visible lg:px-0 ${grid ? "lg:grid-cols-2" : "lg:grid-cols-1"}`}
      >
        {images.map((src, i) => (
          <li key={src} className={`shrink-0 snap-center lg:w-auto ${images.length === 1 ? "w-full" : "w-[85%]"} ${grid && i === 0 ? "lg:col-span-2" : ""}`}>
            <div className={`overflow-hidden ${skin.cardImage} ${grid && i === 0 ? "aspect-[4/3]" : skin.media}`}>
              {i === 0 && hasVariants ? (
                <VariantImage productId={String(product._id)} src={src} alt={item.imageAlt || item.name} loading="eager" className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={src} alt={i === 0 ? item.imageAlt || item.name : `${item.name}, image ${i + 1} of ${images.length}`} loading={i === 0 ? "eager" : "lazy"} className="h-full w-full object-cover" />
              )}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <div className={`overflow-hidden ${skin.media} ${skin.cardImage}`}>{placeholder}</div>
    );

  const gallery =
    layout === "stacked" ? (
      stackedImages
    ) : (
      <ProductGallery productId={hasVariants ? String(product._id) : undefined} images={images} name={item.name} alt={item.imageAlt} frameClass={`${skin.media} ${skin.cardImage}`} thumbClass={skin.cardImage} placeholder={placeholder} />
    );

  const disclosure = (title: string, open: boolean, children: React.ReactNode) => (
    <details open={open} className="group py-4">
      <summary className={`flex cursor-pointer list-none items-center justify-between rounded text-xs font-semibold uppercase tracking-[0.22em] ${skin.focus}`}>
        {title}
        <span aria-hidden="true" className="text-base transition-transform group-open:rotate-45">+</span>
      </summary>
      <div className="space-y-4 pt-4">{children}</div>
    </details>
  );

  return (
    <StoreFrame view={view} commerce={commerce}>
      <script
        type="application/ld+json"
        // Escaped JSON-LD built from this product's real data only.
        dangerouslySetInnerHTML={{
          __html: jsonLdScript([
            productJsonLd({
              product: item,
              url: canonical,
              origin,
              sellerName: view.name,
              images,
              rating: ratingSummary,
            }),
            breadcrumbJsonLd([
              { name: view.name, url: `${origin}/` },
              { name: "Products", url: `${origin}/products` },
              { name: item.name, url: canonical },
            ]),
          ]),
        }}
      />
      <div className={`${skin.container} py-6 sm:py-10`} data-product-layout={layout}>
        <nav aria-label="Breadcrumb" className={`mb-6 text-sm ${skin.subtle}`}>
          <ol className="flex flex-wrap items-center gap-1.5">
            <li><Link href="/" className={`rounded hover:underline ${skin.focus}`}>Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link href="/products" className={`rounded hover:underline ${skin.focus}`}>Products</Link></li>
            {item.category && (
              <>
                <li aria-hidden="true">/</li>
                <li><Link href={categoryHref(item.category)} className={`rounded hover:underline ${skin.focus}`}>{item.category}</Link></li>
              </>
            )}
          </ol>
        </nav>

        <div className={`grid gap-8 ${layout === "stacked" ? "lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-16" : "lg:grid-cols-2 lg:gap-14"}`}>
          <div className="min-w-0">{gallery}</div>

          <div className={`min-w-0 ${layout === "stacked" ? "lg:sticky lg:top-28 lg:self-start" : ""} ${skin.detailPanel}`}>
            {titleBlock}
            {layout === "stacked" ? (
              <>
                {purchase}
                {(description || shippingNote || benefitList) && (
                  <div className={`mt-10 border-y ${skin.border}`}>
                    {description && disclosure("Details", true, description)}
                    {(shippingNote || benefitList) && (
                      <div className={`border-t ${skin.border}`}>
                        {disclosure("Shipping & returns", false, <>{shippingNote}{benefitList}</>)}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {hasVariants ? (
                  <>
                    {description && <div className="mt-4">{description}</div>}
                    {purchase}
                  </>
                ) : (
                  <>
                    {purchase}
                    {description && <div className="mt-6">{description}</div>}
                  </>
                )}
                {shippingNote && <div className="mt-6">{shippingNote}</div>}
                {benefitList && <div className={`mt-8 border-t pt-6 ${skin.border}`}>{benefitList}</div>}
              </>
            )}
          </div>
        </div>

        {layout === "spec" && <Specifications item={item} skin={skin} availabilityText={availabilityText} />}

        {ratingSummary && reviews.length > 0 && (
          <section id="reviews" aria-labelledby="reviews-title" className={`mt-16 border-t pt-10 ${skin.border}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="reviews-title" className={skin.heading}>Customer reviews</h2>
              <RatingStars average={ratingSummary.average} count={ratingSummary.count} size="md" />
            </div>
            <p className={`mt-1 text-sm ${skin.subtle}`}>From verified purchases, published after review by the store.</p>
            <ul className="mt-6 grid gap-4 md:grid-cols-2">
              {reviews.map((review) => (
                <li key={review.id} className={`p-5 ${skin.card || `border ${skin.border}`}`}>
                  <RatingStars average={review.rating} />
                  {review.title && <p className="mt-2 font-semibold">{review.title}</p>}
                  {review.body && <p className={`mt-1 whitespace-pre-line text-sm leading-6 ${skin.muted}`}>{review.body}</p>}
                  <p className={`mt-3 text-xs ${skin.subtle}`}>
                    {review.authorName} · Verified purchase · {new Date(review.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {related.length > 0 && (
          <section aria-labelledby="related-products" className="mt-16 sm:mt-24">
            <h2 id="related-products" className={`mb-6 sm:mb-10 ${skin.heading} ${skin.layout.heading === "flourish" || skin.layout.heading === "caps" ? "text-center" : ""}`}>You may also like</h2>
            <ul className={`${skin.grid} ${fewProductsGrid(related.length, skin).className}`} style={fewProductsGrid(related.length, skin).style}>
              {related.map((p, i) => (
                <li key={p.id} data-reveal="" style={{ "--sf-i": i } as React.CSSProperties}>
                  <ProductCard product={p} href={`/product/${p.slug}`} skin={skin} theme={view.theme} businessId={view.id} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </StoreFrame>
  );
}

/**
 * Volt: the product's real facts as a specification table and, for variant
 * products, every purchasable option with its own price and availability, so
 * options are easy to compare. Nothing is shown that the store did not enter.
 */
function Specifications({ item, skin, availabilityText }: { item: StorefrontProduct; skin: StoreSkin; availabilityText: string }) {
  const rows: Array<[string, string]> = [
    ...(item.category ? [["Category", item.category] as [string, string]] : []),
    ...(item.options ?? []).map((o) => [o.name, o.values.join(", ")] as [string, string]),
    ["Availability", availabilityText],
  ];
  const variants = item.variants ?? [];
  const availability = (a: string) => (a === "out_of_stock" ? "Out of stock" : a === "low_stock" ? "Only a few left" : "In stock");
  const cell = `border-b px-4 py-3 ${skin.border}`;
  const head = `${cell} font-mono text-xs font-medium uppercase tracking-[0.15em] ${skin.subtle}`;
  return (
    <div className="mt-16 grid gap-10 lg:grid-cols-2">
      <section aria-labelledby="spec-title">
        <h2 id="spec-title" className={skin.heading}>Specifications</h2>
        <div className={`mt-5 overflow-hidden rounded-2xl border ${skin.border}`}>
          <table className="w-full text-left text-sm">
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label}>
                  <th scope="row" className={`${head} w-2/5`}>{label}</th>
                  <td className={cell}>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {variants.length > 1 && (
        <section aria-labelledby="compare-title">
          <h2 id="compare-title" className={skin.heading}>Compare options</h2>
          <div className={`sf-scroll-x mt-5 overflow-x-auto rounded-2xl border ${skin.border}`}>
            <table className="w-full min-w-[22rem] text-left text-sm">
              <thead>
                <tr>
                  <th scope="col" className={head}>Option</th>
                  <th scope="col" className={head}>Price</th>
                  <th scope="col" className={head}>Availability</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id}>
                    <th scope="row" className={`${cell} font-medium`}>{v.label}</th>
                    <td className={`${cell} font-mono tabular-nums`}>
                      {formatPrice(v.price, item.currency)}
                      {typeof v.compareAtPrice === "number" && v.compareAtPrice > v.price && (
                        <span className={`ml-2 text-xs line-through ${skin.subtle}`}>
                          <span className="sr-only">Original price </span>
                          {formatPrice(v.compareAtPrice, item.currency)}
                        </span>
                      )}
                    </td>
                    <td className={cell}>{availability(v.availability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
