import { Schema, model, models, type Model, type Types } from "mongoose";

export interface MediaDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  storageKey: string; // S3 object key (server-generated)
  originalName: string; // sanitized
  mimeType: string; // validated allowlist
  size: number; // bytes
  width?: number;
  height?: number;
  altText: string;
  createdAt: Date;
  /** Soft-delete marker: hidden from listings, keeps metadata for recovery. */
  deletedAt?: Date | null;
  /**
   * Set once the S3 object is confirmed deleted. While `deletedAt` is set but
   * this is null the record is a pending cleanup that DELETE can retry.
   */
  storageDeletedAt?: Date | null;
  /**
   * The record is written before the file, so no file can exist without one (lib/media-cleanup.ts).
   * "pending": being uploaded, hidden from listings, its size already reserved against the plan.
   * Absent on older records, which are simply ready.
   */
  uploadState?: "pending" | "ready" | "failed";
  /** When cleanup last tried, so ones that keep failing wait behind the rest. */
  cleanupAttemptedAt?: Date | null;
}

const mediaSchema = new Schema<MediaDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    storageKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    originalName: { type: String, default: "", trim: true, maxlength: 255 },
    mimeType: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    width: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    altText: { type: String, default: "", trim: true, maxlength: 240 },
    deletedAt: { type: Date, default: null },
    storageDeletedAt: { type: Date, default: null },
    uploadState: { type: String, enum: ["pending", "ready", "failed"], default: undefined },
    cleanupAttemptedAt: { type: Date, default: undefined },
  },
  { timestamps: true, versionKey: false },
);

mediaSchema.index({ business: 1, createdAt: -1 });
mediaSchema.index({ business: 1, deletedAt: 1 });
// Supports finding records whose S3 object still needs cleanup.
mediaSchema.index({ deletedAt: 1, storageDeletedAt: 1 });

export const Media: Model<MediaDoc> =
  (models.Media as Model<MediaDoc>) || model<MediaDoc>("Media", mediaSchema);