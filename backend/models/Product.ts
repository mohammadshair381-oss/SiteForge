import { Schema, model, models, type Model, type Types } from "mongoose";
import { PRODUCT_STATUSES, type ProductStatus } from "@/lib/constants";

/** One configurable attribute, e.g. { name: "Size", values: ["S", "M", "L"] }. */
export interface ProductOption {
  name: string;
  values: string[];
}

/**
 * One purchasable combination of option values. Variants are never deleted
 * (orders and stock movements reference them); they are archived instead.
 */
export interface ProductVariant {
  _id: Types.ObjectId;
  /** Exactly one value per product option, in option order. */
  options: Array<{ name: string; value: string }>;
  sku: string;
  /** Null = the product price. */
  price: number | null;
  compareAtPrice: number | null;
  stock: number;
  archived: boolean;
  /** Its own picture; empty = the product's images. */
  imageUrl?: string;
}

export interface ProductDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  price: number;
  /**
   * Optional original ("compare at") price. A product is on sale only when
   * this is set AND greater than `price`. Absent/null = not on sale, so
   * existing products are unaffected.
   */
  compareAtPrice?: number | null;
  currency: string;
  imageUrl: string;
  images: string[];
  sku: string;
  category: string;
  /** Search-engine title and description (empty = derived from name/description). */
  seoTitle?: string;
  seoDescription?: string;
  /** Text alternative for the main product image (empty = the product name). */
  imageAlt?: string;
  /**
   * Units available to buy (net of reserved orders). For a product with
   * variants this is the SUM of its variants' stock, kept in step in the same
   * atomic update as the variant (lib/inventory.ts).
   */
  stock: number;
  /** Optional attributes (max 3). Empty = a simple product (unchanged behaviour). */
  options: ProductOption[];
  variants: ProductVariant[];
  /** Low-stock warning level; null = LOW_STOCK_DEFAULT (lib/inventory-rules.ts). */
  lowStockThreshold?: number | null;
  /** Cached summary of APPROVED reviews (lib/reviews.ts keeps it in step). */
  ratingAverage?: number | null;
  ratingCount?: number;
  status: ProductStatus;
  /**
   * A starter sample (lib/sample-products.ts): the name of its bundled photo in
   * public/samples. Empty for the owner's own products. A sample stays a draft:
   * it cannot be made active until the owner changes its name, price or photo,
   * which clears this. Server-written only.
   */
  sample?: string;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<ProductDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, default: "", maxlength: 4000 },
    price: { type: Number, required: true, min: 0, default: 0 },
    compareAtPrice: { type: Number, default: null, min: 0 },
    currency: { type: String, default: "USD", uppercase: true, trim: true },
    imageUrl: { type: String, default: "" },
    images: { type: [String], default: [] },
    sku: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    seoTitle: { type: String, default: "", trim: true, maxlength: 160 },
    seoDescription: { type: String, default: "", trim: true, maxlength: 320 },
    imageAlt: { type: String, default: "", trim: true, maxlength: 160 },
    stock: { type: Number, default: 0, min: 0 },
    options: {
      type: [{ name: { type: String, trim: true, maxlength: 40 }, values: { type: [String], default: [] }, _id: false }],
      default: [],
    },
    variants: {
      type: [
        {
          options: { type: [{ name: String, value: String, _id: false }], default: [] },
          sku: { type: String, default: "", trim: true },
          price: { type: Number, default: null, min: 0 },
          compareAtPrice: { type: Number, default: null, min: 0 },
          stock: { type: Number, default: 0, min: 0 },
          archived: { type: Boolean, default: false },
          imageUrl: { type: String, default: "" },
        },
      ],
      default: [],
    },
    lowStockThreshold: { type: Number, default: null, min: 0 },
    ratingAverage: { type: Number, default: null, min: 1, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: PRODUCT_STATUSES, default: "draft", index: true },
    // No index: only ever read together with `business`.
    sample: { type: String, default: "", trim: true, maxlength: 60 },
  },
  { timestamps: true, versionKey: false },
);

productSchema.index({ business: 1, slug: 1 }, { unique: true });
productSchema.index({ business: 1, status: 1 });

export const Product: Model<ProductDoc> =
  (models.Product as Model<ProductDoc>) ||
  model<ProductDoc>("Product", productSchema);
