import type { StorefrontProduct } from "@/lib/storefront";

/**
 * schema.org JSON-LD built ONLY from real store data (pure). Nothing is
 * invented: no rating without approved reviews, availability from the derived
 * product availability, prices from the product/variants.
 */

type Json = Record<string, unknown>;

/** Serialises JSON-LD for a <script> tag: `<` is escaped so text can never close the tag. */
export function jsonLdScript(data: Json | Json[]): string {
  // Each replacement is the 6-character escape sequence (backslash, "u", hex).
  const backslash = String.fromCharCode(92);
  return JSON.stringify(data)
    .replace(/</g, `${backslash}u003c`)
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), `${backslash}u2028`)
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), `${backslash}u2029`);
}

/** Makes a store path (e.g. a local media URL) absolute on the store origin. */
export function absolutize(origin: string, value: string): string {
  if (!value) return value;
  if (/^https:\/\//i.test(value)) return value;
  return value.startsWith("/") ? `${origin}${value}` : value;
}

const AVAILABILITY: Record<string, string> = {
  in_stock: "https://schema.org/InStock",
  low_stock: "https://schema.org/LimitedAvailability",
  out_of_stock: "https://schema.org/OutOfStock",
};

export interface RatingSummary {
  average: number;
  count: number;
}

export function productJsonLd(input: {
  product: StorefrontProduct;
  url: string;
  origin: string;
  sellerName: string;
  images: string[];
  rating?: RatingSummary | null;
}): Json {
  const { product } = input;
  const variants = product.variants ?? [];
  const purchasable = variants.length > 0;
  const offers: Json = purchasable
    ? {
        "@type": "AggregateOffer",
        priceCurrency: product.currency,
        lowPrice: Math.min(...variants.map((v) => v.price)),
        highPrice: Math.max(...variants.map((v) => v.price)),
        offerCount: variants.length,
        availability: variants.some((v) => v.availability !== "out_of_stock") ? AVAILABILITY.in_stock : AVAILABILITY.out_of_stock,
        url: input.url,
      }
    : {
        "@type": "Offer",
        priceCurrency: product.currency,
        price: product.price,
        availability: AVAILABILITY[product.availability ?? "in_stock"],
        url: input.url,
        seller: { "@type": "Organization", name: input.sellerName },
      };
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    ...(product.description ? { description: product.description.slice(0, 5000) } : {}),
    ...(input.images.length > 0 ? { image: input.images.map((src) => absolutize(input.origin, src)) } : {}),
    ...(product.category ? { category: product.category } : {}),
    url: input.url,
    offers,
    // Only real, approved reviews (never fabricated or defaulted).
    ...(input.rating && input.rating.count > 0
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: Number(input.rating.average.toFixed(2)), reviewCount: input.rating.count, bestRating: 5, worstRating: 1 } }
      : {}),
  };
}

export function storeJsonLd(input: {
  name: string;
  origin: string;
  description?: string;
  logoUrl?: string;
  email?: string;
  phone?: string;
  hasProducts: boolean;
}): Json[] {
  const org: Json = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: input.name,
    url: `${input.origin}/`,
    ...(input.logoUrl ? { logo: absolutize(input.origin, input.logoUrl) } : {}),
    ...(input.description ? { description: input.description.slice(0, 500) } : {}),
    ...(input.email || input.phone
      ? { contactPoint: { "@type": "ContactPoint", contactType: "customer service", ...(input.email ? { email: input.email } : {}), ...(input.phone ? { telephone: input.phone } : {}) } }
      : {}),
  };
  const site: Json = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: input.name,
    url: `${input.origin}/`,
    // The store's real product search (/products?q=).
    ...(input.hasProducts
      ? { potentialAction: { "@type": "SearchAction", target: `${input.origin}/products?q={search_term_string}`, "query-input": "required name=search_term_string" } }
      : {}),
  };
  return [org, site];
}

/** A published content page, and any questions and answers it shows. */
export function pageJsonLd(input: { name: string; url: string; description?: string; faq?: Array<{ question: string; answer: string }> }): Json[] {
  const out: Json[] = [
    { "@context": "https://schema.org", "@type": "WebPage", name: input.name, url: input.url, ...(input.description ? { description: input.description } : {}) },
  ];
  if (input.faq && input.faq.length > 0) {
    out.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: input.faq.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })),
    });
  }
  return out;
}

export function breadcrumbJsonLd(items: Array<{ name: string; url: string }>): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.name, item: item.url })),
  };
}
