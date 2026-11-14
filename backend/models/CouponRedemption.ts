import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * One use of a coupon by one order, written in the order's creation
 * transaction. `customerKey` identifies the shopper for per-customer limits
 * without storing an e-mail address: `customer:<id>` for a signed-in
 * storefront customer, else `email:<sha256 of the normalised e-mail>`.
 * Released (not deleted) when the unpaid order is cancelled or expires.
 *
 * `autoIndex` is off; see docs/commerce-operations.md.
 */
export interface CouponRedemptionDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  coupon: Types.ObjectId;
  order: Types.ObjectId;
  customerKey: string;
  /**
   * Hash of the shopper's e-mail on every new redemption, so one person cannot use
   * a per-customer code again by checking out as a guest with their account e-mail.
   * Absent on older records.
   */
  emailKey?: string;
  /**
   * Keyed hashes of the phone and delivery address, for per-customer limits only.
   * Each is bound to this coupon, so they cannot be reversed from the database alone
   * or used to link one person's orders across coupons. Absent when not needed.
   */
  phoneKey?: string;
  addressKey?: string;
  amount: number;
  currency: string;
  status: "active" | "released";
  createdAt: Date;
  updatedAt: Date;
}

const couponRedemptionSchema = new Schema<CouponRedemptionDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    coupon: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    customerKey: { type: String, required: true, maxlength: 80 },
    emailKey: { type: String, maxlength: 80 },
    phoneKey: { type: String, maxlength: 80 },
    addressKey: { type: String, maxlength: 80 },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    status: { type: String, enum: ["active", "released"], default: "active" },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

couponRedemptionSchema.index({ coupon: 1, customerKey: 1, status: 1 });
couponRedemptionSchema.index({ order: 1 });
couponRedemptionSchema.index({ coupon: 1, emailKey: 1, status: 1 });
couponRedemptionSchema.index({ coupon: 1, phoneKey: 1, status: 1 });
couponRedemptionSchema.index({ coupon: 1, addressKey: 1, status: 1 });

export const CouponRedemption: Model<CouponRedemptionDoc> =
  (models.CouponRedemption as Model<CouponRedemptionDoc>) ||
  model<CouponRedemptionDoc>("CouponRedemption", couponRedemptionSchema);
