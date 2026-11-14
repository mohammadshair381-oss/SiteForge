import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Append-only history of AI consent decisions (lib/ai-builder/consent.ts):
 * which disclosure version the owner agreed to or revoked, for which
 * business, and when. Never updated or deleted. The current state is on
 * `Business.aiConsent` (written in the same transaction).
 *
 * Index policy: `autoIndex` / `autoCreate` OFF like the other new models;
 * `{ business: 1, createdAt: -1 }` is an approved operation for listing (the
 * collection is tiny, so correctness never depends on it).
 */
export const AI_CONSENT_ACTIONS = ["granted", "revoked"] as const;

export interface AiConsentEventDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  actor: Types.ObjectId;
  action: (typeof AI_CONSENT_ACTIONS)[number];
  /** Disclosure version (the text the owner saw). */
  version: string;
  createdAt: Date;
}

const aiConsentEventSchema = new Schema<AiConsentEventDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    action: { type: String, enum: AI_CONSENT_ACTIONS, required: true, immutable: true },
    version: { type: String, required: true, maxlength: 40, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false, autoCreate: false },
);

aiConsentEventSchema.index({ business: 1, createdAt: -1 });

export const AiConsentEvent: Model<AiConsentEventDoc> =
  (models.AiConsentEvent as Model<AiConsentEventDoc>) || model<AiConsentEventDoc>("AiConsentEvent", aiConsentEventSchema);
