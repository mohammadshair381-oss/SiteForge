import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Append-only stock history (lib/inventory.ts is the only writer). Every
 * change to a product's or variant's stock records one movement in the SAME
 * transaction as the stock update, so the history cannot drift from stock.
 *
 * `autoIndex` is off like the other append-only models: create the indexes
 * listed in docs/commerce-operations.md as an approved operation.
 */
export const INVENTORY_REASONS = [
  "order_reserved",
  "order_released",
  "adjustment",
  "restock",
  "damage",
  "correction",
  "initial",
  "variants_created",
  "order_refunded",
  "product_restored",
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];

export interface InventoryMovementDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  product: Types.ObjectId;
  /** Variant id for variant products; null for simple products. */
  variant: Types.ObjectId | null;
  delta: number;
  /** Stock of the product/variant right after this movement. */
  stockAfter: number | null;
  reason: InventoryReason;
  order: Types.ObjectId | null;
  /** Platform user for manual changes; null for order-driven changes. */
  actor: Types.ObjectId | null;
  note: string;
  createdAt: Date;
}

const inventoryMovementSchema = new Schema<InventoryMovementDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    variant: { type: Schema.Types.ObjectId, default: null },
    delta: { type: Number, required: true },
    stockAfter: { type: Number, default: null },
    reason: { type: String, enum: INVENTORY_REASONS, required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "", maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, autoIndex: false },
);

inventoryMovementSchema.index({ business: 1, product: 1, createdAt: -1 });
inventoryMovementSchema.index({ business: 1, createdAt: -1 });

export const InventoryMovement: Model<InventoryMovementDoc> =
  (models.InventoryMovement as Model<InventoryMovementDoc>) ||
  model<InventoryMovementDoc>("InventoryMovement", inventoryMovementSchema);
