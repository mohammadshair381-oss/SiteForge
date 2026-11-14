import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Business-scoped discount code (lib/coupons.ts is the only writer of
 * `usedCount`). One coupon per order; coupons never stack.
 *
 * `autoIndex` is off (no automatic index builds on a persistent database):
 * the indexes below are an approved operation (docs/commerce-operations.md).
 * Code uniqueness does not depend on them: creation and renames are
 * serialised per business in a transaction (lib/coupons.ts).
 */
export const COUPON_TYPES = ["percent", "fixed"] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

export interface CouponDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  /** Upper-case code shoppers type, unique per business. */
  code: string;
  description: string;
  type: CouponType;
  /** Percent (1-100) or a fixed amount in `currency`. */
  value: number;
  /** Currency of a fixed amount and of `minSubtotal` (the business currency). */
  currency: string;
  minSubtotal: number;
  /** Largest discount on one order (percent codes mostly); null = no cap. */
  maxDiscount: number | null;
  /** What the discount applies to. Absent on older codes = everything. */
  appliesTo: "all" | "products" | "categories";
  productIds: string[];
  /** Category names, compared without case. */
  categories: string[];
  startsAt: Date | null;
  expiresAt: Date | null;
  /** Total redemptions allowed; null = unlimited. */
  usageLimit: number | null;
  /** Redemptions per customer (account, or e-mail for guests); null = unlimited. */
  perCustomerLimit: number | null;
  /** Count the delivery address as the same customer. Off by default: households share one. */
  onePerAddress?: boolean;
  /** Only signed-in customers with a confirmed email can use the code. */
  requiresAccount?: boolean;
  /** Active (not released) redemptions. */
  usedCount: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 32 },
    description: { type: String, default: "", maxlength: 160 },
    type: { type: String, enum: COUPON_TYPES, required: true },
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    minSubtotal: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: null, min: 0 },
    appliesTo: { type: String, enum: ["all", "products", "categories"], default: "all" },
    productIds: { type: [String], default: [] },
    categories: { type: [String], default: [] },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    usageLimit: { type: Number, default: null, min: 1 },
    perCustomerLimit: { type: Number, default: null, min: 1 },
    onePerAddress: { type: Boolean, default: false },
    requiresAccount: { type: Boolean, default: false },
    usedCount: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

couponSchema.index({ business: 1, code: 1 }, { unique: true });

export const Coupon: Model<CouponDoc> = (models.Coupon as Model<CouponDoc>) || model<CouponDoc>("Coupon", couponSchema);
