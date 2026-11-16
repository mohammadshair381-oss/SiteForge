import { Schema, model, models, type Model } from "mongoose";
import type { EncryptedValue } from "@/lib/payments/credentials-crypto";

/**
 * The payment-key check record (lib/payments/key-check.ts): ONE document, `_id` fixed, that proves
 * which `PAYMENT_CREDENTIALS_KEY` the stored payment secrets were written with. It holds the
 * AES-256-GCM encryption of a fixed PUBLIC label under that key (its own associated data), plus a
 * non-secret fingerprint for diagnosis. It never holds a store's credentials and refers to no store.
 *
 * Immutable: created once (bootstrap or the approved adoption command), never updated or replaced.
 * Every update and replace operation is refused here, and no code path writes it except an insert,
 * which fails on the fixed `_id` if a record already exists.
 *
 * Index policy: `autoIndex` and `autoCreate` are OFF. It is read only by `_id`, so it needs no index
 * beyond the one every collection has; the collection appears with the first insert.
 */
export const PAYMENT_KEY_CHECK_ID = "payment-credentials:v1";
export const PAYMENT_KEY_CHECK_CREATORS = ["bootstrap", "adoption"] as const;
export type PaymentKeyCheckCreator = (typeof PAYMENT_KEY_CHECK_CREATORS)[number];

export interface PaymentKeyCheckDoc {
  _id: string;
  keyVersion: number;
  check: EncryptedValue;
  keyFingerprint: string;
  createdBy: PaymentKeyCheckCreator;
  /** Accounts with encrypted secrets when the record was made (0 for a bootstrap). */
  existingEncryptedRecordsAtCreation: number;
  createdAt: Date;
}

const encryptedValueSchema = new Schema(
  { v: Number, iv: String, tag: String, ct: String },
  { _id: false },
);

const paymentKeyCheckSchema = new Schema<PaymentKeyCheckDoc>(
  {
    _id: { type: String, required: true, enum: [PAYMENT_KEY_CHECK_ID], immutable: true },
    keyVersion: { type: Number, required: true, enum: [1], immutable: true },
    check: { type: encryptedValueSchema, required: true, immutable: true },
    keyFingerprint: { type: String, required: true, match: /^[0-9a-f]{16}$/, immutable: true },
    createdBy: { type: String, enum: PAYMENT_KEY_CHECK_CREATORS, required: true, immutable: true },
    existingEncryptedRecordsAtCreation: { type: Number, required: true, min: 0, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  },
);

function refuseMutation(): never {
  throw new Error("The payment-key check record cannot be changed");
}
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  paymentKeyCheckSchema.pre(op, refuseMutation);
}
paymentKeyCheckSchema.pre("save", function () {
  if (!this.isNew) refuseMutation();
});

export const PaymentKeyCheck: Model<PaymentKeyCheckDoc> =
  (models.PaymentKeyCheck as Model<PaymentKeyCheckDoc>) ||
  model<PaymentKeyCheckDoc>("PaymentKeyCheck", paymentKeyCheckSchema);
