import { Schema, model, models, type Model, type Types } from "mongoose";
import { PLATFORM_ROLES, type PlatformRole } from "@/lib/constants";

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  platformRole: PlatformRole;
  active: boolean;
  /**
   * Session generation counter, embedded in each session JWT. Bumping it
   * invalidates every existing session for the user. It is incremented
   * automatically whenever the password changes (see pre-save hook).
   */
  tokenVersion: number;
  /**
   * Email verification state:
   *   - `Date`  -> verified;
   *   - `null`  -> explicitly unverified (new accounts are created this way);
   *   - absent/`undefined` -> legacy account, grandfathered as verified.
   * The field is intentionally optional and has no schema default, so accounts
   * that predate it keep their access. Only server code sets it; clients can
   * never write it.
   */
  emailVerifiedAt?: Date | null;
  /**
   * Trusted-device generation (lib/auth/platform-device.ts). Absent means 0. Raising it outdates
   * every known-device marker and every pending new-device sign-in of the account, so each browser
   * must enter an emailed code again. Raised only by the security-sensitive admin actions
   * (lib/admin/user-actions.ts), never by an ordinary logout. No default, so existing accounts and
   * their markers are untouched.
   */
  deviceTrustVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    passwordHash: { type: String, required: true, select: false },
    platformRole: {
      type: String,
      enum: PLATFORM_ROLES,
      default: "user",
      required: true,
    },
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, required: true },
    // No `default`: a default of `null` would retroactively mark existing
    // accounts as unverified. Registration sets `null` explicitly instead.
    emailVerifiedAt: { type: Date },
    deviceTrustVersion: { type: Number, min: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        delete ret.tokenVersion;
        delete ret.deviceTrustVersion;
        return ret;
      },
    },
  },
);

// Any password change invalidates all previously issued sessions.
userSchema.pre("save", function () {
  if (this.isModified("passwordHash")) {
    this.tokenVersion = (this.tokenVersion ?? 0) + 1;
  }
});

export const User: Model<UserDoc> =
  (models.User as Model<UserDoc>) || model<UserDoc>("User", userSchema);
