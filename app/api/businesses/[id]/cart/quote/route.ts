import { handle, ok, HttpError, readJson } from "@/lib/api";
import { resolveCommerceBusiness } from "@/lib/tenant";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { resolveCheckoutCustomer } from "@/lib/auth/customer-guards";
import { enforceCartReadRateLimit, enforceCouponCheckRateLimit } from "@/lib/storefront-rate-limit";
import { resolveShopperCart } from "@/lib/cart/shopper-cart";
import { SHIPPING_REFUSALS, freeShippingProgress, priceOrder, readShippingSettings, readTaxSettings, round2, type PricedLine } from "@/lib/checkout-pricing";
import { previewCoupon, type AppliedCoupon } from "@/lib/coupons";
import { effectivePrice } from "@/lib/product-variants";
import { Cart } from "@/models/Cart";
import { Product } from "@/models/Product";

/**
 * `POST { couponCode? }` — read-only price breakdown of the shopper's cart
 * (business from the Host, cart from the HttpOnly cookie): current prices,
 * coupon discount (validated, NOT consumed), shipping and total, using the
 * same rules as checkout. Checkout recomputes everything; this is a preview.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const business = await resolveCommerceBusiness(request.headers.get("host"));
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    const businessId = String(business._id);
    await enforceCartReadRateLimit(request, businessId);
    const body = (await readJson(request)) as { couponCode?: unknown; address?: { country?: unknown; region?: unknown; postalCode?: unknown } };
    const couponCode = typeof body?.couponCode === "string" && body.couponCode.trim() ? body.couponCode.trim().slice(0, 64) : "";
    const part = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
    const destination = { country: part(body?.address?.country, 60), region: part(body?.address?.region, 80), postalCode: part(body?.address?.postalCode, 20) };

    const { token } = await resolveShopperCart(request, business);
    const cart = token ? await Cart.findOne({ business: businessId, ownerToken: token }).lean() : null;
    const items = cart?.items ?? [];

    // Current prices of purchasable lines (unavailable lines are left out of
    // the preview; checkout refuses them with a clear message).
    const products = await Product.find({ _id: { $in: items.map((i) => i.product) }, business: businessId, status: "active" })
      .select("price currency category options variants")
      .lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    let subtotal = 0;
    let currency = (business.currency || "USD").toUpperCase();
    const lines: PricedLine[] = [];
    for (const item of items) {
      const product = byId.get(String(item.product));
      if (!product) continue;
      const hasVariants = (product.options ?? []).length > 0;
      const variant = hasVariants ? (product.variants ?? []).find((v) => String(v._id) === item.variant && !v.archived) : null;
      if (hasVariants && !variant) continue;
      const lineTotal = effectivePrice(product.price, variant) * item.quantity;
      subtotal += lineTotal;
      lines.push({ product: String(item.product), category: product.category ?? "", lineTotal });
      currency = (product.currency || currency).toUpperCase();
    }
    subtotal = round2(subtotal);

    const shipping = readShippingSettings(business.shippingSettings);
    let coupon: AppliedCoupon | null = null;
    let couponError: { code: string; message: string } | null = null;
    if (couponCode) {
      await enforceCouponCheckRateLimit(request, businessId);
      try {
        const signedIn = (await resolveCheckoutCustomer(request, business)).status === "customer";
        coupon = await previewCoupon({ businessId, code: couponCode, subtotal, currency, lines, signedIn });
      } catch (error) {
        if (error instanceof HttpError && error.status === 422) couponError = { code: error.code ?? "coupon_invalid", message: error.message };
        else throw error;
      }
    }
    const { shipping: shippingQuote, ...totals } = priceOrder({ subtotal, eligible: coupon?.eligible, coupon, shipping, tax: readTaxSettings(business.taxSettings), destination });
    const codTooLarge = shipping.enabled && shipping.codMaxOrder !== null && totals.total > shipping.codMaxOrder;
    const afterDiscount = round2(totals.subtotal - totals.discountTotal);
    return ok(
      {
        currency,
        ...totals,
        coupon: coupon ? { code: coupon.code, description: coupon.description } : null,
        couponError,
        shipping: {
          enabled: shipping.enabled,
          flatRate: shipping.flatRate,
          freeOver: shipping.freeOver,
          requireAddress: shipping.enabled && shipping.requireAddress,
          deliveryInfo: shippingQuote.deliveryInfo,
          deliverable: shippingQuote.deliverable,
          refusal: shippingQuote.refusal ? SHIPPING_REFUSALS[shippingQuote.refusal] : null,
          minOrder: shipping.minOrder,
          awaitingAddress: shippingQuote.awaitingAddress,
          zoneName: shippingQuote.zone?.name ?? null,
          codAvailable: shippingQuote.codAvailable && !codTooLarge,
          // Why cash on delivery is off, for a clear message: the order's size or the area.
          codRefusal: codTooLarge ? "amount" : !shippingQuote.codAvailable ? "area" : null,
          codMaxOrder: shipping.codMaxOrder,
          freeShipping: freeShippingProgress(shipping, shippingQuote, afterDiscount),
          minOrderShortfall: shippingQuote.refusal === "below_minimum" ? round2(shipping.minOrder - totals.subtotal) : 0,
          // The store's delivery area names, only once an address has been refused.
          deliveryAreas: shippingQuote.refusal === "not_deliverable" ? shipping.zones.map((zone) => zone.name) : [],
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
