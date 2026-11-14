import { Schema, model, models, type Model, type Types } from "mongoose";
import { AUTH_TOKEN_RECORD_TYPES, type AuthTokenRecordType } from "@/lib/constants";

export interface AuthTokenDoc {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: AuthTokenRecordType;
  /** SHA-256 hex hash of the raw token. The raw token is never persisted. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  // --- `login_code` records only (lib/auth/login-challenge.ts) ---
  /** Keyed hash of the current six-digit code. The code itself is never persisted. */
  codeHash?: string;
  /** When the current code stops working (the record itself lives until `expiresAt`). */
  codeExpiresAt?: Date;
  /** Wrong or right guesses made against the current code. */
  attempts?: number;
  /** Codes sent for this sign-in (the first one plus resends). */
  sends?: number;
  lastSentAt?: Date;
  /** The new browser's device id; it gets the known-device marker once the code is right. */
  deviceId?: string;
  /** Keyed fingerprint of the password hash and the session version when the password was checked. */
  credential?: string;
  tokenVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Single-use action tokens backing password reset and email verification, and
 * pending new-device sign-ins (`login_code`).
 *
 * Only a SHA-256 hash of the raw token is stored (`select: false` so it is not
 * loaded by default); the raw value is returned once to the caller that needs
 * to deliver it and is never written to the database, logs or API responses.
 * A sign-in code is stored only as a keyed hash (`codeHash`, `select: false`).
 *
 * The TTL index is a cleanup mechanism only: MongoDB's TTL monitor runs about
 * once a minute, so token validity is always enforced explicitly against
 * `expiresAt` (see lib/auth/action-tokens.ts), never by relying on deletion.
 * The `login_code` fields use only the existing indexes.
 */
const authTokenSchema = new Schema<AuthTokenDoc>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: AUTH_TOKEN_RECORD_TYPES, required: true },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    codeHash: { type: String, select: false, match: /^[A-Za-z0-9_-]{43}$/ },
    codeExpiresAt: { type: Date },
    attempts: { type: Number, min: 0 },
    sends: { type: Number, min: 0 },
    lastSentAt: { type: Date },
    deviceId: { type: String, match: /^[A-Za-z0-9_-]{22}$/ },
    credential: { type: String, select: false, match: /^[A-Za-z0-9_-]{43}$/ },
    tokenVersion: { type: Number, min: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.tokenHash;
        delete ret.codeHash;
        delete ret.credential;
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
