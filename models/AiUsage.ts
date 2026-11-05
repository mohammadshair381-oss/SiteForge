import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Monthly AI usage of one business (lib/ai-builder/usage.ts). COUNTERS ONLY:
 * never prompts, owner requests, generated text or provider error messages.
 * Token counts are summed only from what the provider itself reported (the
 * number of such reports is kept, so missing counts are visible, never
 * estimated); there are no costs here.
 *
 * `_id` is `${businessId}:${YYYY-MM}` (UTC month), so the always-present `_id`
 * index makes the monthly allowance check atomic without any extra index.
 * `autoIndex` / `autoCreate` are OFF like the other new models; no index
 * operation is required for correctness.
 */
export interface AiUsageDoc {
  _id: string;
  business: Types.ObjectId;
  /** "YYYY-MM" (UTC). */
  period: string;
  /** Requests sent to the provider (reserved right before the call; refunded if nothing was sent). */
  requests: number;
  /** The provider answered and the output became a suggestion. */
  successes: number;
  /** The provider call failed (error, timeout, rate limit, truncated or blocked output). */
  failures: number;
  /** The provider answered, but the output was refused (invalid, unsupported, invented facts). */
  rejected: number;
  /** Requests per task ("storefront", "product", "planning"). */
  tasks: Record<string, number>;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Responses that reported token counts. */
  tokenReports: number;
  /** Model name of the last successful response. */
  model: string | null;
  /** Provider of the last successful response. Absent on older records. */
  provider?: string | null;
  /** Per provider and model (key: `routeUsageKey`). Counters only. Absent on older records. */
  routes?: Record<string, { requests?: number; successes?: number; failures?: number; rejected?: number }>;
  /** Requests answered only after trying another route first. */
  fallbacks?: number;
  createdAt: Date;
  updatedAt: Date;
}

const aiUsageSchema = new Schema<AiUsageDoc>(
  {
    _id: { type: String, required: true },
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/, immutable: true },
    requests: { type: Number, default: 0, min: 0 },
    successes: { type: Number, default: 0, min: 0 },
    failures: { type: Number, default: 0, min: 0 },
    rejected: { type: Number, default: 0, min: 0 },
    tasks: { type: Schema.Types.Mixed, default: () => ({}) },
    promptTokens: { type: Number, default: 0, min: 0 },
    outputTokens: { type: Number, default: 0, min: 0 },
    totalTokens: { type: Number, default: 0, min: 0 },
    tokenReports: { type: Number, default: 0, min: 0 },
    model: { type: String, default: null, maxlength: 80 },
    provider: { type: String, default: undefined, maxlength: 40 },
    routes: { type: Schema.Types.Mixed, default: undefined },
    fallbacks: { type: Number, default: undefined, min: 0 },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false, minimize: false },
);

export const AiUsage: Model<AiUsageDoc> = (models.AiUsage as Model<AiUsageDoc>) || model<AiUsageDoc>("AiUsage", aiUsageSchema);
