import { Schema, model, models, type Model, type Types } from "mongoose";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@/lib/constants";

export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * An invitation to a store's team (lib/team-invitations.ts). Nobody joins until the
 * invited person accepts. Only a SHA-256 hash of the link's token is stored. Expiry
 * is checked on every read; a pending invitation past `expiresAt` is simply expired.
 *
 * `autoIndex` is off; the indexes are an approved operation
 * (docs/database-preparation.md).
 */
export interface TeamInvitationDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  /** Lower-cased, as typed by the person who invited. */
  email: string;
  role: MembershipRole;
  tokenHash: string;
  status: InvitationStatus;
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  lastSentAt: Date;
  acceptedBy: Types.ObjectId | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const teamInvitationSchema = new Schema<TeamInvitationDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    role: { type: String, enum: MEMBERSHIP_ROLES, required: true },
    tokenHash: { type: String, required: true, select: false },
    status: { type: String, enum: INVITATION_STATUSES, default: "pending" },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    lastSentAt: { type: Date, required: true },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false },
);

teamInvitationSchema.index({ tokenHash: 1 }, { unique: true });
teamInvitationSchema.index({ business: 1, status: 1, createdAt: -1 });
teamInvitationSchema.index({ business: 1, email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

export const TeamInvitation: Model<TeamInvitationDoc> =
  (models.TeamInvitation as Model<TeamInvitationDoc>) || model<TeamInvitationDoc>("TeamInvitation", teamInvitationSchema);
