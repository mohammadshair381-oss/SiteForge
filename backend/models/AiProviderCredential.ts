import { Schema, model, models, type Model } from "mongoose";

/**
 * An AI provider's API key, set by a Super Admin (owner decision, 2026-11-17), one document per
 * provider with the provider id as `_id`, so it needs no index beyond `_id`. Only the encrypted
 * value is stored (lib/ai-providers/credentials.ts); `last4` is kept so the panel can say which
 * key is in use without decrypting it. Never returned, logged or put in an audit entry.
 */
export interface AiProviderCredentialDoc {
  _id: string;
  /** AES-256-GCM, version 1: the key is derived from SESSION_SECRET (HKDF, its own purpose). */
  v: number;
  iv: string;
  tag: string;
  ct: string;
  last4: string;
  updatedBy: Schema.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<AiProviderCredentialDoc>(
  {
    _id: { type: String, required: true },
    v: { type: Number, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    ct: { type: String, required: true },
    last4: { type: String, required: true, maxlength: 4 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false },
);

export const AiProviderCredential: Model<AiProviderCredentialDoc> =
  (models.AiProviderCredential as Model<AiProviderCredentialDoc>) || model<AiProviderCredentialDoc>("AiProviderCredential", schema);
