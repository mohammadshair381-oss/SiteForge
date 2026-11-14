import { Schema, model, models, type Model, type Types } from "mongoose";

export const PREVIEW_LINK_SCOPES = ["site", "page"] as const;
export type PreviewLinkScope = (typeof PREVIEW_LINK_SCOPES)[number];

export interface PreviewLinkDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  /** SHA-256 hex hash of the raw token. The raw token is never stored. */
  tokenHash: string;
  scope: PreviewLinkScope;
  /** The one page a `page` link may show. */
  page: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Links that show a store's saved drafts to someone without an account
 * (lib/preview-links.ts). `autoIndex`/`autoCreate` are off: creating these indexes
 * is an approved operation (docs/storefront-commerce.md, "Draft preview links").
 * The TTL index is cleanup only: expiry is always checked explicitly.
 */
const previewLinkSchema = new Schema<PreviewLinkDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    tokenHash: { type: String, required: true, select: false, immutable: true },
    scope: { type: String, enum: PREVIEW_LINK_SCOPES, required: true, immutable: true },
    page: { type: Schema.Types.ObjectId, ref: "Page", default: null, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.tokenHash;
        return ret;
      },
    },
  },
);

previewLinkSchema.index({ tokenHash: 1 }, { unique: true });
previewLinkSchema.index({ business: 1, createdAt: -1 });
previewLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PreviewLink: Model<PreviewLinkDoc> =
  (models.PreviewLink as Model<PreviewLinkDoc>) || model<PreviewLinkDoc>("PreviewLink", previewLinkSchema);
