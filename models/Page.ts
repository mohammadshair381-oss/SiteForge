import { Schema, model, models, type Model, type Types } from "mongoose";
import { BUSINESS_STATUSES } from "@/lib/constants";

export const PAGE_STATUSES = ["draft", "published"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

export interface PageDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  title: string;
  slug: string; // normalized, unique per business
  sections: unknown[]; // current draft/editable content
  publishedSections: unknown[]; // snapshot shown to public visitors
  version: number; // optimistic concurrency counter
  status: PageStatus;
  isHome: boolean;
  seoTitle: string;
  seoDescription: string;
  /**
   * Published SEO snapshot, copied from the draft fields when the page is
   * published. Absent on pages published before this field existed; readers
   * fall back to the draft values (see lib/seo.ts).
   */
  publishedSeoTitle?: string;
  publishedSeoDescription?: string;
  /** The picture shown when the page is shared. Draft and published, like the text. */
  seoImage?: string;
  publishedSeoImage?: string;
  /** Keep this page out of search engines. Draft and published, like the text. */
  noindex?: boolean;
  publishedNoindex?: boolean;
  /** Another address that is the original of this page, for search engines. Draft and published, like the text. */
  canonicalUrl?: string;
  publishedCanonicalUrl?: string;
  /** Earlier addresses of a published page: visitors to them are redirected. */
  previousSlugs?: string[];
  /** Owner-facing note about what the page is for (not shown to visitors). */
  description?: string;
  /**
   * Set on pages prepared by default-page generation (lib/page-generation.ts).
   * `needsReview`: policy/legal templates; publishing requires the owner to
   * confirm a review (and every `[[placeholder]]` to be replaced).
   */
  generated?: {
    key: string;
    source: "template" | "ai";
    preset: string;
    needsReview: boolean;
    createdAt: Date;
    reviewedAt?: Date | null;
    reviewedBy?: Types.ObjectId | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const pageSchema = new Schema<PageDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 80,
    },
    sections: { type: [Schema.Types.Mixed], default: [] },
    publishedSections: { type: [Schema.Types.Mixed], default: [] },
    version: { type: Number, default: 0 },
    status: { type: String, enum: PAGE_STATUSES, default: "draft", index: true },
    isHome: { type: Boolean, default: false, index: true },
    seoTitle: { type: String, default: "", trim: true, maxlength: 160 },
    seoDescription: { type: String, default: "", trim: true, maxlength: 320 },
    // No defaults: absence marks a legacy page (fall back to draft SEO).
    publishedSeoTitle: { type: String, trim: true, maxlength: 160 },
    publishedSeoDescription: { type: String, trim: true, maxlength: 320 },
    seoImage: { type: String, trim: true, maxlength: 2048 },
    publishedSeoImage: { type: String, trim: true, maxlength: 2048 },
    noindex: { type: Boolean },
    publishedNoindex: { type: Boolean },
    canonicalUrl: { type: String, trim: true, maxlength: 500 },
    publishedCanonicalUrl: { type: String, trim: true, maxlength: 500 },
    previousSlugs: { type: [String], default: undefined },
    description: { type: String, trim: true, maxlength: 300 },
    // Absent on pages the owner created; additive and optional.
    generated: {
      type: new Schema(
        {
          key: { type: String, required: true, maxlength: 80 },
          source: { type: String, enum: ["template", "ai"], required: true },
          preset: { type: String, required: true, maxlength: 40 },
          needsReview: { type: Boolean, default: false },
          createdAt: { type: Date, required: true },
          reviewedAt: { type: Date, default: null },
          reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true, versionKey: false },
);

// Unique slug within a business
pageSchema.index({ business: 1, slug: 1 }, { unique: true });

// Only one homepage per business
pageSchema.index(
  { business: 1, isHome: 1 },
  { unique: true, partialFilterExpression: { isHome: true } },
);

export const Page: Model<PageDoc> =
  (models.Page as Model<PageDoc>) || model<PageDoc>("Page", pageSchema);