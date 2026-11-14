import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * An item in a store's notification centre (lib/notifications.ts). Holds short text and a
 * link to the right dashboard page, never a shopper's details or anything secret. `audience`
 * says which business roles see it, and `readBy` who has read it.
 *
 * `autoIndex` is off; the indexes are an approved operation (docs/database-preparation.md).
 * The unique one is what stops an event being announced twice, so notifications stay off
 * until it exists (lib/required-indexes.ts).
 */
export const NOTIFICATION_KINDS = ["order", "payment", "refund", "stock", "subscription", "usage", "domain", "team", "store"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationSeverity = "info" | "success" | "warning" | "danger";
export type NotificationRole = "owner" | "manager" | "staff";

export interface NotificationDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  dedupeKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** A path inside this store's dashboard. */
  link: string;
  audience: NotificationRole[];
  readBy: Types.ObjectId[];
  /** When it happened, which can be before it was noticed. */
  occurredAt: Date;
  createdAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    kind: { type: String, enum: NOTIFICATION_KINDS, required: true },
    severity: { type: String, enum: ["info", "success", "warning", "danger"], default: "info" },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, default: "", maxlength: 400 },
    link: { type: String, default: "", maxlength: 300 },
    audience: { type: [String], enum: ["owner", "manager", "staff"], default: [] },
    readBy: { type: [Schema.Types.ObjectId], default: [] },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false, autoCreate: false },
);

notificationSchema.index({ business: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ business: 1, occurredAt: -1 });

export const Notification: Model<NotificationDoc> =
  (models.Notification as Model<NotificationDoc>) || model<NotificationDoc>("Notification", notificationSchema);
