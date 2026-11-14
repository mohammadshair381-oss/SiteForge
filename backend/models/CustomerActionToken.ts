import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Single-use action tokens for storefront CUSTOMER accounts (email
 * verification, password reset). Deliberately separate from the platform
 * `AuthToken` model, which belongs to platform users: a customer token always
 * names its customer AND its business, and is only ever consumed with both.
 *
 * - Only the SHA-256 hash of the raw token is stored (`select: false`); the raw
 *   value exists only in the emailed link.
 * - Consumption is one conditional `findOneAndUpdate` (usedAt null, not
 *   expired, same business and type), so a token can succeed at most once.
 * - Expiry is always checked explicitly; the TTL index is cleanup only.
 *
 * Index policy: `autoIndex` and `autoCreate` are OFF, like `Customer`. The
 * declared indexes must be created by an approved operation before customer
 * accounts go live (docs/customer-accounts.md).
 */
export const CUSTOMER_TOKEN_TYPES = ["email_verification", "password_reset"] as const;
export type CustomerTokenType = (typeof CUSTOMER_TOKEN_TYPES)[number];

export interface CustomerActionTokenDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  customer: Types.ObjectId;
  type: CustomerTokenType;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const customerActionTokenSchema = new Schema<CustomerActionTokenDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    customer: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    type: { type: String, enum: CUSTOMER_TOKEN_TYPES, required: true },
    tokenHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.tokenHash;
        return ret;
      },
    },
  },
);

customerActionTokenSchema.index({ tokenHash: 1 }, { unique: true });
customerActionTokenSchema.index({ business: 1, customer: 1, type: 1 });
customerActionTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CustomerActionToken: Model<CustomerActionTokenDoc> =
  (models.CustomerActionToken as Model<CustomerActionTokenDoc>) ||
  model<CustomerActionTokenDoc>("CustomerActionToken", customerActionTokenSchema);
