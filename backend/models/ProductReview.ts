import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * A shopper's review of one product from one PAID order of the same business
 * (verified purchase only; lib/reviews.ts is the only writer). New reviews
 * are `pending` and become public only when the business approves them.
 * At most one review per (order, product); writes are serialised on the
 * order document. `autoIndex` is off; see docs/commerce-operations.md.
 */
export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ProductReviewDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  product: Types.ObjectId;
  order: Types.ObjectId;
  /** Display name derived from the order ("Ada L."); never the e-mail. */
  authorName: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  moderatedBy: Types.ObjectId | null;
  moderatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const productReviewSchema = new Schema<ProductReviewDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    authorName: { type: String, required: true, maxlength: 60 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: "", maxlength: 100 },
    body: { type: String, default: "", maxlength: 2000 },
    status: { type: String, enum: REVIEW_STATUSES, default: "pending" },
    moderatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    moderatedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

productReviewSchema.index({ business: 1, product: 1, status: 1, createdAt: -1 });
productReviewSchema.index({ business: 1, status: 1, createdAt: -1 });
productReviewSchema.index({ order: 1, product: 1 }, { unique: true });

export const ProductReview: Model<ProductReviewDoc> =
  (models.ProductReview as Model<ProductReviewDoc>) ||
  model<ProductReviewDoc>("ProductReview", productReviewSchema);
