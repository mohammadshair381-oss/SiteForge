import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * One online-payment attempt for a storefront order (Razorpay Payment Link).
 * Separate from `models/Payment.ts` (subscription billing) so order payments
 * never appear in, or change, subscription billing history.
 *
 * The order is marked paid ONLY through `lib/payments/order-payments.ts`, after
 * the provider confirms the payment (signed callback + API check, or a signed
 * webhook + API check). A browser redirect alone never marks anything paid.
 *
 * Index policy: `autoIndex` / `autoCreate` OFF; the unique `{ providerLinkId: 1 }`
 * and `{ business: 1, order: 1 }` indexes are an approved operation
 * (docs/payments-architecture.md).
 */
export const ORDER_PAYMENT_STATUSES = ["created", "paid", "failed", "cancelled"] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export interface OrderPaymentDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  order: Types.ObjectId;
  provider: "razorpay";
  mode: "test" | "live";
  providerLinkId: string;
  shortUrl: string;
  providerPaymentId: string | null;
  /** Amount in the currency subunit (paise for INR), as sent to the provider. */
  amountMinor: number;
  currency: string;
  status: OrderPaymentStatus;
  lastEventId: string | null;
  paidAt: Date | null;
  /**
   * What happened to the ORDER once the provider confirmed the money:
   * "applied" (order is paid) or "needs_review" (money captured but the order
   * could not be marked paid, e.g. its reservation was already released; the
   * owner must refund or fulfil manually). null while unpaid.
   */
  orderOutcome: "applied" | "needs_review" | null;
  outcomeReason: string | null;
  /** The last declined attempt on this link. The link stays open for another try. */
  lastFailureAt: Date | null;
  /** Provider's error code only. */
  lastFailureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderPaymentSchema = new Schema<OrderPaymentDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    provider: { type: String, enum: ["razorpay"], required: true },
    mode: { type: String, enum: ["test", "live"], required: true },
    providerLinkId: { type: String, required: true, trim: true },
    shortUrl: { type: String, required: true },
    providerPaymentId: { type: String, default: null },
    amountMinor: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true },
    status: { type: String, enum: ORDER_PAYMENT_STATUSES, default: "created" },
    lastEventId: { type: String, default: null },
    paidAt: { type: Date, default: null },
    orderOutcome: { type: String, enum: ["applied", "needs_review", null], default: null },
    outcomeReason: { type: String, default: null },
    lastFailureAt: { type: Date, default: null },
    lastFailureCode: { type: String, default: null, maxlength: 80 },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false },
);

orderPaymentSchema.index({ providerLinkId: 1 }, { unique: true });
orderPaymentSchema.index({ business: 1, order: 1 });

export const OrderPayment: Model<OrderPaymentDoc> =
  (models.OrderPayment as Model<OrderPaymentDoc>) ||
  model<OrderPaymentDoc>("OrderPayment", orderPaymentSchema);
