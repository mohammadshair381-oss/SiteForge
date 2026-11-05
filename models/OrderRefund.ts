import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * One refund of a storefront order. Written only by lib/payments/order-refunds.ts.
 *
 * - `razorpay`: requested from the business's own Razorpay account. Settled only
 *   from Razorpay's answer, re-read from its API, never from a browser.
 * - `manual`: the owner records money returned outside SiteForge. No money moves.
 *
 * `autoIndex` is off; the indexes are an approved operation
 * (docs/database-preparation.md). A refund's `idempotencyKey` is what makes a retry
 * after a lost response safe: Razorpay treats the same key as the same refund.
 */
export const ORDER_REFUND_STATUSES = ["pending", "processed", "failed"] as const;
export type OrderRefundStatus = (typeof ORDER_REFUND_STATUSES)[number];

export interface OrderRefundDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  order: Types.ObjectId;
  provider: "razorpay" | "manual";
  mode: "test" | "live" | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  idempotencyKey: string;
  /** Major units, in the order's currency. */
  amount: number;
  amountMinor: number;
  currency: string;
  status: OrderRefundStatus;
  /** Owner's own words, shown only in the dashboard. */
  reason: string;
  /** Put the order's items back into stock once this refund settles. */
  restock: boolean;
  /** Provider's error code only, never a provider message. */
  failureCode: string | null;
  /** Null when Razorpay reported a refund started in its own dashboard. */
  createdBy: Types.ObjectId | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderRefundSchema = new Schema<OrderRefundDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true, immutable: true },
    provider: { type: String, enum: ["razorpay", "manual"], required: true, immutable: true },
    mode: { type: String, enum: ["test", "live", null], default: null, immutable: true },
    providerPaymentId: { type: String, default: null },
    providerRefundId: { type: String, default: null },
    idempotencyKey: { type: String, required: true, immutable: true },
    amount: { type: Number, required: true, min: 0.01, immutable: true },
    amountMinor: { type: Number, required: true, min: 1, immutable: true },
    currency: { type: String, required: true, uppercase: true, immutable: true },
    status: { type: String, enum: ORDER_REFUND_STATUSES, default: "pending" },
    reason: { type: String, default: "", maxlength: 200 },
    restock: { type: Boolean, default: false },
    failureCode: { type: String, default: null, maxlength: 80 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

orderRefundSchema.index({ business: 1, order: 1, createdAt: -1 });
orderRefundSchema.index(
  { providerRefundId: 1 },
  { unique: true, partialFilterExpression: { providerRefundId: { $type: "string" } } },
);

export const OrderRefund: Model<OrderRefundDoc> =
  (models.OrderRefund as Model<OrderRefundDoc>) || model<OrderRefundDoc>("OrderRefund", orderRefundSchema);
