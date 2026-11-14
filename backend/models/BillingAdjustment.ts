import { Schema, model, models, type Model, type Types } from "mongoose";

export const BILLING_ADJUSTMENT_KINDS = ["refund", "dispute"] as const;
export type BillingAdjustmentKind = (typeof BILLING_ADJUSTMENT_KINDS)[number];

/**
 * A refund or dispute on a SUBSCRIPTION payment, as Razorpay reports it
 * (lib/billing-razorpay.ts). Store-order refunds and disputes are separate records
 * (`OrderRefund`, `PaymentDispute`). These are made in Razorpay's dashboard, so this
 * record only reflects them, and never changes a store's access by itself.
 *
 * `autoIndex` is off; the indexes are an approved operation
 * (docs/database-preparation.md).
 */
export interface BillingAdjustmentDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  subscription: Types.ObjectId | null;
  payment: Types.ObjectId;
  providerPaymentId: string;
  kind: BillingAdjustmentKind;
  providerId: string;
  amountMinor: number;
  currency: string;
  /** As Razorpay reports it. */
  status: string;
  reasonCode: string;
  respondBy: Date | null;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const billingAdjustmentSchema = new Schema<BillingAdjustmentDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    subscription: { type: Schema.Types.ObjectId, ref: "Subscription", default: null },
    payment: { type: Schema.Types.ObjectId, ref: "Payment", required: true },
    providerPaymentId: { type: String, required: true, maxlength: 60 },
    kind: { type: String, enum: BILLING_ADJUSTMENT_KINDS, required: true },
    providerId: { type: String, required: true, maxlength: 60 },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, required: true, maxlength: 40 },
    reasonCode: { type: String, default: "", maxlength: 80 },
    respondBy: { type: Date, default: null },
    lastSyncedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false },
);

// Partial so a record with no provider id could never collide with another. The app always
// has one (`required` above, from a validated webhook id), but upserts skip validators.
// `$gt: ""` rather than `$type`, so an equality lookup on a real id can use this index.
billingAdjustmentSchema.index({ kind: 1, providerId: 1 }, { unique: true, partialFilterExpression: { providerId: { $gt: "" } } });
billingAdjustmentSchema.index({ business: 1, createdAt: -1 });
billingAdjustmentSchema.index({ payment: 1, kind: 1 });

export const BillingAdjustment: Model<BillingAdjustmentDoc> =
  (models.BillingAdjustment as Model<BillingAdjustmentDoc>) || model<BillingAdjustmentDoc>("BillingAdjustment", billingAdjustmentSchema);
