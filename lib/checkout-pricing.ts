import { z } from "zod";

/**
 * Checkout money rules (pure; shared by checkout, the cart quote, the
 * dashboard and tests). The order total is ALWAYS computed on the server:
 *
 *   discount = coupon on the eligible merchandise (never more than it, nor its cap)
 *   shipping = the delivery zone's rate, else the flat rate, free at or above
 *              `freeOver` (after the discount)
 *   tax      = store rate on goods after discount (and shipping when configured)
 *   total    = subtotal - discount + shipping + tax (prices without tax), or
 *              subtotal - discount + shipping (tax already in the prices)
 *
 * Amounts are rounded to 2 decimals at every step.
 */

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const plain = (max: number) => z.string().trim().max(max).refine((v) => !/[<>\u0000-\u001f]/.test(v), "Use plain text");

/**
 * A delivery area with its own charge. An empty list means "any": a zone with no
 * countries, regions or postal codes matches every address. The first match wins.
 */
export const shippingZoneSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: plain(80).pipe(z.string().min(1, "Name this delivery area")),
  countries: z.array(plain(60)).max(50).prefault([]),
  regions: z.array(plain(80)).max(100).prefault([]),
  postalPrefixes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9 -]{1,12}$/, "Postal codes use letters, numbers, spaces or -")).max(200).prefault([]),
  rate: z.number().min(0).max(100_000).prefault(0),
  freeOver: z.number().min(0).max(10_000_000).nullable().prefault(null),
  deliveryInfo: plain(200).prefault(""),
  /** Whether cash on delivery can be chosen for addresses in this area. */
  codAvailable: z.boolean().prefault(true),
});
export type ShippingZone = z.infer<typeof shippingZoneSchema>;

export const shippingSettingsSchema = z.object({
  /** Charge shipping and collect a delivery address at checkout. */
  enabled: z.boolean().prefault(false),
  flatRate: z.number().min(0).max(100_000).prefault(0),
  /** Free shipping at or above this order amount; null = never free. */
  freeOver: z.number().min(0).max(10_000_000).nullable().prefault(null),
  requireAddress: z.boolean().prefault(true),
  /** Shown at checkout and on product pages, e.g. "Delivered in 3-5 days". */
  deliveryInfo: plain(500).prefault(""),
  /** Delivery areas, used only with the address step. */
  zones: z.array(shippingZoneSchema).max(30).prefault([]),
  /** Addresses outside every zone: charge the flat rate, or refuse delivery. */
  shipElsewhere: z.boolean().prefault(true),
  /** Smallest order the store accepts, checked on the merchandise before discount. */
  minOrder: z.number().min(0).max(10_000_000).prefault(0),
  /** Largest order that can be paid by cash on delivery; null = no limit. */
  codMaxOrder: z.number().min(0).max(10_000_000).nullable().prefault(null),
});
export type ShippingSettings = z.infer<typeof shippingSettingsSchema>;

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = shippingSettingsSchema.parse({});

/** Stored settings, defensively: anything invalid means "no shipping". */
export function readShippingSettings(value: unknown): ShippingSettings {
  const parsed = shippingSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_SHIPPING_SETTINGS;
}

export function addressRequired(settings: ShippingSettings): boolean {
  return settings.enabled && settings.requireAddress;
}

/** Where an order goes, for working out its shipping. Partial while the shopper types. */
export interface ShippingDestination {
  country?: string;
  region?: string;
  postalCode?: string;
}

const norm = (value: string | undefined) => (value ?? "").trim().toLowerCase();
const postal = (value: string | undefined) => (value ?? "").replace(/\s+/g, "").toUpperCase();

/** The first zone an address falls in, or null. */
export function matchShippingZone(settings: ShippingSettings, destination: ShippingDestination): ShippingZone | null {
  for (const zone of settings.zones) {
    if (zone.countries.length > 0 && !zone.countries.some((c) => norm(c) === norm(destination.country))) continue;
    if (zone.regions.length > 0 && !zone.regions.some((r) => norm(r) === norm(destination.region))) continue;
    if (zone.postalPrefixes.length > 0 && !zone.postalPrefixes.some((p) => postal(destination.postalCode).startsWith(postal(p)))) continue;
    return zone;
  }
  return null;
}

export interface ShippingQuote {
  /** False when this order cannot be delivered: see `refusal`. */
  deliverable: boolean;
  refusal: "below_minimum" | "not_deliverable" | null;
  amount: number;
  /** Zones exist but the address is not complete yet, so `amount` is provisional. */
  awaitingAddress: boolean;
  zone: ShippingZone | null;
  deliveryInfo: string;
  codAvailable: boolean;
}

/**
 * Shipping for an order. `merchandise` is before discount (the minimum order) and
 * `afterDiscount` is what free shipping is checked against. Pure, so the cart preview
 * and the order use exactly the same answer.
 */
export function quoteShipping(settings: ShippingSettings, merchandise: number, afterDiscount: number, destination?: ShippingDestination | null): ShippingQuote {
  const base = { zone: null, deliveryInfo: settings.deliveryInfo, codAvailable: true, awaitingAddress: false };
  if (!settings.enabled) return { ...base, deliverable: true, refusal: null, amount: 0 };
  if (settings.minOrder > 0 && merchandise < settings.minOrder) {
    return { ...base, deliverable: false, refusal: "below_minimum", amount: 0 };
  }
  const usesZones = addressRequired(settings) && settings.zones.length > 0;
  if (usesZones) {
    const complete = Boolean(norm(destination?.country) && postal(destination?.postalCode));
    if (!complete) return { ...base, deliverable: true, refusal: null, amount: 0, awaitingAddress: true };
    const zone = matchShippingZone(settings, destination as ShippingDestination);
    if (zone) {
      const free = zone.freeOver !== null && afterDiscount >= zone.freeOver;
      return { ...base, deliverable: true, refusal: null, amount: free ? 0 : round2(zone.rate), zone, deliveryInfo: zone.deliveryInfo || settings.deliveryInfo, codAvailable: zone.codAvailable };
    }
    if (!settings.shipElsewhere) return { ...base, deliverable: false, refusal: "not_deliverable", amount: 0 };
  }
  return { ...base, deliverable: true, refusal: null, amount: shippingFor(settings, afterDiscount) };
}

export const SHIPPING_REFUSALS = {
  below_minimum: "Your order is below this store's minimum order amount.",
  not_deliverable: "This store does not deliver to that address.",
} as const;

export const shippingAddressSchema = z.object({
  name: plain(100).pipe(z.string().min(1, "Enter the recipient's name")),
  line1: plain(160).pipe(z.string().min(1, "Enter the street address")),
  line2: plain(160).prefault(""),
  city: plain(80).pipe(z.string().min(1, "Enter the city")),
  region: plain(80).prefault(""),
  postalCode: plain(20).pipe(z.string().min(1, "Enter the postal code")),
  country: plain(60).pipe(z.string().min(1, "Enter the country")),
  phone: plain(30).refine((v) => v === "" || /^[+0-9 ()-]{5,30}$/.test(v), "Enter a valid phone number").prefault(""),
});
export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

/**
 * A guest paying cash on delivery: the store has only this to reach them with, so the
 * address and a phone number are both required, whatever the shipping settings say.
 */
export const guestCodAddressSchema = shippingAddressSchema.superRefine((address, ctx) => {
  if (address.phone.replace(/\D/g, "").length < 7) {
    ctx.addIssue({ code: "custom", message: "Enter a phone number so the store can confirm your delivery", path: ["phone"] });
  }
});

export interface FreeShippingProgress {
  threshold: number;
  /** How much more merchandise reaches it; 0 once it has. */
  remaining: number;
}

/** How far an order is from free delivery, or null when this store or area has none. */
export function freeShippingProgress(settings: ShippingSettings, quote: Pick<ShippingQuote, "zone" | "awaitingAddress">, afterDiscount: number): FreeShippingProgress | null {
  if (!settings.enabled) return null;
  const threshold = quote.zone ? quote.zone.freeOver : quote.awaitingAddress ? null : settings.freeOver;
  if (threshold === null) return null;
  return { threshold, remaining: Math.max(0, round2(threshold - afterDiscount)) };
}

export interface CouponTerms {
  type: "percent" | "fixed";
  value: number;
  /** Largest discount this code gives on one order; null/absent = no cap. */
  maxDiscount?: number | null;
}

/** A coupon's discount on the merchandise it applies to. */
export function discountFor(subtotal: number, coupon: CouponTerms | null): number {
  if (!coupon || subtotal <= 0) return 0;
  const raw = coupon.type === "percent" ? (subtotal * Math.min(Math.max(coupon.value, 0), 100)) / 100 : coupon.value;
  const capped = typeof coupon.maxDiscount === "number" ? Math.min(raw, coupon.maxDiscount) : raw;
  return round2(Math.min(Math.max(capped, 0), subtotal));
}

/** One priced line, for coupon eligibility. */
export interface PricedLine {
  product: string;
  category: string;
  lineTotal: number;
}

export interface CouponScope {
  appliesTo?: "all" | "products" | "categories" | null;
  productIds?: readonly string[] | null;
  categories?: readonly string[] | null;
}

/** The part of the merchandise a coupon applies to. */
export function eligibleSubtotal(lines: readonly PricedLine[], scope: CouponScope): number {
  const applies = scope.appliesTo ?? "all";
  const products = new Set((scope.productIds ?? []).map(String));
  const categories = new Set((scope.categories ?? []).map((c) => c.trim().toLowerCase()));
  let total = 0;
  for (const line of lines) {
    const eligible = applies === "all" || (applies === "products" ? products.has(String(line.product)) : categories.has(line.category.trim().toLowerCase()));
    if (eligible) total += line.lineTotal;
  }
  return round2(total);
}

export const taxSettingsSchema = z.object({
  enabled: z.boolean().prefault(false),
  /** What the tax is called on receipts, such as GST or VAT. */
  label: plain(40).pipe(z.string().min(1)).prefault("Tax"),
  /** Percent, such as 18 for 18%. */
  rate: z.number().min(0).max(100).prefault(0),
  /** Prices already include this tax (shown, not added). */
  inclusive: z.boolean().prefault(true),
  /** Charge it on shipping as well as goods. */
  applyToShipping: z.boolean().prefault(false),
});
export type TaxSettings = z.infer<typeof taxSettingsSchema>;

/** Stored settings, defensively: anything invalid means "no tax". */
export function readTaxSettings(value: unknown): TaxSettings {
  const parsed = taxSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : taxSettingsSchema.parse({});
}

export function taxFor(settings: TaxSettings, goodsAfterDiscount: number, shipping: number): number {
  if (!settings.enabled || settings.rate <= 0) return 0;
  const base = goodsAfterDiscount + (settings.applyToShipping ? shipping : 0);
  if (base <= 0) return 0;
  const rate = settings.rate / 100;
  return round2(settings.inclusive ? base - base / (1 + rate) : base * rate);
}

export function shippingFor(settings: ShippingSettings, merchandise: number): number {
  if (!settings.enabled) return 0;
  if (settings.freeOver !== null && merchandise >= settings.freeOver) return 0;
  return round2(settings.flatRate);
}

export interface Totals {
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  total: number;
}

export interface OrderTotals extends Totals {
  taxTotal: number;
  taxInclusive: boolean;
  taxLabel: string;
  shipping: ShippingQuote;
}

/** The full order calculation: the cart preview and checkout both use only this. */
export function priceOrder(input: {
  subtotal: number;
  /** Merchandise the coupon applies to; absent = all of it. */
  eligible?: number;
  coupon: CouponTerms | null;
  shipping: ShippingSettings;
  tax: TaxSettings;
  destination?: ShippingDestination | null;
}): OrderTotals {
  const subtotal = round2(input.subtotal);
  const discountTotal = discountFor(input.eligible ?? subtotal, input.coupon);
  const goods = round2(subtotal - discountTotal);
  const shipping = quoteShipping(input.shipping, subtotal, goods, input.destination);
  const taxTotal = taxFor(input.tax, goods, shipping.amount);
  const added = input.tax.enabled && !input.tax.inclusive ? taxTotal : 0;
  return {
    subtotal,
    discountTotal,
    shippingTotal: shipping.amount,
    taxTotal,
    taxInclusive: input.tax.inclusive,
    taxLabel: input.tax.label,
    shipping,
    total: round2(goods + shipping.amount + added),
  };
}

export function computeTotals(subtotal: number, coupon: CouponTerms | null, settings: ShippingSettings): Totals {
  const sub = round2(subtotal);
  const discountTotal = discountFor(sub, coupon);
  const shippingTotal = shippingFor(settings, round2(sub - discountTotal));
  return { subtotal: sub, discountTotal, shippingTotal, total: round2(sub - discountTotal + shippingTotal) };
}
