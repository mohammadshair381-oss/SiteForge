import { Schema, model, models, type Model, type Types } from "mongoose";
import type { EncryptedValue } from "@/lib/payments/credentials-crypto";

/**
 * A business's OWN online-payment provider account (Razorpay). The business is
 * the merchant; SiteForge never holds the funds. See
 * docs/payments-architecture.md.
 *
 * Secrets are stored only encrypted (lib/payments/credentials-crypto.ts),
 * `select: false`, and removed from JSON. APIs expose at most
 * `{ connected, provider, mode, keyId, status }`.
 *
 * Index policy: `autoIndex` and `autoCreate` are OFF (like Customer). The
 * unique `{ business: 1, provider: 1 }` index is created by an approved
 * operation (docs/payments-architecture.md); the code also upserts by
 * (business, provider), so one account per business and provider is the
 * normal case even before the index exists.
 */
export const ORDER_PAYMENT_PROVIDERS = ["razorpay"] as const;
export type OrderPaymentProvider = (typeof ORDER_PAYMENT_PROVIDERS)[number];
export const PAYMENT_ACCOUNT_MODES = ["test", "live"] as const;
export type PaymentAccountMode = (typeof PAYMENT_ACCOUNT_MODES)[number];

export interface BusinessPaymentAccountDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  provider: OrderPaymentProvider;
  mode: PaymentAccountMode;
  status: "active" | "disabled";
  keyId: string;
  keySecretEnc?: EncryptedValue;
  webhookSecretEnc?: EncryptedValue;
  connectedAt: Date;
  rotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const encryptedValueSchema = new Schema(
  { v: Number, iv: String, tag: String, ct: String },
  { _id: false },
);

const businessPaymentAccountSchema = new Schema<BusinessPaymentAccountDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    provider: { type: String, enum: ORDER_PAYMENT_PROVIDERS, required: true },
    mode: { type: String, enum: PAYMENT_ACCOUNT_MODES, required: true, default: "test" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    keyId: { type: String, required: true, trim: true, maxlength: 100 },
    keySecretEnc: { type: encryptedValueSchema, select: false },
    webhookSecretEnc: { type: encryptedValueSchema, select: false },
    connectedAt: { type: Date, required: true },
    rotatedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.keySecretEnc;
        delete ret.webhookSecretEnc;
        return ret;
      },
    },
  },
);

businessPaymentAccountSchema.index({ business: 1, provider: 1 }, { unique: true });

export const BusinessPaymentAccount: Model<BusinessPaymentAccountDoc> =
  (models.BusinessPaymentAccount as Model<BusinessPaymentAccountDoc>) ||
  model<BusinessPaymentAccountDoc>("BusinessPaymentAccount", businessPaymentAccountSchema);
