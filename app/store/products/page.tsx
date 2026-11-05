import type React from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPublicStorefront } from "@/lib/tenant";
import { CATALOG_SORTS, catalogCategories, filterCatalog, parseCatalogQuery, type CatalogProduct } from "@/lib/catalog";
import StoreFrame from "@/components/storefront/commerce/StoreFrame";
import StorePageHead from "@/components/storefront/commerce/StorePageHead";
import ProductCard from "@/components/storefront/commerce/ProductCard";
import { readableOn, skinFor } from "@/components/storefront/commerce/skins";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { absoluteUrl, storefrontOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

const SORT_LABELS: Record<(typeof CATALOG_SORTS)[number], string> = {
  newest: "Newest",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  name: "Name",
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) return { title: { absolute: "Products" }, robots: { index: false } };
  const query = parseCatalogQuery(await searchParams);
  // Search and filtered views are not indexed (thin/duplicate pages); the
  // canonical catalog is /products.
  const filtered = Boolean(query.q || query.category || query.sort !== "newest" || query.inStock);
  return {
    title: { absolute: `Products | ${result.business.name}` },
    description: `Browse all products from ${result.business.name}.`,
    alternates: { canonical: absoluteUrl(storefrontOrigin(result.business.subdomain), "/products") },
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Full product catalog of a public storefront: search, category and
 * availability filters and sort, all through GET parameters (works without
 * client JavaScript). Themes with `layout.catalog === "sidebar"` show the
 * filters in a sticky sidebar with category counts; the others in a toolbar.
 * "products" is a reserved page slug, so this route never shadows a page.
 */
export default async function StorefrontProducts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const headerList = await headers();
  const result = await getPublicStorefront(headerList.get("host"));
  if (!result) notFound();
  const { view, commerce } = await loadStorefrontFrame(result, headerList.get("cookie"));
  const skin = skinFor(view.themeId);
  const color = view.theme.primaryColor;
  const onColor = readableOn(color);

  const byId = new Map(view.products.map((product) => [product.id, product]));
  // Stock for filtering stays server-side; the public view has availability only.
  const stockById = new Map(result.products.map((product) => [String(product._id), Number(product.stock ?? 0)]));
  const all: CatalogProduct[] = view.products.map((product) => ({ ...product, stock: stockById.get(product.id) ?? 0 }));
  const query = parseCatalogQuery(await searchParams);
  const categories = catalogCategories(all);
  const shown = filterCatalog(all, query);
  const filtered = Boolean(query.q || query.category);

  const categoryHref = (category: string) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (category) params.set("category", category);
    if (query.inStock) params.set("stock", "in");
    if (query.sort !== "newest") params.set("sort", query.sort);
    const qs = params.toString();
    return qs ? `/products?${qs}` : "/products";
  };
  const chip = `${skin.badge === "rounded-none" ? "rounded-none" : "rounded-full"} border px-3 py-1.5 text-sm ${skin.focus}`;
  const sidebar = skin.layout.catalog === "sidebar";
  const countByCategory = new Map<string, number>();
  for (const product of all) {
    const key = product.category.trim().toLowerCase();
    if (key) countByCategory.set(key, (countByCategory.get(key) ?? 0) + 1);
  }
  const anyFilter = filtered || Boolean(query.inStock);
  const withoutParam = (name: "q" | "category" | "stock") => {
    const params = new URLSearchParams();
    if (query.q && name !== "q") params.set("q", query.q);
    if (query.category && name !== "category") params.set("category", query.category);
    if (query.inStock && name !== "stock") params.set("stock", "in");
    if (query.sort !== "newest") params.set("sort", query.sort);
    const qs = params.toString();
    return qs ? `/products?${qs}` : "/products";
  };
  const activeChip = (label: string, href: string) => (
    <li>
      <Link href={href} className={`inline-flex items-center gap-1.5 ${chip} ${skin.border}`}>
        {label}
        <span aria-hidden="true">×</span>
        <span className="sr-only">(remove filter)</span>
      </Link>
    </li>
  );

  // One GET form (works without JavaScript): search, sort and availability.
  const filtersForm = (
    <form method="get" action="/products" role="search" className={sidebar ? "grid grid-cols-2 gap-3 lg:grid-cols-1" : "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"}>
      <label className={`text-sm font-medium ${sidebar ? "col-span-2 lg:col-span-1" : "flex-1 sm:min-w-[14rem]"}`}>
        Search
        <input
          id="catalog-search"
          type="search"
          name="q"
          defaultValue={query.q}
          maxLength={100}
          placeholder="Search products"
          className={`mt-1 block w-full rounded-lg px-3 py-2 ${skin.input} ${skin.focus}`}
        />
      </label>
      {query.category && <input type="hidden" name="category" value={query.category} />}
      <label className="text-sm font-medium">
        Sort by
        <select name="sort" defaultValue={query.sort} className={`mt-1 block w-full rounded-lg px-3 py-2 ${sidebar ? "" : "sm:w-auto"} ${skin.input} ${skin.focus}`}>
          {CATALOG_SORTS.map((sort) => (
            <option key={sort} value={sort} className="text-gray-900">
              {SORT_LABELS[sort]}
            </option>
          ))}
        </select>
      </label>
      <label className={`flex items-center gap-2 self-end py-2 text-sm font-medium ${sidebar ? "" : "sm:self-auto sm:pb-2.5"}`}>
        <input type="checkbox" name="stock" value="in" defaultChecked={Boolean(query.inStock)} className="h-4 w-4 rounded" style={{ accentColor: color }} />
        In stock only
      </label>
      <button type="submit" className={`px-5 py-2.5 text-sm font-semibold ${sidebar ? "col-span-2 lg:col-span-1" : ""} ${skin.button} ${skin.focus}`} style={{ background: color, color: onColor }}>
        Apply
      </button>
    </form>
  );

  const categoryNav =
    categories.length > 0 ? (
      <nav aria-label="Categories" className={sidebar ? "mt-6 lg:mt-8" : "mt-5"}>
        {sidebar && <p className={`mb-2 hidden text-xs font-semibold uppercase tracking-wider lg:block ${skin.subtle}`}>Categories</p>}
        <ul className={sidebar ? "sf-scroll-x -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0" : "flex flex-wrap gap-2"}>
          {[{ name: "All", value: "", count: all.length }, ...categories.map((name) => ({ name, value: name, count: countByCategory.get(name.toLowerCase()) ?? 0 }))].map((entry) => {
            const active = entry.value === "" ? !query.category : entry.value.toLowerCase() === query.category.toLowerCase();
            return (
              <li key={entry.name} className="shrink-0">
                <Link
                  href={categoryHref(entry.value)}
                  aria-current={active ? "page" : undefined}
                  className={
                    sidebar
                      ? `${chip} flex items-center justify-between gap-3 whitespace-nowrap lg:rounded-lg lg:border-0 lg:px-3 lg:py-2 ${active ? "font-semibold" : `${skin.border} lg:hover:bg-black/5`}`
                      : `${chip} inline-flex items-center gap-1.5 ${active ? "font-semibold" : skin.border}`
                  }
                  style={active ? { background: color, borderColor: color, color: onColor } : undefined}
                >
                  {entry.name}
                  <span className="text-xs opacity-75">{entry.count}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    ) : null;

  const results =
    all.length === 0 ? (
      <div className={`mt-6 p-10 text-center ${skin.card || `border ${skin.border}`} ${skin.muted}`}>
        This store has not published any products yet.
      </div>
    ) : shown.length === 0 ? (
      <div className={`mt-6 p-10 text-center ${skin.card || `border ${skin.border}`}`}>
        <p>No products match your search.</p>
        <Link href="/products" className={`mt-4 inline-block rounded font-semibold underline underline-offset-4 ${skin.focus}`}>
          Show all products
        </Link>
      </div>
    ) : (
      <ul className={`mt-6 ${sidebar ? skin.catalogGrid : skin.grid}`}>
        {shown.map((product, i) => (
          <li key={product.id} data-reveal="" style={{ "--sf-i": i % 4 } as React.CSSProperties}>
            <ProductCard product={byId.get(product.id) ?? product} href={`/product/${product.slug}`} skin={skin} theme={view.theme} businessId={view.id} />
          </li>
        ))}
      </ul>
    );

  const summary = (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <p className={`text-sm ${skin.muted}`} aria-live="polite">
        {shown.length} {shown.length === 1 ? "product" : "products"}
        {anyFilter ? " found" : ""}
      </p>
      {anyFilter && (
        <ul className="flex flex-wrap gap-2" aria-label="Active filters">
          {query.q && activeChip(`“${query.q}”`, withoutParam("q"))}
          {query.category && activeChip(query.category, withoutParam("category"))}
          {query.inStock && activeChip("In stock only", withoutParam("stock"))}
        </ul>
      )}
    </div>
  );

  return (
    <StoreFrame view={view} commerce={commerce}>
      <div className={`${skin.container} py-8 sm:py-12`} data-catalog-layout={skin.layout.catalog}>
        <StorePageHead skin={skin} primary={view.theme.primaryColor} title={query.category ? query.category : commerce.labels.catalogTitle} />

        {sidebar ? (
          <div className="mt-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
            <aside aria-label="Filters" className={`lg:sticky lg:top-36 lg:self-start lg:border-r lg:pr-8 ${skin.border}`}>
              {filtersForm}
              {categoryNav}
            </aside>
            <div className="mt-6 min-w-0 lg:mt-0">
              {summary}
              {results}
            </div>
          </div>
        ) : (
          <>
            <div className="mt-6">{filtersForm}</div>
            {categoryNav}
            {summary}
            {results}
          </>
        )}
      </div>
    </StoreFrame>
  );
}
