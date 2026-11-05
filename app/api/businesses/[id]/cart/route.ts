import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { handle, ok, HttpError } from "@/lib/api";
import { isValidObjectId } from "@/lib/ids";
import { resolveCommerceBusiness } from "@/lib/tenant";
import { releaseExpiredOrdersOnDemand } from "@/lib/orders/lifecycle";
import {
  enforceCartReadRateLimit,
  enforceCartWriteRateLimit,
} from "@/lib/storefront-rate-limit";
import { Product } from "@/models/Product";
import { Cart, type CartDoc, type CartItem } from "@/models/Cart";
import { effectivePrice, variantLabel } from "@/lib/product-variants";
import { describeCartLines, revalidateCartItems } from "@/lib/cart/lines";
import { CART_COOKIE_MAX_AGE_SECONDS, MAX_CART_NOTICES, cartLifecycle } from "@/lib/cart/rules";
import { resolveShopperCart } from "@/lib/cart/shopper-cart";

const CART_COOKIE = "cart-token";
// Renewed on every cart response, so a cart in use lasts as long as the cart itself.
const CART_COOKIE_MAX_AGE = CART_COOKIE_MAX_AGE_SECONDS;

interface CartWriteBody {
  productId?: unknown;
  variantId?: unknown;
  quantity?: unknown;
  action?: unknown;
}

interface CartResponseBody {
  items: Array<{
    product: string;
    variant: string;
    variantLabel: string;
    quantity: number;
    priceSnapshot: number;
    currency: string;
  }>;
  subtotal: number;
  total: number;
}

/**
 * Resolve the business from the trusted storefront Host header. The [id] route
 * parameter is intentionally not used: a guest must never be able to address a
 * different tenant by editing the URL.
 */
async function resolveBusiness(request: Request) {
  const business = await resolveCommerceBusiness(request.headers.get("host"));
  if (!business) {
    throw new HttpError(404, "Business not found", "not_found");
  }
  return { business, businessId: business._id.toString() };
}

function withCartCookie(response: NextResponse, ownerToken: string): NextResponse {
  response.cookies.set({
    name: CART_COOKIE,
    value: ownerToken,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: CART_COOKIE_MAX_AGE,
  });
  return response;
}

function withClearedCartCookie(response: NextResponse): NextResponse {
  response.cookies.set({
    name: CART_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

function serializeCart(
  cart: Pick<CartDoc, "items" | "subtotal" | "total">,
): CartResponseBody {
  return {
    items: (cart.items ?? []).map((item) => ({
      product: item.product,
      variant: item.variant ?? "",
      variantLabel: item.variantLabel ?? "",
      quantity: item.quantity,
      priceSnapshot: item.priceSnapshot,
      currency: item.currency,
    })),
    subtotal: cart.subtotal ?? 0,
    total: cart.total ?? 0,
  };
}

/**
 * `lines` says what each line means right now (current price and image, whether it can
 * still be bought); `items` stays as saved. Availability only, never a stock count.
 */
async function cartResponse(
  cart: Pick<CartDoc, "items" | "subtotal" | "total">,
  ownerToken: string,
  businessId: string,
  notices: string[] = [],
): Promise<NextResponse> {
  const lines = await describeCartLines(cart.items ?? [], businessId);
  return withCartCookie(ok({ ...serializeCart(cart), lines, notices }), ownerToken);
}

/**
 * Parse a JSON or form-urlencoded cart write body. The body stream can only be
 * consumed once, so the parser is selected from Content-Type first.
 */
async function parseCartBody(request: Request): Promise<CartWriteBody> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      throw new HttpError(400, "Invalid request payload", "invalid_payload");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "Invalid request payload", "invalid_payload");
    }
    return parsed as CartWriteBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new HttpError(400, "Invalid request payload", "invalid_payload");
    }
    return {
      productId: form.get("productId"),
      variantId: form.get("variantId"),
      quantity: form.get("quantity"),
      action: form.get("action"),
    };
  }

  throw new HttpError(
    400,
    "Unsupported Content-Type: expected application/json or application/x-www-form-urlencoded",
    "invalid_payload",
  );
}

function readAction(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid action", "invalid_payload");
  }
  const action = value.trim().toLowerCase();
  return action || undefined;
}

function requireProductId(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "Invalid product ID", "invalid_product_id");
  }
  const productId = value.trim();
  if (!isValidObjectId(productId)) {
    throw new HttpError(400, "Invalid product ID", "invalid_product_id");
  }
  return productId;
}

/**
 * A missing quantity defaults to 1 on POST for compatibility with the existing
 * form contract. Any quantity that is present must be a positive safe integer,
 * so zero, negatives, fractions and non-numeric values are rejected.
 */
function parseQuantity(value: unknown, defaultValue?: number): number {
  const isMissing =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "");

  if (isMissing) {
    if (defaultValue !== undefined) return defaultValue;
    throw new HttpError(
      400,
      "Quantity must be a positive integer",
      "invalid_quantity",
    );
  }

  if (typeof value === "boolean" || typeof value === "object") {
    throw new HttpError(
      400,
      "Quantity must be a positive integer",
      "invalid_quantity",
    );
  }

  const quantity = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new HttpError(
      400,
      "Quantity must be a positive integer",
      "invalid_quantity",
    );
  }
  return quantity;
}

interface ValidatedProduct {
  name: string;
  price: number;
  currency: string;
  variantLabel: string;
}

/** Optional variant id ("" for simple products). */
function readVariantId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !isValidObjectId(value.trim())) {
    throw new HttpError(400, "Invalid product option", "invalid_variant");
  }
  return value.trim();
}

/** The cart line for a product (and variant). */
function findLine(items: CartItem[], productId: string, variantId: string): number {
  return items.findIndex((item) => item.product === productId && (item.variant ?? "") === variantId);
}

/**
 * Load the real product for this tenant and validate all server-side purchase
 * attributes. The quantity check uses the resulting cart quantity (existing +
 * requested), so a cart can never hold more units than the product has.
 */
async function loadPurchasableProduct(
  productId: string,
  businessId: string,
  requestedQuantity: number,
  variantId = "",
): Promise<ValidatedProduct> {
  const product = await Product.findOne({
    _id: productId,
    business: businessId,
  });

  if (!product) {
    throw new HttpError(
      403,
      "That product does not belong to this business",
      "cross_business_product",
    );
  }

  if (product.status !== "active") {
    throw new HttpError(
      404,
      "Product is not available for purchase",
      "product_unavailable",
    );
  }

  const currency = (product.currency || "USD").trim().toUpperCase();
  if (
    !Number.isFinite(product.price) ||
    product.price < 0 ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    throw new HttpError(422, "Product data is invalid", "invalid_product_data");
  }

  // Variant products are bought per variant (a live variant of THIS product);
  // a simple product must not be given a variant.
  const hasVariants = Array.isArray(product.options) && product.options.length > 0;
  if (hasVariants) {
    if (!variantId) throw new HttpError(422, "Choose the product options first", "variant_required");
    const variant = (product.variants ?? []).find((v) => String(v._id) === variantId && !v.archived);
    if (!variant) throw new HttpError(404, "That product option is not available", "variant_unavailable");
    if (!Number.isFinite(variant.stock) || variant.stock < requestedQuantity) {
      throw new HttpError(404, "Product is out of stock", "out_of_stock");
    }
    return { name: product.name, price: effectivePrice(product.price, variant), currency, variantLabel: variantLabel(variant.options) };
  }
  if (variantId) throw new HttpError(404, "That product option is not available", "variant_unavailable");

  if (!Number.isFinite(product.stock) || product.stock < requestedQuantity) {
    throw new HttpError(404, "Product is out of stock", "out_of_stock");
  }

  return { name: product.name, price: product.price, currency, variantLabel: "" };
}

function calculateSubtotal(items: CartItem[]): number {
  let subtotal = 0;
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new HttpError(500, "Cart contains an invalid quantity", "invalid_cart");
    }
    if (!Number.isFinite(item.priceSnapshot) || item.priceSnapshot < 0) {
      throw new HttpError(500, "Cart contains an invalid price", "invalid_cart");
    }
    subtotal += item.priceSnapshot * item.quantity;
    if (!Number.isFinite(subtotal)) {
      throw new HttpError(500, "Cart total is invalid", "invalid_cart");
    }
  }
  return subtotal;
}

function applyTotals(
  cart: Pick<CartDoc, "items" | "subtotal" | "total">,
): void {
  const subtotal = calculateSubtotal(cart.items);
  cart.subtotal = subtotal;
  cart.total = subtotal;
}

export async function GET(request: Request) {
  return handle(async () => {
    const { business, businessId } = await resolveBusiness(request);
    await enforceCartReadRateLimit(request, businessId);
    const shopper = await resolveShopperCart(request, business);
    const ownerToken = shopper.token ?? crypto.randomUUID();

    // An unknown token gets an empty cart (and the token cookie), and the document is
    // created by the first add: creating one here would let any visitor or crawler make
    // unbounded empty carts. Only a cart the shopper already has can change on a read.
    let cart = await Cart.findOne({ business: businessId, ownerToken });
    if (cart) {
      const lifecycle = cartLifecycle(cart.updatedAt);
      if (lifecycle === "expired") {
        await Cart.deleteOne({ _id: cart._id, business: businessId });
        cart = null;
      } else if (lifecycle === "abandoned" && cart.items.length > 0) {
        // Coming back: never hand back what can no longer be bought, or at an old price.
        const { items, notices } = await revalidateCartItems(cart.items, businessId);
        cart.items = items;
        applyTotals(cart);
        cart.notices = [...(cart.notices ?? []), ...notices].slice(-MAX_CART_NOTICES);
        cart.recoveredAt = new Date();
        await cart.save();
      }
    }

    // The cart page shows these once. The header's count leaves them for it.
    const notices = cart?.notices ?? [];
    const consume = new URL(request.url).searchParams.get("consumeNotices") === "1";
    if (cart && consume && notices.length > 0) {
      await Cart.updateOne({ _id: cart._id, business: businessId }, { $set: { notices: [] } }, { timestamps: false });
    }
    return cartResponse(cart ?? { items: [], subtotal: 0, total: 0 }, ownerToken, businessId, consume ? [...notices] : []);
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const { business, businessId } = await resolveBusiness(request);
    await enforceCartWriteRateLimit(request, businessId);
    // Free stock held by abandoned unpaid orders before checking availability.
    await releaseExpiredOrdersOnDemand(businessId);
    const body = await parseCartBody(request);
    const action = readAction(body.action);
    const shopper = await resolveShopperCart(request, business);

    if (action === "clear") {
      const ownerToken = shopper.token ?? crypto.randomUUID();
      await Cart.findOneAndDelete({ business: businessId, ownerToken });
      return withClearedCartCookie(
        ok<CartResponseBody>({ items: [], subtotal: 0, total: 0 }),
      );
    }

    if (action !== undefined && action !== "add") {
      throw new HttpError(400, "Invalid action", "invalid_payload");
    }

    const productId = requireProductId(body.productId);
    const variantId = readVariantId(body.variantId);
    const quantity = parseQuantity(body.quantity, 1);
    const ownerToken = shopper.token ?? crypto.randomUUID();

    const cart = await Cart.findOne({ business: businessId, ownerToken });
    let existingItemIndex = -1;
    let existingQuantity = 0;

    if (cart) {
      existingItemIndex = findLine(cart.items, productId, variantId);
      if (existingItemIndex >= 0) {
        existingQuantity = cart.items[existingItemIndex].quantity;
        if (!Number.isSafeInteger(existingQuantity) || existingQuantity < 1) {
          throw new HttpError(
            500,
            "Cart contains an invalid quantity",
            "invalid_cart",
          );
        }
      }
    }

    const requestedQuantity = existingQuantity + quantity;
    if (!Number.isSafeInteger(requestedQuantity)) {
      throw new HttpError(
        400,
        "Quantity must be a positive integer",
        "invalid_quantity",
      );
    }

    // Validate the product before creating or mutating the cart, so a failed
    // request cannot leave an empty cart or a partial update behind.
    const { name: productName, price, currency, variantLabel: label } = await loadPurchasableProduct(
      productId,
      businessId,
      requestedQuantity,
      variantId,
    );

    let writableCart = cart;
    if (!writableCart) {
      try {
        writableCart = await Cart.create({
          business: businessId,
          ownerToken,
          ...(shopper.customerId ? { customer: shopper.customerId } : {}),
          items: [],
          subtotal: 0,
          total: 0,
        });
      } catch (error) {
        // Another tab just made this customer's cart. Trying again finds it.
        if (error && typeof error === "object" && (error as { code?: unknown }).code === 11000) {
          throw new HttpError(409, "Your cart changed. Please try again.", "cart_conflict");
        }
        throw error;
      }
      existingItemIndex = -1;
    }

    if (existingItemIndex >= 0) {
      writableCart.items[existingItemIndex].quantity = requestedQuantity;
      writableCart.items[existingItemIndex].priceSnapshot = price;
      writableCart.items[existingItemIndex].currency = currency;
    } else {
      writableCart.items.push({
        product: productId,
        variant: variantId,
        variantLabel: label,
        productName,
        quantity,
        priceSnapshot: price,
        currency,
      });
    }

    applyTotals(writableCart);
    await writableCart.save();

    return cartResponse(writableCart, ownerToken, businessId);
  });
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const { business, businessId } = await resolveBusiness(request);
    await enforceCartWriteRateLimit(request, businessId);
    // Free stock held by abandoned unpaid orders before checking availability.
    await releaseExpiredOrdersOnDemand(businessId);
    const body = await parseCartBody(request);
    const productId = requireProductId(body.productId);
    const variantId = readVariantId(body.variantId);
    const quantity = parseQuantity(body.quantity);

    const { token: ownerToken } = await resolveShopperCart(request, business);
    if (!ownerToken) {
      throw new HttpError(404, "Cart not found", "cart_not_found");
    }

    const cart = await Cart.findOne({ business: businessId, ownerToken });
    if (!cart) {
      throw new HttpError(404, "Cart not found", "cart_not_found");
    }

    const existingItemIndex = findLine(cart.items, productId, variantId);
    if (existingItemIndex < 0) {
      throw new HttpError(
        404,
        "Product not found in cart",
        "product_not_in_cart",
      );
    }

    // Validate before mutating the document; the product may have been
    // deactivated, deleted, re-priced, or run out of stock since it was added.
    const { price, currency } = await loadPurchasableProduct(
      productId,
      businessId,
      quantity,
      variantId,
    );

    cart.items[existingItemIndex].quantity = quantity;
    cart.items[existingItemIndex].priceSnapshot = price;
    cart.items[existingItemIndex].currency = currency;
    applyTotals(cart);
    await cart.save();

    return cartResponse(cart, ownerToken, businessId);
  });
}

export async function DELETE(request: Request) {
  return handle(async () => {
    const { business, businessId } = await resolveBusiness(request);
    await enforceCartWriteRateLimit(request, businessId);
    const url = new URL(request.url);
    const shopper = await resolveShopperCart(request, business);
    const productIdParam = url.searchParams.get("productId");

    if (productIdParam !== null) {
      const productId = requireProductId(productIdParam);
      const variantId = readVariantId(url.searchParams.get("variantId") ?? "");
      const ownerToken = shopper.token;
      if (!ownerToken) {
        throw new HttpError(404, "Cart not found", "cart_not_found");
      }

      const cart = await Cart.findOne({ business: businessId, ownerToken });
      if (!cart) {
        throw new HttpError(404, "Cart not found", "cart_not_found");
      }

      const existingItemIndex = findLine(cart.items, productId, variantId);
      if (existingItemIndex < 0) {
        throw new HttpError(
          404,
          "Product not found in cart",
          "product_not_in_cart",
        );
      }

      cart.items.splice(existingItemIndex, 1);
      applyTotals(cart);
      await cart.save();

      return cartResponse(cart, ownerToken, businessId);
    }

    const ownerToken = shopper.token ?? crypto.randomUUID();
    await Cart.findOneAndDelete({ business: businessId, ownerToken });

    return withClearedCartCookie(
      ok<CartResponseBody>({ items: [], subtotal: 0, total: 0 }),
    );
  });
}
