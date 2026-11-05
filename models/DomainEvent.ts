import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * What happened to a custom domain, for the owner's history. Append-only and written on
 * a best-effort basis: it never decides anything, and `DomainVerification` stays the
 * record of a domain's state. Holds a short reason code only, never a token or DNS value.
 * `autoIndex` is off; its index is an approved operation (docs/database-preparation.md).
 */
export const DOMAIN_EVENT_TYPES = [
  "requested",
  "renewal_requested",
  "verified",
  "verification_failed",
  "renewed",
  "selected",
  "routing_ok",
  "routing_failed",
  "certificate_pending",
  "certificate_issued",
  "certificate_failed",
  "certificate_renewal_started",
  "certificate_renewed",
  "certificate_renewal_failed",
  "check_unavailable",
  "recovered",
  "activated",
  "deactivated",
  "removed",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export interface DomainEventDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  domain: string;
  type: DomainEventType;
  detail: string;
  createdAt: Date;
}

const domainEventSchema = new Schema<DomainEventDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    domain: { type: String, required: true, trim: true, lowercase: true, maxlength: 253 },
    type: { type: String, enum: DOMAIN_EVENT_TYPES, required: true },
    detail: { type: String, default: "", maxlength: 60 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false, autoCreate: false },
);

domainEventSchema.index({ business: 1, domain: 1, createdAt: -1 });

export const DomainEvent: Model<DomainEventDoc> =
  (models.DomainEvent as Model<DomainEventDoc>) || model<DomainEventDoc>("DomainEvent", domainEventSchema);
