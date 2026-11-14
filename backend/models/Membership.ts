import { Schema, model, models, type Model, type Types } from "mongoose";
import {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  type MembershipRole,
  type MembershipStatus,
} from "@/lib/constants";

export interface MembershipDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  user: Types.ObjectId;
  role: MembershipRole;
  status: MembershipStatus;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<MembershipDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: { type: String, enum: MEMBERSHIP_ROLES, default: "staff", required: true },
    status: {
      type: String,
      enum: MEMBERSHIP_STATUSES,
      default: "active",
      required: true,
    },
    permissions: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false },
);

membershipSchema.index({ business: 1, user: 1 }, { unique: true });

export const Membership: Model<MembershipDoc> =
  (models.Membership as Model<MembershipDoc>) ||
  model<MembershipDoc>("Membership", membershipSchema);
