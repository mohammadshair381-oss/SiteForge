import { Schema, model, models, type Model, type Types } from "mongoose";

export interface CartItem {
  product: string;
  /** Variant id for variant products; "" for simple products. */
  variant?: string;
  variantLabel?: string;
  /** The name when added, so a message can still name a product deleted since. */
  productName?: string;
  quantity: number;
  priceSnapshot: number;
  currency: string;
}

export interface CartDoc {
  _id: string;
  business: string | Types.ObjectId;
  ownerToken: string;
  /**
   * The storefront customer this cart belongs to (lib/cart/shopper-cart.ts). Absent = a
   * guest's. Reachable only with that customer's session.
   */
  customer?: Types.ObjectId | null;
  items: CartItem[];
  subtotal: number;
  total: number;
  /** What changed in this cart while the shopper was away, shown once on the cart page. */
  notices?: string[];
  /** The last time a shopper came back to this cart after abandoning it. */
  recoveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// The item schema inside the cart's items array.
const cartItemSchema = new Schema<CartItem>(
  {
    product: { type: String, required: true },
    variant: { type: String, default: "" },
    variantLabel: { type: String, default: "" },
    productName: { type: String, default: "" },
    quantity: { type: Number, min: 1, required: true },
    priceSnapshot: { type: Number, required: true },
    currency: { type: String, default: "USD" },
  },
  { _id: false },
);

// The cart main schema.
const cartSchema = new Schema<CartDoc>(
  {
    business: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    ownerToken: { type: String, required: true, index: true },
    // No default: absent marks a guest's cart. The index this relies on is NOT declared
    // here, because this model builds its indexes automatically on a local database, and
    // creating one is an approved operation (docs/database-preparation.md). lib/required-indexes.ts looks for it.
    customer: { type: Schema.Types.ObjectId, ref: "Customer" },
    items: { type: [cartItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    notices: { type: [String], default: [] },
    recoveredAt: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

// Index for fast lookups.
cartSchema.index({ business: 1, ownerToken: 1 });

export const Cart: Model<CartDoc> =
  (models.Cart as Model<CartDoc>) || model<CartDoc>("Cart", cartSchema);
