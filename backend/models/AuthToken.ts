import { Schema, model, models, type Model, type Types } from "mongoose";
import { AUTH_TOKEN_TYPES, type ActionTokenType } from "@/lib/constants";

export interface AuthTokenDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: ActionTokenType;
  /** SHA-256 hex hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Single-use action tokens backing password reset and email verification.
 *
 * Only a SHA-256 hash of the raw token is stored (`select: false` so it is not
 * loaded by default); the raw value is returned once to the caller that needs
 * to deliver it and is never written to the database, logs or API responses.
 *
 * The TTL index is a cleanup mechanism only: MongoDB's TTL monitor runs about
 * once a minute, so token validity is always enforced explicitly against
 * `expiresAt` (see lib/auth/action-tokens.ts), never by relying on deletion.
 */
const authTokenSchema = new Schema<AuthTokenDoc>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: AUTH_TOKEN_TYPES, required: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.tokenHash;
        return ret;
      },
    },
  },
);

// Eventual cleanup of expired tokens (deletion is not used for validation).
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Issuing a replacement invalidates outstanding tokens for the same user/type.
authTokenSchema.index({ user: 1, type: 1 });

export const AuthToken: Model<AuthTokenDoc> =
  (models.AuthToken as Model<AuthTokenDoc>) ||
  model<AuthTokenDoc>("AuthToken", authTokenSchema);
