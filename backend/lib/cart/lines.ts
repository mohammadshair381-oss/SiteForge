import type mongoose from "mongoose";
import { effectivePrice, variantLabel } from "@/lib/product-variants";
import { Product } from "@/models/Product";
import type { CartItem } from "@/models/Cart";
import { cartLineKey } from "./rules";

/**
 * What a cart's lines mean right now (server-only). Everything is read from the products
 * of THIS business, so a line naming another store's product simply counts as gone. The
 * browser is told whether a line can be bought, never how many are in stock.
 */
export type CartLineStatus = "ok" | "insufficient_stock" | "out_of_stock" | "unavailable";

export interface CartLineInfo {
  key: string;
  product: string;
  variant: string;
  name: string;
  slug: string;
  imageUrl: string;
  variantLabel: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  status: CartLineStatus;
  priceChanged: boolean;
}

interface LoadedProduct {
  _id: unknown;
  name: string;
  slug: string;
  price: number;
  currency?: string;
  imageUrl?: string;
  images?: string[];
  status: string;
  stock: number;
  options?: unknown[];
  variants?: Array<{ _id: unknown; options: Array<{ name: string; value: string }>; price?: number | null; stock: number; archived?: boolean; imageUrl?: string }>;
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

async function loadProducts(items: readonly CartItem[], businessId: string, session?: mongoose.ClientSession) {
  const ids = [...new Set(items.map((item) => String(item.product)).filter((id) => OBJECT_ID.test(id)))];
  if (ids.length === 0) return new Map<string, LoadedProduct>();
  const query = Product.find({ _id: { $in: ids }, business: businessId }).select("name slug price currency imageUrl images status stock options variants");
  if (session) query.session(session);
  const products = await query.lean<LoadedProduct[]>();
  return new Map(products.map((product) => [String(product._id), product]));
}

function inspect(item: CartItem, product: LoadedProduct | undefined) {
  if (!product || product.status !== "active") return { status: "unavailable" as const, variant: null, unitPrice: item.priceSnapshot, stock: 0 };
  const hasVariants = Array.isArray(product.options) && product.options.length > 0;
  const wanted = item.variant ?? "";
  const variant = hasVariants ? product.variants?.find((v) => String(v._id) === wanted && !v.archived) ?? null : null;
  if ((hasVariants && !variant) || (!hasVariants && wanted)) return { status: "unavailable" as const, variant: null, unitPrice: item.priceSnapshot, stock: 0 };
  const stock = Number((variant ?? product).stock ?? 0);
  const status: CartLineStatus = stock <= 0 ? "out_of_stock" : stock < item.quantity ? "insufficient_stock" : "ok";
  return { status, variant, unitPrice: effectivePrice(product.price, variant), stock };
}

/** Each line as the shopper should see it now. Read-only. */
export async function describeCartLines(items: readonly CartItem[], businessId: string): Promise<CartLineInfo[]> {
  const products = await loadProducts(items, businessId);
  return items.map((item) => {
    const product = products.get(String(item.product));
    const { status, variant, unitPrice } = inspect(item, product);
    return {
      key: cartLineKey(item),
      product: String(item.product),
      variant: item.variant ?? "",
      name: product?.name ?? item.productName ?? "",
      slug: status === "unavailable" ? "" : product?.slug ?? "",
      imageUrl: status === "unavailable" ? "" : variant?.imageUrl || product?.imageUrl || product?.images?.[0] || "",
      variantLabel: variant ? variantLabel(variant.options) : item.variantLabel ?? "",
      quantity: item.quantity,
      unitPrice,
      currency: product?.currency || item.currency,
      status,
      priceChanged: status !== "unavailable" && unitPrice !== item.priceSnapshot,
    };
  });
}

/**
 * Brings saved lines up to date before a shopper gets them back: gone or sold-out items
 * are left out, quantities are limited to what is there, and prices become current. It
 * only says what changed, and reserves nothing. Used for a merge and an abandoned cart.
 */
export async function revalidateCartItems(items: readonly CartItem[], businessId: string, session?: mongoose.ClientSession): Promise<{ items: CartItem[]; notices: string[] }> {
  const products = await loadProducts(items, businessId, session);
  const kept: CartItem[] = [];
  const notices: string[] = [];
  for (const item of items) {
    const product = products.get(String(item.product));
    const { status, variant, unitPrice, stock } = inspect(item, product);
    const name = product?.name ?? item.productName ?? "An item";
    if (status === "unavailable") {
      notices.push(`${name} is no longer available, so it was removed from your cart.`);
      continue;
    }
    if (status === "out_of_stock") {
      notices.push(`${name} is out of stock, so it was removed from your cart.`);
      continue;
    }
    const quantity = Math.min(item.quantity, stock);
    if (quantity < item.quantity) notices.push(`There are fewer of ${name} available now, so the quantity in your cart was lowered to ${quantity}.`);
    if (unitPrice !== item.priceSnapshot) notices.push(`The price of ${name} has changed since you added it.`);
    kept.push({
      product: String(item.product),
      variant: item.variant ?? "",
      variantLabel: variant ? variantLabel(variant.options) : "",
      productName: name,
      quantity,
      priceSnapshot: unitPrice,
      currency: (product?.currency || item.currency || "USD").toUpperCase(),
    });
  }
  return { items: kept, notices };
}

export function cartTotalOf(items: readonly CartItem[]): number {
  return Math.round(items.reduce((sum, item) => sum + item.priceSnapshot * item.quantity, 0) * 100) / 100;
}
