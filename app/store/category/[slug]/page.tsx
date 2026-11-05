import type React from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { loadPublicCategories } from "@/lib/categories";
import { getCategoryMetadata } from "@/lib/seo";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import StorePageHead from "@/components/storefront/commerce/StorePageHead";
import ProductCard from "@/components/storefront/commerce/ProductCard";
import { fewProductsGrid, skinFor } from "@/components/storefront/commerce/skins";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const headerList = await headers();
  return getCategoryMetadata(headerList.get("host"), slug);
}

/**
 * Landing page of an ACTIVE managed category that has products: its image,
 * description and products. Inactive, empty or unknown categories are 404.
 */
export default async function StorefrontCategory({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) notFound();
  const category = (await loadPublicCategories(result.business._id)).find((c) => c.slug === slug && c.active);
  if (!category) notFound();

  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  const products = view.products.filter((p) => p.category?.trim().toLowerCase() === category.name.toLowerCase());
  if (products.length === 0) notFound();
  const skin = skinFor(view.themeId);

  return (
    <StoreFrame view={view} commerce={commerce}>
      <div className={`${skin.container} py-8 sm:py-12`}>
        <nav aria-label="Breadcrumb" className={`mb-4 text-sm ${skin.subtle}`}>
          <ol className="flex flex-wrap items-center gap-1.5">
            <li><Link href="/" className="hover:underline">Home</Link></li>
            <li aria-hidden="true">/</li>
            <li><Link href="/products" className="hover:underline">Products</Link></li>
            <li aria-hidden="true">/</li>
            <li aria-current="page">{category.name}</li>
          </ol>
        </nav>
        <header className={`grid items-center gap-6 ${category.imageUrl ? "md:grid-cols-[1fr_20rem]" : ""}`}>
          <StorePageHead skin={skin} primary={view.theme.primaryColor} title={category.name}>
            {category.description && <p className={`mt-3 max-w-2xl leading-7 ${skin.muted}`}>{category.description}</p>}
            <p className={`mt-2 text-sm ${skin.subtle}`}>{products.length} {products.length === 1 ? "product" : "products"}</p>
          </StorePageHead>
          {category.imageUrl && (
            <div className={`aspect-[4/3] overflow-hidden ${skin.cardImage}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={category.imageUrl} alt="" className="h-full w-full object-cover" />
            </div>
          )}
        </header>
        <ul className={`mt-8 ${skin.grid} ${fewProductsGrid(products.length, skin).className}`} style={fewProductsGrid(products.length, skin).style}>
          {products.map((product, i) => (
            <li key={product.id} data-reveal="" style={{ "--sf-i": i % 4 } as React.CSSProperties}>
              <ProductCard product={product} href={`/product/${product.slug}`} skin={skin} theme={view.theme} businessId={view.id} />
            </li>
          ))}
        </ul>
      </div>
    </StoreFrame>
  );
}
