import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * A business's managed product category (NOT `models/Category.ts`, which is
 * the platform's list of business types). Products are associated by NAME
 * through the existing `Product.category` text (case-insensitive), so stores
 * that never manage categories keep working unchanged and no data migration
 * is needed; renaming a category updates its products in the same
 * transaction (lib/categories.ts).
 *
 * `autoIndex` is off; uniqueness of name and slug per business is enforced by
 * serialising writes per business (lib/categories.ts). See
 * docs/commerce-operations.md for the indexes to create.
 */
export interface ProductCategoryDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  /** Search-engine title and description (empty = derived from name/description). */
  seoTitle?: string;
  seoDescription?: string;
  sort: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productCategorySchema = new Schema<ProductCategoryDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 500 },
    imageUrl: { type: String, default: "" },
    seoTitle: { type: String, default: "", trim: true, maxlength: 160 },
    seoDescription: { type: String, default: "", trim: true, maxlength: 320 },
    sort: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, autoIndex: false },
);

productCategorySchema.index({ business: 1, slug: 1 }, { unique: true });
productCategorySchema.index({ business: 1, sort: 1 });

export const ProductCategory: Model<ProductCategoryDoc> =
  (models.ProductCategory as Model<ProductCategoryDoc>) ||
  model<ProductCategoryDoc>("ProductCategory", productCategorySchema);
