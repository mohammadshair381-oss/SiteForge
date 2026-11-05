import crypto from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/rate-limit";
import { discountFor, eligibleSubtotal, round2, type CouponTerms, type PricedLine } from "@/lib/checkout-pricing";
import { Business } from "@/models/Business";
import { Coupon, type CouponDoc } from "@/models/Coupon";
import { CouponRedemption } from "@/models/CouponRedemption";
import { Product } from "@/models/Product";

/**
 * Server-only coupon service.
 *
 * Checkout (`redeemCoupon`) runs inside the order transaction and claims a
 * use with ONE conditional `$inc` on the coupon (only while `usedCount <
 * usageLimit`). Every redemption therefore writes the coupon document, so two
 * concurrent redemptions of the same coupon conflict and MongoDB retries one
 * of them: the total and per-customer limits cannot be exceeded. Releasing an
 * unpaid order's redemption (cancel/expiry) gives the use back exactly once.
 *
 * Owner management (`createCoupon`/`updateCoupon`) serialises code changes per
 * business (a write to the business document in the same transaction), so
 * codes stay unique even before the unique index exists.
 */

export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

export function normalizeCouponCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return COUPON_CODE_PATTERN.test(code) ? code : null;
}

/**
 * One mailbox, however it is written: "+tags" are dropped everywhere, and dots too at
 * Gmail, where they are ignored. Stops the easiest way of reusing a per-customer code.
 */
export function canonicalEmail(value: string): string {
  const email = value.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  const domain = email.slice(at + 1);
  const local = email.slice(0, at).split("+")[0];
  if (domain === "gmail.com" || domain === "googlemail.com") return `${local.replace(/\./g, "")}@gmail.com`;
  return `${local}@${domain}`;
}

const digitsOf = (value: string) => value.replace(/\D/g, "");
const compact = (value: string | undefined) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Keyed and bound to one coupon: useless without the server's secret, and unlinkable across coupons. */
function keyedHash(kind: string, couponId: string, value: string): string {
  const digest = crypto.createHmac("sha256", env().SESSION_SECRET).update(`coupon-identity:${kind}:${couponId}:${value}`).digest("hex");
  return `${kind}:${digest}`;
}

export interface CouponIdentityKeys {
  phoneKey?: string;
  addressKey?: string;
}

/**
 * Other ways to recognise the same guest under a per-customer limit. Nothing is
 * collected for this: it uses what checkout already asked for, and only for codes
 * that have a limit. The phone counts when given; the address only if the owner
 * asked, because a household or an office can share one.
 */
export function couponIdentityKeys(
  coupon: { couponId: string; perCustomerLimit: number | null; onePerAddress: boolean },
  address: { phone?: string; line1?: string; line2?: string; postalCode?: string; country?: string } | null,
): CouponIdentityKeys {
  if (coupon.perCustomerLimit === null || !address) return {};
  const phone = digitsOf(address.phone ?? "");
  const place = [address.line1, address.line2, address.postalCode, address.country].map(compact).join("|");
  return {
    ...(phone.length >= 8 ? { phoneKey: keyedHash("phone", coupon.couponId, phone.slice(-10)) } : {}),
    ...(coupon.onePerAddress && compact(address.line1) ? { addressKey: keyedHash("address", coupon.couponId, place) } : {}),
  };
}

const GUEST_USES_WINDOW_MS = 60 * 60 * 1000;
const GUEST_USES_PER_SOURCE = 10;

/**
 * Guests using one limited code from one connection, per hour. High enough for an
 * office or a shared network, low enough to stop someone working through addresses.
 */
export async function assertGuestCouponPace(couponId: string, source: string): Promise<void> {
  const allowed = await checkRateLimit({ key: `coupon-guest:${couponId}:${source}`, limit: GUEST_USES_PER_SOURCE, windowMs: GUEST_USES_WINDOW_MS });
  if (!allowed) throw couponError("coupon_guest_pace");
}

/** The shopper's e-mail as a key, without storing the address. */
export function emailKeyFor(email: string): string {
  return `email:${crypto.createHash("sha256").update(canonicalEmail(email)).digest("hex")}`;
}

/** Per-customer identity without storing an e-mail address. */
export function customerKeyFor(input: { customerId?: string | null; email: string }): string {
  if (input.customerId) return `customer:${input.customerId}`;
  return emailKeyFor(input.email);
}

/** Past uses by this person, as an account or as a guest with the same e-mail. */
function usedByCustomer(couponId: unknown, customerKey: string, emailKey?: string | null, identity: CouponIdentityKeys = {}) {
  return CouponRedemption.countDocuments({
    coupon: couponId,
    status: "active",
    $or: [
      { customerKey },
      ...(emailKey ? [{ customerKey: emailKey }, { emailKey }] : []),
      ...(identity.phoneKey ? [{ phoneKey: identity.phoneKey }] : []),
      ...(identity.addressKey ? [{ addressKey: identity.addressKey }] : []),
    ],
  });
}

const SHOPPER_MESSAGES: Record<string, string> = {
  coupon_invalid: "This code is not valid.",
  coupon_not_started: "This code is not active yet.",
  coupon_expired: "This code has expired.",
  coupon_min_subtotal: "Your order is below the minimum for this code.",
  coupon_usage_limit: "This code has been fully used.",
  coupon_customer_limit: "You have already used this code.",
  coupon_currency: "This code cannot be used for this order.",
  coupon_no_eligible_items: "This code does not apply to the items in your cart.",
  coupon_account_required: "Sign in to your account to use this code.",
  coupon_guest_pace: "This code has been used too often from your connection. Try again later, or sign in to your account.",
};

function couponError(code: keyof typeof SHOPPER_MESSAGES, extra = ""): HttpError {
  return new HttpError(422, `${SHOPPER_MESSAGES[code]}${extra}`, code);
}

/** Static checks (no usage counting). Throws a shopper-safe HttpError. */
function assertApplicable(coupon: CouponDoc | null, subtotal: number, currency: string, now: Date): asserts coupon is CouponDoc {
  if (!coupon || !coupon.active) throw couponError("coupon_invalid");
  if (coupon.startsAt && coupon.startsAt.getTime() > now.getTime()) throw couponError("coupon_not_started");
  if (coupon.expiresAt && coupon.expiresAt.getTime() <= now.getTime()) throw couponError("coupon_expired");
  if (coupon.currency !== currency) throw couponError("coupon_currency");
  if (subtotal < coupon.minSubtotal) throw couponError("coupon_min_subtotal");
}

export interface AppliedCoupon extends CouponTerms {
  couponId: string;
  code: string;
  description: string;
  /** Merchandise this code applies to in this cart. */
  eligible: number;
}

/** The merchandise a code applies to; refuses a cart with none of it. */
function eligibleFor(coupon: CouponDoc, subtotal: number, lines?: readonly PricedLine[]): number {
  if (!lines) return subtotal;
  const eligible = eligibleSubtotal(lines, coupon);
  if (eligible <= 0) throw couponError("coupon_no_eligible_items");
  return eligible;
}

/** Read-only preview for the cart (no use is consumed). */
export async function previewCoupon(input: {
  businessId: string;
  code: unknown;
  subtotal: number;
  currency: string;
  lines?: readonly PricedLine[];
  customerKey?: string | null;
  emailKey?: string | null;
  /** A signed-in customer with a confirmed email is shopping. */
  signedIn?: boolean;
  now?: Date;
}): Promise<AppliedCoupon> {
  const code = normalizeCouponCode(input.code);
  if (!code) throw couponError("coupon_invalid");
  await dbConnect();
  const coupon = await Coupon.findOne({ business: input.businessId, code }).lean<CouponDoc>();
  assertApplicable(coupon, input.subtotal, input.currency, input.now ?? new Date());
  if (coupon.requiresAccount && !input.signedIn) throw couponError("coupon_account_required");
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) throw couponError("coupon_usage_limit");
  if (input.customerKey && coupon.perCustomerLimit !== null) {
    const used = await usedByCustomer(coupon._id, input.customerKey, input.emailKey);
    if (used >= coupon.perCustomerLimit) throw couponError("coupon_customer_limit");
  }
  return {
    couponId: String(coupon._id), code: coupon.code, description: coupon.description, type: coupon.type, value: coupon.value,
    maxDiscount: coupon.maxDiscount ?? null, eligible: eligibleFor(coupon, input.subtotal, input.lines),
  };
}

/**
 * Validates the code inside the caller's (order) transaction WITHOUT using it,
 * so the order total can be computed first. Call `claimCouponUse` only once
 * this request owns the new order.
 */
export async function checkCoupon(input: {
  session: mongoose.ClientSession;
  businessId: string;
  code: unknown;
  subtotal: number;
  currency: string;
  lines?: readonly PricedLine[];
  /** A signed-in customer with a confirmed email is checking out. */
  signedIn?: boolean;
  now?: Date;
}): Promise<AppliedCoupon & { perCustomerLimit: number | null; onePerAddress: boolean }> {
  const code = normalizeCouponCode(input.code);
  if (!code) throw couponError("coupon_invalid");
  const coupon = await Coupon.findOne({ business: input.businessId, code }).session(input.session).lean<CouponDoc>();
  assertApplicable(coupon, input.subtotal, input.currency, input.now ?? new Date());
  if (coupon.requiresAccount && !input.signedIn) throw couponError("coupon_account_required");
  return {
    onePerAddress: coupon.onePerAddress === true,
    couponId: String(coupon._id), code: coupon.code, description: coupon.description,
    type: coupon.type, value: coupon.value, maxDiscount: coupon.maxDiscount ?? null,
    eligible: eligibleFor(coupon, input.subtotal, input.lines), perCustomerLimit: coupon.perCustomerLimit ?? null,
  };
}

/**
 * Claims one use inside the order transaction: the single-winner conditional
 * `$inc` (also the per-coupon serialisation point), then the per-customer
 * limit. Throws a 422 HttpError; the transaction then aborts.
 */
export async function claimCouponUse(input: {
  session: mongoose.ClientSession;
  businessId: string;
  coupon: AppliedCoupon & { perCustomerLimit: number | null };
  customerKey: string;
  emailKey?: string | null;
  identity?: CouponIdentityKeys;
}): Promise<void> {
  const claimed = await Coupon.findOneAndUpdate(
    {
      _id: input.coupon.couponId,
      business: input.businessId,
      active: true,
      $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }],
    },
    { $inc: { usedCount: 1 } },
    { session: input.session, new: true },
  );
  if (!claimed) throw couponError("coupon_usage_limit");
  if (input.coupon.perCustomerLimit !== null) {
    const used = await usedByCustomer(input.coupon.couponId, input.customerKey, input.emailKey, input.identity).session(input.session);
    if (used >= input.coupon.perCustomerLimit) throw couponError("coupon_customer_limit");
  }
}

export async function recordRedemption(input: {
  session: mongoose.ClientSession;
  businessId: string;
  coupon: AppliedCoupon;
  orderId: unknown;
  customerKey: string;
  emailKey?: string | null;
  identity?: CouponIdentityKeys;
  amount: number;
  currency: string;
}): Promise<void> {
  await CouponRedemption.create(
    [
      {
        business: input.businessId,
        coupon: input.coupon.couponId,
        order: input.orderId,
        customerKey: input.customerKey,
        ...(input.emailKey ? { emailKey: input.emailKey } : {}),
        ...(input.identity ?? {}),
        amount: input.amount,
        currency: input.currency,
        status: "active",
      },
    ],
    { session: input.session },
  );
}

/**
 * Gives the use back when an unpaid order is cancelled or expires. Runs in
 * the same transaction as the order's release; idempotent (only an active
 * redemption is released, so the count is decremented at most once).
 */
export async function releaseRedemption(order: { _id: unknown; discount?: { coupon?: string } | null }, session: mongoose.ClientSession): Promise<void> {
  if (!order.discount?.coupon) return;
  const released = await CouponRedemption.findOneAndUpdate(
    { order: order._id, status: "active" },
    { $set: { status: "released" } },
    { session },
  );
  if (released) {
    await Coupon.updateOne({ _id: released.coupon, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
  }
}

// ---------------------------------------------------------------------------
// Owner management
// ---------------------------------------------------------------------------

const dateInput = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : new Date(String(value))),
  z.date().nullable(),
);
const limitInput = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? null : Number(value)),
  z.number().int().min(1).max(1_000_000).nullable(),
);

export const couponInputSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(COUPON_CODE_PATTERN, "Use 3-32 letters, numbers, - or _"),
    description: z.string().trim().max(160).refine((v) => !/[<>]/.test(v), "Use plain text").prefault(""),
    type: z.enum(["percent", "fixed"]),
    value: z.coerce.number().positive().max(1_000_000),
    minSubtotal: z.coerce.number().min(0).max(10_000_000).prefault(0),
    maxDiscount: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : Number(value)), z.number().positive().max(10_000_000).nullable()).prefault(null),
    appliesTo: z.enum(["all", "products", "categories"]).prefault("all"),
    productIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(200).prefault([]),
    categories: z.array(z.string().trim().min(1).max(80)).max(100).prefault([]),
    startsAt: dateInput.prefault(null),
    expiresAt: dateInput.prefault(null),
    usageLimit: limitInput.prefault(null),
    perCustomerLimit: limitInput.prefault(null),
    onePerAddress: z.boolean().prefault(false),
    requiresAccount: z.boolean().prefault(false),
    active: z.boolean().prefault(true),
  })
  .superRefine((v, ctx) => {
    if (v.type === "percent" && v.value > 100) ctx.addIssue({ code: "custom", message: "A percentage is at most 100", path: ["value"] });
    if (v.startsAt && v.expiresAt && v.expiresAt <= v.startsAt) ctx.addIssue({ code: "custom", message: "The end must be after the start", path: ["expiresAt"] });
    if (v.appliesTo === "products" && v.productIds.length === 0) ctx.addIssue({ code: "custom", message: "Choose at least one product", path: ["productIds"] });
    if (v.appliesTo === "categories" && v.categories.length === 0) ctx.addIssue({ code: "custom", message: "Choose at least one category", path: ["categories"] });
  });
export type CouponInput = z.infer<typeof couponInputSchema>;

export interface CouponView {
  id: string;
  code: string;
  description: string;
  type: "percent" | "fixed";
  value: number;
  currency: string;
  minSubtotal: number;
  maxDiscount: number | null;
  onePerAddress: boolean;
  requiresAccount: boolean;
  appliesTo: "all" | "products" | "categories";
  productIds: string[];
  categories: string[];
  startsAt: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  active: boolean;
}

function toView(c: CouponDoc): CouponView {
  return {
    id: String(c._id), code: c.code, description: c.description ?? "", type: c.type, value: c.value, currency: c.currency,
    minSubtotal: c.minSubtotal ?? 0, maxDiscount: c.maxDiscount ?? null, appliesTo: c.appliesTo ?? "all", productIds: (c.productIds ?? []).map(String), categories: c.categories ?? [], startsAt: c.startsAt ? c.startsAt.toISOString() : null, expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    onePerAddress: c.onePerAddress === true, requiresAccount: c.requiresAccount === true,
    usageLimit: c.usageLimit ?? null, perCustomerLimit: c.perCustomerLimit ?? null, usedCount: c.usedCount ?? 0, active: c.active,
  };
}

export async function listCoupons(businessId: string): Promise<CouponView[]> {
  await dbConnect();
  const rows = await Coupon.find({ business: businessId }).sort({ createdAt: -1 }).limit(500).lean<CouponDoc[]>();
  return rows.map(toView);
}

/** Serialise code changes per business inside the transaction. */
async function lockBusiness(businessId: string, session: mongoose.ClientSession): Promise<{ currency: string }> {
  const business = await Business.findOneAndUpdate(
    { _id: businessId },
    { $set: { updatedAt: new Date() } },
    { session, timestamps: false, new: true, projection: { currency: 1 } },
  ).lean<{ currency?: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  return { currency: (business.currency || "USD").toUpperCase() };
}

/** A code can only name this business's own products. */
async function assertProductsOwned(businessId: string, productIds: readonly string[]): Promise<void> {
  if (productIds.length === 0) return;
  const found = await Product.countDocuments({ _id: { $in: productIds }, business: businessId });
  if (found !== new Set(productIds).size) throw new HttpError(422, "One of the chosen products does not belong to this store.", "invalid_coupon_products");
}

export async function createCoupon(businessId: string, input: unknown): Promise<CouponView> {
  const data = couponInputSchema.parse(input);
  await dbConnect();
  await assertProductsOwned(businessId, data.productIds);
  const session = await mongoose.startSession();
  let created: CouponDoc | null = null;
  try {
    await session.withTransaction(async () => {
      const { currency } = await lockBusiness(businessId, session);
      if (await Coupon.exists({ business: businessId, code: data.code }).session(session)) {
        throw new HttpError(409, "A coupon with this code already exists", "coupon_code_taken");
      }
      const [doc] = await Coupon.create([{ ...data, business: businessId, currency, usedCount: 0 }], { session });
      created = doc.toObject() as CouponDoc;
    });
  } finally {
    await session.endSession();
  }
  return toView(created as unknown as CouponDoc);
}

export async function updateCoupon(businessId: string, couponId: string, input: unknown): Promise<CouponView> {
  const data = couponInputSchema.parse(input);
  await dbConnect();
  await assertProductsOwned(businessId, data.productIds);
  const session = await mongoose.startSession();
  let updated: CouponDoc | null = null;
  try {
    await session.withTransaction(async () => {
      await lockBusiness(businessId, session);
      if (await Coupon.exists({ business: businessId, code: data.code, _id: { $ne: couponId } }).session(session)) {
        throw new HttpError(409, "A coupon with this code already exists", "coupon_code_taken");
      }
      // usedCount and currency are never set from input.
      updated = await Coupon.findOneAndUpdate({ _id: couponId, business: businessId }, { $set: data }, { session, new: true }).lean<CouponDoc>();
      if (!updated) throw new HttpError(404, "Coupon not found", "not_found");
    });
  } finally {
    await session.endSession();
  }
  return toView(updated as unknown as CouponDoc);
}

/** Discount the coupon would give on a subtotal (for previews). */
export function couponDiscount(subtotal: number, coupon: CouponTerms): number {
  return round2(discountFor(subtotal, coupon));
}
