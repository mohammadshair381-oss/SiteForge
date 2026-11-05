import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * One provider webhook delivery that was acted on, so a repeat does nothing
 * (lib/billing-razorpay.ts). Written in the same transaction as what it changed.
 *
 * `autoIndex` is off; the indexes are an approved operation
 * (docs/database-preparation.md). The unique index is what stops two concurrent
 * deliveries of one event, so it must exist before billing is switched on.
 */
export interface BillingEventDoc {
  _id: Types.ObjectId;
  provider: string;
  eventId: string;
  type: string;
  business: Types.ObjectId;
  providerSubscriptionId: string;
  outcome: string;
  remoteStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

const billingEventSchema = new Schema<BillingEventDoc>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true, maxlength: 120 },
    type: { type: String, default: "", maxlength: 60 },
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    providerSubscriptionId: { type: String, required: true, maxlength: 60 },
    outcome: { type: String, default: "", maxlength: 40 },
    remoteStatus: { type: String, default: "", maxlength: 40 },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

billingEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
billingEventSchema.index({ business: 1, createdAt: -1 });

export const BillingEvent: Model<BillingEventDoc> =
  (models.BillingEvent as Model<BillingEventDoc>) || model<BillingEventDoc>("BillingEvent", billingEventSchema);
