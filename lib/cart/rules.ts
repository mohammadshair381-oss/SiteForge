/**
 * Cart lifecycle rules (pure, and safe anywhere). A cart holds no stock: stock is
 * reserved only when an order is placed, so an abandoned cart can never keep an item
 * from another shopper. These dates only decide what happens to the record.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How long the browser keeps a cart between visits. Renewed whenever the cart is used. */
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Untouched for this long, a cart counts as abandoned. */
export const CART_ABANDONED_AFTER_MS = 24 * HOUR_MS;
/** Untouched for this long, a cart is deleted. */
export const CART_EXPIRY_MS = 30 * DAY_MS;
/** Sentence-sized messages kept for the shopper's next visit to the cart page. */
export const MAX_CART_NOTICES = 10;

export type CartLifecycle = "active" | "abandoned" | "expired";

export function cartLifecycle(updatedAt: Date | string | null | undefined, now: Date = new Date()): CartLifecycle {
  const age = now.getTime() - new Date(updatedAt ?? 0).getTime();
  if (age >= CART_EXPIRY_MS) return "expired";
  return age >= CART_ABANDONED_AFTER_MS ? "abandoned" : "active";
}

export interface MergeableLine {
  product: string;
  variant?: string;
  quantity: number;
}

export const cartLineKey = (line: { product: string; variant?: string }) => `${line.product}:${line.variant ?? ""}`;

/**
 * Combines two carts so a product and variant appear once, adding the quantities. Stock
 * and prices are not considered here: `revalidateCartItems` checks those next.
 */
export function mergeCartLines<T extends MergeableLine>(target: readonly T[], source: readonly T[]): T[] {
  const merged = new Map<string, T>();
  for (const line of [...target, ...source]) {
    const key = cartLineKey(line);
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, quantity: existing.quantity + line.quantity } : { ...line });
  }
  return [...merged.values()];
}
