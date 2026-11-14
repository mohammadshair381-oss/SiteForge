import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * A provider-reported dispute (chargeback, retrieval request, …) on a storefront
 * order payment made through the business's own Razorpay account.
 *
 * - Created and updated ONLY from Razorpay data: a signed webhook triggers a
 *   re-read of the dispute from the Razorpay API (lib/payments/disputes.ts).
 *   Nothing in SiteForge invents a dispute, changes its status, or marks
 *   anything refunded.
 * - Always tied to an existing `OrderPayment` of the SAME business (matched by
 *   the provider payment id); a dispute for an unknown payment is not stored.
 * - `history` is append-only (provider status changes and super-admin notes).
 *
 * Index policy: `autoIndex` / `autoCreate` OFF; the unique
 * `{ providerDisputeId: 1 }` and `{ business: 1, createdAt: -1 }` indexes are
 * an approved operation (docs/payments-architecture.md).
 */
export const DISPUTE_STATUSES = ["open", "under_review", "won", "lost", "closed"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const OPEN_DISPUTE_STATUSES: readonly DisputeStatus[] = ["open", "under_review"];

export const DISPUTE_HISTORY_MAX = 200;

export interface DisputeHistoryEntry {
  at: Date;
  source: "provider" | "admin";
  status: DisputeStatus | null;
  phase: string | null;
  eventId: string | null;
  /** Internal note (admin entries only). */
  note: string | null;
  actor: Types.ObjectId | null;
}

export interface PaymentDisputeDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  orderPayment: Types.ObjectId;
  order: Types.ObjectId;
  provider: "razorpay";
  mode: "test" | "live";
  providerDisputeId: string;
  providerPaymentId: string;
  amountMinor: number;
  amountDeductedMinor: number;
  currency: string;
  reasonCode: string;
  phase: string;
  status: DisputeStatus;
  respondBy: Date | null;
  openedAt: Date | null;
  closedAt: Date | null;
  lastSyncedAt: Date;
  history: DisputeHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<DisputeHistoryEntry>(
  {
    at: { type: Date, required: true },
    source: { type: String, enum: ["provider", "admin"], required: true },
    status: { type: String, enum: [...DISPUTE_STATUSES, null], default: null },
    phase: { type: String, default: null, maxlength: 40 },
    eventId: { type: String, default: null, maxlength: 100 },
    note: { type: String, default: null, maxlength: 1000 },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false },
);

const paymentDisputeSchema = new Schema<PaymentDisputeDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    orderPayment: { type: Schema.Types.ObjectId, ref: "OrderPayment", required: true, immutable: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true, immutable: true },
    provider: { type: String, enum: ["razorpay"], required: true, immutable: true },
    mode: { type: String, enum: ["test", "live"], required: true },
    providerDisputeId: { type: String, required: true, immutable: true, maxlength: 60 },
    providerPaymentId: { type: String, required: true, immutable: true, maxlength: 60 },
    amountMinor: { type: Number, required: true, min: 0 },
    amountDeductedMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true },
    reasonCode: { type: String, default: "", maxlength: 100 },
    phase: { type: String, default: "", maxlength: 40 },
    status: { type: String, enum: DISPUTE_STATUSES, required: true },
    respondBy: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, required: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false },
);

paymentDisputeSchema.index({ providerDisputeId: 1 }, { unique: true });
paymentDisputeSchema.index({ business: 1, createdAt: -1 });

export const PaymentDispute: Model<PaymentDisputeDoc> =
  (models.PaymentDispute as Model<PaymentDisputeDoc>) ||
  model<PaymentDisputeDoc>("PaymentDispute", paymentDisputeSchema);
