import { Schema, model, models, type Model } from "mongoose";

export interface RateLimitDoc {
  key: string;
  count: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fixed-window rate-limit counters, stored in the existing MongoDB so limits
 * hold across multiple app instances and serverless invocations (an in-memory
 * limiter would not). A TTL index expires stale buckets automatically.
 */
const rateLimitSchema = new Schema<RateLimitDoc>(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

// TTL: purge counters shortly after their window ends.
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit: Model<RateLimitDoc> =
  (models.RateLimit as Model<RateLimitDoc>) ||
  model<RateLimitDoc>("RateLimit", rateLimitSchema);
