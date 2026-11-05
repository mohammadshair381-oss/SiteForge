/**
 * Browser event fired after the cart changes (add, quantity, remove, checkout),
 * so the header's cart count can refresh without a page reload. Client-only;
 * the event carries no data (the count is always re-read from the cart API).
 */
export const CART_UPDATED_EVENT = "siteforge:cart-updated";

export function notifyCartUpdated(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CART_UPDATED_EVENT));
}
