/**
 * Storefront catalog browsing (pure, no I/O): search, category and
 * availability filters and sort over a store's already-public products (active products loaded by
 * `getPublicStorefront`). Inputs come from the URL, so every value is
 * normalised and bounded here; nothing is passed to a database query.
 */

export interface CatalogProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  price: number;
  currency: string;
  imageUrl: string;
  category: string;
  stock: number;
}

export const CATALOG_SORTS = ["newest", "price-asc", "price-desc", "name"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface CatalogQuery {
  q: string;
  category: string;
  sort: CatalogSort;
  /** Only products with stock (`?stock=in`); absent when not requested. */
  inStock?: true;
}

const MAX_QUERY_LENGTH = 100;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Parses URL search params into a safe, bounded query. Unknown values fall back to defaults. */
export function parseCatalogQuery(params: Record<string, string | string[] | undefined>): CatalogQuery {
  const q = first(params.q).trim().slice(0, MAX_QUERY_LENGTH);
  const category = first(params.category).trim().slice(0, MAX_QUERY_LENGTH);
  const sortValue = first(params.sort);
  const sort = (CATALOG_SORTS as readonly string[]).includes(sortValue) ? (sortValue as CatalogSort) : "newest";
  return { q, category, sort, ...(first(params.stock) === "in" ? { inStock: true as const } : {}) };
}

/** Distinct, non-empty categories in display order (case-insensitive de-duplication). */
export function catalogCategories(products: CatalogProduct[]): string[] {
  const seen = new Map<string, string>();
  for (const product of products) {
    const name = product.category.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Applies the query. `products` must already be in "newest first" order
 * (as loaded); every word of the search must appear in the name, description
 * or category (case-insensitive).
 */
export function filterCatalog(products: CatalogProduct[], query: CatalogQuery): CatalogProduct[] {
  const words = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const category = query.category.toLowerCase();
  const matches = products.filter((product) => {
    if (category && product.category.trim().toLowerCase() !== category) return false;
    // Server-side stock (never sent to the client); variant products carry their variants' total.
    if (query.inStock && !(product.stock > 0)) return false;
    if (words.length === 0) return true;
    const haystack = `${product.name} ${product.description} ${product.category}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const sorted = [...matches];
  if (query.sort === "price-asc") sorted.sort((a, b) => a.price - b.price);
  else if (query.sort === "price-desc") sorted.sort((a, b) => b.price - a.price);
  else if (query.sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  return sorted;
}
