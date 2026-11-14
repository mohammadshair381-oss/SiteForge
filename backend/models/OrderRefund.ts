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

/**
 * The owner released a stuck Razorpay refund's hold after checking Razorpay's dashboard
 * (`recoverStuckRefund`). Written once, in the same transaction as the release, and never
 * changed afterwards: it is the record of who did it, when, why and what changed.
 */
export interface OrderRefundRecovery {
  at: Date;
  by: Types.ObjectId;
  /** The owner's own words. Shown only in the dashboard. */
  reason: string;
  previousStatus: "pending";
  resultingStatus: "failed";
  /** The order's held refund amount just before and just after the release. */
  heldBefore: number;
  heldAfter: number;
}

/**
 * What Razorpay reported about a refund AFTER its owner released the hold (lib/payments/order-refunds.ts
 * `handleLateProviderReport`). It never changes `recovery`: both stay side by side.
 * - `recorded`: Razorpay confirmed the refund was made; it is recorded as the refund `recordedAs`.
 * - `provider_failed`: Razorpay confirmed it was not made, as the owner said.
 * - `needs_review`: Razorpay reported something SiteForge could not safely record (`issue`). Nothing was
 *   decided: the owner must look at it.
 */
export interface OrderRefundLateReport {
  at: Date;
  providerRefundId: string;
  providerStatus: "pending" | "processed" | "failed";
  outcome: "recorded" | "provider_failed" | "needs_review";
  recordedAs: Types.ObjectId | null;
  issue: "provider_still_processing" | "payment_not_found" | "does_not_fit_order" | null;
}

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
  /** Set only by an owner's recovery of a stuck refund. Absent on every other refund. */
  recovery?: OrderRefundRecovery | null;
  /**
   * Set only on a released refund, when Razorpay reports on it afterwards. Bound to the first Razorpay refund
   * id reported: a report for any other id never replaces it (lib/payments/order-refunds.ts `writeLateReport`).
   */
  lateProviderReport?: OrderRefundLateReport | null;
  /** Earlier reports this one replaced, oldest first, at most 10. Never cleared. */
  lateProviderReportHistory?: OrderRefundLateReport[];
  /** On a refund recorded from such a late report: the released refund it turned out to be. */
  confirmsRecoveryOf?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const lateReportSchema = new Schema<OrderRefundLateReport>(
  {
    at: { type: Date, required: true },
    providerRefundId: { type: String, required: true, maxlength: 80 },
    providerStatus: { type: String, enum: ["pending", "processed", "failed"], required: true },
    outcome: { type: String, enum: ["recorded", "provider_failed", "needs_review"], required: true },
    recordedAs: { type: Schema.Types.ObjectId, ref: "OrderRefund", default: null },
    issue: { type: String, enum: ["provider_still_processing", "payment_not_found", "does_not_fit_order", null], default: null },
  },
  { _id: false },
);

const recoverySchema = new Schema<OrderRefundRecovery>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true, maxlength: 500 },
    previousStatus: { type: String, enum: ["pending"], required: true },
    resultingStatus: { type: String, enum: ["failed"], required: true },
    heldBefore: { type: Number, required: true, min: 0 },
    heldAfter: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

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
    // Written only together with the release, by a conditional update that needs it absent.
    recovery: { type: recoverySchema, default: null },
    lateProviderReport: { type: lateReportSchema, default: null },
    lateProviderReportHistory: { type: [lateReportSchema], default: undefined },
    confirmsRecoveryOf: { type: Schema.Types.ObjectId, ref: "OrderRefund", default: null, immutable: true },
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
