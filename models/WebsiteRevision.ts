import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Saved versions of what an owner builds, so a mistake can be undone after the
 * editor is closed: a page, the homepage settings, the design or the menus.
 * Restoring always goes to the DRAFT and never publishes (lib/website-revisions.ts).
 *
 * Scoped to one business. Holds only what the owner already wrote, so it needs no
 * extra protection beyond the business role that reads it.
 *
 * Index policy: `autoIndex` / `autoCreate` OFF, like the other newer models;
 * `{ business: 1, target: 1, targetId: 1, createdAt: -1 }` is an approved operation
 * (docs/theme-marketplace-and-pages.md, "Website history"). It works without the
 * index, only more slowly on a large collection.
 */
export const REVISION_TARGETS = ["page", "home", "design", "navigation"] as const;
export type RevisionTarget = (typeof REVISION_TARGETS)[number];

export const REVISION_REASONS = ["published", "checkpoint", "before_restore", "before_revert", "deleted"] as const;
export type RevisionReason = (typeof REVISION_REASONS)[number];

export interface WebsiteRevisionDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  target: RevisionTarget;
  /** The page id for `page`; empty for the others. */
  targetId: string;
  reason: RevisionReason;
  /** What it was called at the time, for the history list. */
  label: string;
  snapshot: unknown;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

const websiteRevisionSchema = new Schema<WebsiteRevisionDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    target: { type: String, enum: REVISION_TARGETS, required: true, immutable: true },
    targetId: { type: String, default: "", maxlength: 64, immutable: true },
    reason: { type: String, enum: REVISION_REASONS, required: true, immutable: true },
    label: { type: String, default: "", maxlength: 200, immutable: true },
    snapshot: { type: Schema.Types.Mixed, required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false, autoCreate: false, minimize: false },
);

websiteRevisionSchema.index({ business: 1, target: 1, targetId: 1, createdAt: -1 });

export const WebsiteRevision: Model<WebsiteRevisionDoc> =
  (models.WebsiteRevision as Model<WebsiteRevisionDoc>) ||
  model<WebsiteRevisionDoc>("WebsiteRevision", websiteRevisionSchema);
