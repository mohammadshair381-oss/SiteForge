// @ts-nocheck
import { Schema, model, models, type Model, type Types } from "mongoose";
import { PAYMENT_STATUSES, type PaymentStatus } from "@/lib/constants";

export type PaymentDomain = "order" | "subscription";

export interface PaymentDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  subscription: Types.ObjectId | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  provider: string;
  providerEventId: string | null;
  providerPaymentId: string;
  description: string;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  paymentDomain: PaymentDomain;
  /** Refunded so far, as Razorpay reports it (BillingAdjustment has each refund). */
  refundedAmount?: number;
}

const paymentSchema = new Schema<PaymentDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    subscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      default: null,
    },
    amount: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    status: {
      type: String,
      enum: PAYMENT_STATUSES,
      default: "pending",
      index: true,
    },
    provider: { type: String, default: "manual", trim: true },
    providerEventId: { type: String, default: null },
    providerPaymentId: { type: String, default: "" },
    description: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    refundedAmount: { type: Number, default: 0, min: 0 },
    paymentDomain: {
      type: String,
      enum: ["order", "subscription"],
      default: "subscription",
    },
  },
  { timestamps: true, versionKey: false }
);

// Idempotency: a provider event can only be recorded once.
paymentSchema.index(
  { providerEventId: 1 },
  { unique: true, partialFilterExpression: { providerEventId: { $gt: "" } } }
);

// Explicit index to quickly filter payments by domain for separation of concerns.
paymentSchema.index({ business: 1, paymentDomain: 1 });

export const Payment: Model<PaymentDoc> =
  (models.Payment as Model<PaymentDoc>) ||
  model<PaymentDoc>("Payment", paymentSchema);