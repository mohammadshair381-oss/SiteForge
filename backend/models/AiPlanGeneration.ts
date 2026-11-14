import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * What the server remembers about one AI-generated website plan, so that a plan saved later can be
 * told apart from one the owner wrote (lib/ai-planning/plan-provenance.ts). It holds fingerprints of
 * the generated text, never the text, plus the owner's own brief (their words count as facts in the
 * claims check, as a request does elsewhere). Records stop counting at `expiresAt`, and each new
 * generation clears that store's expired ones.
 *
 * Index policy: `autoIndex` / `autoCreate` OFF like the other new models. `{ business: 1, createdAt: -1 }`
 * is an optional approved operation (docs/database-preparation.md); correctness does not need it.
 */
export interface AiPlanGenerationDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  createdBy: Types.ObjectId;
  /** The owner's brief, scrubbed of personal and secret-looking text. */
  brief: string;
  pages: Array<{ slug: string; titleHash: string }>;
  /** Fingerprints of every text the plan would show on the store. */
  textHashes: string[];
  expiresAt: Date;
  createdAt: Date;
}

const aiPlanGenerationSchema = new Schema<AiPlanGenerationDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    brief: { type: String, default: "", maxlength: 12000, immutable: true },
    pages: { type: [{ slug: { type: String, required: true }, titleHash: { type: String, required: true }, _id: false }], default: [], immutable: true },
    textHashes: { type: [String], default: [], immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false, autoCreate: false },
);

aiPlanGenerationSchema.index({ business: 1, createdAt: -1 });

export const AiPlanGeneration: Model<AiPlanGenerationDoc> =
  (models.AiPlanGeneration as Model<AiPlanGenerationDoc>) || model<AiPlanGenerationDoc>("AiPlanGeneration", aiPlanGenerationSchema);
