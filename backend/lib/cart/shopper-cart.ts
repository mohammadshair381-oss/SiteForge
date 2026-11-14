import mongoose from "mongoose";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import { readCustomerSessionCookie } from "@/lib/auth/customer-session";
import { isFeatureReady } from "@/lib/required-indexes";
import { Cart, type CartDoc } from "@/models/Cart";
import { cartTotalOf, revalidateCartItems } from "./lines";
import { MAX_CART_NOTICES, mergeCartLines } from "./rules";

/**
 * Whose cart a storefront request is about (server-only). The store always comes from the
 * caller's Host-resolved business, and every read filters by it, so one store's cart can
 * never appear in another.
 *
 * A guest's cart is found by the httpOnly `cart-token` cookie. A signed-in customer has one
 * cart per store, tied to the account, so it follows them between devices. That needs the
 * unique index in docs/commerce-operations.md: until it exists, carts stay guest-style.
 * A cart tied to an account is never reachable without that account's session, so signing
 * out on a shared computer does not leave it for the next person.
 */
export interface ShopperCart {
  /** The cart to use; null when the shopper has none yet. */
  token: string | null;
  /** Set only while account carts are switched on: new carts belong to this customer. */
  customerId: string | null;
}

export function readCartToken(request: Request): string | null {
  const match = (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)cart-token=([^;]+)/);
  return match?.[1] ?? null;
}

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);

/** Adds a guest cart to the customer's own, once. Runs after a real sign-in only. */
async function mergeGuestCart(businessId: string, ownId: unknown, guestId: unknown): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Whoever deletes the guest cart does the merge, so two requests cannot both add it.
      const guest = await Cart.findOneAndDelete({ _id: guestId, business: businessId, customer: { $exists: false } }, { session }).lean<CartDoc>();
      if (!guest) return;
      const own = await Cart.findOne({ _id: ownId, business: businessId }).session(session);
      if (!own) return;
      // Plain values only: `mergeCartLines` copies lines with `{ ...line }`, and copying a Mongoose
      // subdocument that way keeps its internals, not its fields, so the account cart's lines were lost.
      const { items, notices } = await revalidateCartItems(mergeCartLines(own.toObject().items, guest.items), businessId, session);
      own.items = items;
      own.subtotal = cartTotalOf(items);
      own.total = own.subtotal;
      own.notices = [...(own.notices ?? []), ...(guest.items.length > 0 ? ["Items from your earlier visit were added to your cart."] : []), ...notices].slice(-MAX_CART_NOTICES);
      await own.save({ session });
    });
  } finally {
    await session.endSession();
  }
}

export async function resolveShopperCart(request: Request, business: { _id: unknown }): Promise<ShopperCart> {
  const businessId = String(business._id);
  const cookieToken = readCartToken(request);

  let customerId: string | null = null;
  if (readCustomerSessionCookie(request) !== null && (await isFeatureReady("customer_carts"))) {
    const resolution = await resolveCheckoutCustomer(request, { _id: business._id } as Parameters<typeof resolveCheckoutCustomer>[1]);
    if (resolution.status === "customer") customerId = resolution.customer.id;
  }

  const cookieCart = cookieToken ? await Cart.findOne({ business: businessId, ownerToken: cookieToken }).select("customer ownerToken").lean<Pick<CartDoc, "_id" | "customer" | "ownerToken">>() : null;

  if (!customerId) {
    // Not signed in as whoever owns this cart: to this request it does not exist.
    return { token: cookieCart?.customer ? null : cookieToken, customerId: null };
  }

  const customer = new mongoose.Types.ObjectId(customerId);
  const own = await Cart.findOne({ business: businessId, customer }).select("ownerToken").lean<Pick<CartDoc, "_id" | "ownerToken">>();
  const guest = cookieCart && !cookieCart.customer ? cookieCart : null;

  if (own && guest) {
    await mergeGuestCart(businessId, own._id, guest._id);
    return { token: own.ownerToken, customerId };
  }
  if (own) return { token: own.ownerToken, customerId };
  if (guest) {
    try {
      // The customer's first cart: the guest cart simply becomes theirs.
      await Cart.updateOne({ _id: guest._id, business: businessId, customer: { $exists: false } }, { $set: { customer } }, { timestamps: false });
      return { token: guest.ownerToken, customerId };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Another request made one a moment ago. Use it; the guest cart merges next time.
      const winner = await Cart.findOne({ business: businessId, customer }).select("ownerToken").lean<Pick<CartDoc, "ownerToken">>();
      return { token: winner?.ownerToken ?? null, customerId };
    }
  }
  // A cookie for someone else's cart, or a cart already ordered: start fresh.
  return { token: cookieCart ? null : cookieToken, customerId };
}
