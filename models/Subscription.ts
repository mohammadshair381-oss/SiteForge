import { Schema, model, models, type Model, type Types } from "mongoose";
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from "@/lib/constants";

export interface SubscriptionDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  plan: Types.ObjectId;
  status: SubscriptionStatus;
  provider: string;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** After a failed renewal, access continues until this time (lib/billing.ts). */
  graceUntil?: Date | null;
  /** The status as the provider reports it, for support and reconciliation. */
  providerStatus?: string | null;
  lastEventAt?: Date | null;
  /** When Razorpay says a scheduled plan change takes effect. */
  scheduledChangeAt?: Date | null;
  /** The payment method Razorpay reports; some cannot change plan. */
  providerPaymentMethod?: string | null;
  lastWebhookAt?: Date | null;
  /** The last comparison with Razorpay, what it did, and why it failed if it did. */
  lastReconciledAt?: Date | null;
  lastReconcileOutcome?: string | null;
  lastReconcileError?: string | null;
  /** The plan taking over at the end of this billing cycle. */
  pendingPlan?: Types.ObjectId | null;
  /** A hosted payment page in progress. The current plan is untouched until it is paid. */
  pendingCheckout?: {
    providerSubscriptionId: string;
    planId: string;
    plan: Types.ObjectId;
    amountMinor: number;
    currency: string;
    mode: "test" | "live";
    shortUrl: string;
    createdAt: Date;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<SubscriptionDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    plan: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    status: {
      type: String,
      enum: SUBSCRIPTION_STATUSES,
      default: "incomplete",
      index: true,
    },
    provider: { type: String, default: "manual", trim: true },
    providerSubscriptionId: { type: String, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    graceUntil: { type: Date, default: null },
    providerStatus: { type: String, default: null },
    lastEventAt: { type: Date, default: null },
    scheduledChangeAt: { type: Date, default: null },
    providerPaymentMethod: { type: String, default: null },
    lastWebhookAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    lastReconcileOutcome: { type: String, default: null },
    lastReconcileError: { type: String, default: null },
    pendingPlan: { type: Schema.Types.ObjectId, ref: "Plan", default: null },
    pendingCheckout: {
      type: new Schema(
        {
          providerSubscriptionId: { type: String, required: true },
          planId: { type: String, required: true },
          plan: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
          amountMinor: { type: Number, required: true },
          currency: { type: String, required: true },
          mode: { type: String, enum: ["test", "live"], required: true },
          shortUrl: { type: String, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
);

subscriptionSchema.index(
  { providerSubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSubscriptionId: { $gt: "" } },
  },
);
subscriptionSchema.index({ business: 1, status: 1 });
subscriptionSchema.index({ "pendingCheckout.providerSubscriptionId": 1 }, { sparse: true });

export const Subscription: Model<SubscriptionDoc> =
  (models.Subscription as Model<SubscriptionDoc>) ||
  model<SubscriptionDoc>("Subscription", subscriptionSchema);
