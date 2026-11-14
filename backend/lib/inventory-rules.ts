/**
 * Inventory display rules (pure, shared by server and client). Exact counts
 * are for the business only; shoppers see a derived availability.
 */

export type ProductAvailability = "in_stock" | "low_stock" | "out_of_stock";

/** Low-stock level when a product sets no threshold of its own. */
export const LOW_STOCK_DEFAULT = 5;

export function lowStockLevel(threshold: number | null | undefined): number {
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 ? threshold : LOW_STOCK_DEFAULT;
}

export function availabilityOf(stock: unknown, threshold?: number | null): ProductAvailability {
  const units = Number(stock ?? 0);
  if (!Number.isFinite(units) || units <= 0) return "out_of_stock";
  return units <= lowStockLevel(threshold) ? "low_stock" : "in_stock";
}

/** Quantity a shopper may pick at once (never reveals the real stock). */
export const MAX_QUANTITY_PER_LINE = 20;
