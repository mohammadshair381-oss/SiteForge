import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * One website conversation between an owner or manager and the AI Builder (lib/ai-website/conversation.ts).
 * It belongs to one business AND one person, and is always loaded by both: other members never see it,
 * whatever their role. What it produces is a proposal, which owners and managers can review. Messages are scrubbed of
 * personal and secret-looking text before they are stored. `generation` holds the work done so far, so an
 * interrupted website generation carries on without repeating a step.
 *
 * Index policy: `autoIndex` / `autoCreate` OFF like the other new models. `{ business: 1, createdBy: 1, createdAt: -1 }`
 * is an optional approved operation (docs/database-preparation.md); correctness does not need it.
 */
export interface AiConversationMessage {
  role: "owner" | "assistant";
  text: string;
  at: Date;
}

export interface AiConversationDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  createdBy: Types.ObjectId;
  status: "active" | "closed";
  messages: AiConversationMessage[];
  /** What the assistant has learned so far (lib/ai-website/answers.ts `WebsiteBrief`). */
  brief: Record<string, unknown>;
  readyToGenerate: boolean;
  questions: string[];
  /** Wording last refused by the claims check, for the owner to confirm or the assistant to avoid. */
  flaggedClaims: string[];
  /** Fixed sentences only: what the last answer chose that this store does not support, for the assistant to avoid next time. */
  answerCorrections: string[];
  /** Progress of generating a whole website; see lib/ai-website/generation.ts. */
  generation: { plan?: unknown; pages?: unknown[]; contents?: Record<string, unknown>; notes?: string[]; proposalId?: string; refs?: unknown; startedAt?: Date } | null;
  /** The newest proposal from this conversation. */
  proposalId: Types.ObjectId | null;
  /** Only one request at a time works on a conversation. Runs out by itself after a crash. */
  leaseUntil: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<AiConversationMessage>(
  {
    role: { type: String, enum: ["owner", "assistant"], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const aiConversationSchema = new Schema<AiConversationDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    status: { type: String, enum: ["active", "closed"], default: "active" },
    messages: { type: [messageSchema], default: [] },
    brief: { type: Schema.Types.Mixed, default: () => ({}) },
    readyToGenerate: { type: Boolean, default: false },
    questions: { type: [String], default: [] },
    flaggedClaims: { type: [String], default: [] },
    answerCorrections: { type: [String], default: [] },
    generation: { type: Schema.Types.Mixed, default: null },
    proposalId: { type: Schema.Types.ObjectId, ref: "WebsiteProposal", default: null },
    leaseUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false, minimize: false },
);

aiConversationSchema.index({ business: 1, createdBy: 1, createdAt: -1 });

export const AiConversation: Model<AiConversationDoc> =
  (models.AiConversation as Model<AiConversationDoc>) || model<AiConversationDoc>("AiConversation", aiConversationSchema);
