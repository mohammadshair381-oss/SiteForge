import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { Product } from "@/models/Product";
import { InventoryMovement, type InventoryReason } from "@/models/InventoryMovement";
import { notifyStock } from "@/lib/notification-events";

/**
 * Server-only inventory core. EVERY stock change goes through here:
 * - `reserveStock`  (checkout; conditional decrement, cannot oversell),
 * - `restoreStock`  (cancellation/expiry of a reserved order),
 * - `adjustStock`   (owner/staff adjustments, compare-and-set or delta),
 * - `addVariantStock` (initial stock of new variants).
 * Each runs inside the caller's transaction (or its own) and records an
 * `InventoryMovement` in that same transaction.
 *
 * For a product with variants, `Product.stock` is the sum of its variants'
 * stock; both are changed in ONE update ($inc on the variant and the product),
 * so the invariant holds under concurrency.
 */

export interface StockLine {
  product: unknown;
  /** Variant id for variant products; absent/empty for simple products. */
  variant?: unknown;
  quantity: number;
}

export interface StockChange {
  product: mongoose.Types.ObjectId;
  variant: mongoose.Types.ObjectId | null;
  delta: number;
  stockAfter: number | null;
}

function oid(value: unknown): mongoose.Types.ObjectId {
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value));
}

function variantOid(value: unknown): mongoose.Types.ObjectId | null {
  return value === undefined || value === null || value === "" ? null : oid(value);
}

function stockAfterOf(doc: { stock?: number; variants?: Array<{ _id: unknown; stock: number }> } | null, variant: mongoose.Types.ObjectId | null): number | null {
  if (!doc) return null;
  if (!variant) return typeof doc.stock === "number" ? doc.stock : null;
  const match = (doc.variants ?? []).find((v) => String(v._id) === String(variant));
  return match ? match.stock : null;
}

/**
 * Conditional decrement for every line. A line only matches while enough
 * stock remains (and, for a variant, while the variant is not archived), so
 * two competing transactions can never oversell; any failure throws and the
 * caller's transaction rolls back every decrement already applied.
 */
export async function reserveStock(
  lines: StockLine[],
  businessId: string,
  session: mongoose.ClientSession,
): Promise<StockChange[]> {
  const changes: StockChange[] = [];
  for (const line of lines) {
    const product = oid(line.product);
    const variant = variantOid(line.variant);
    const quantity = line.quantity;
    const updated = variant
      ? await Product.findOneAndUpdate(
          {
            _id: product,
            business: businessId,
            variants: { $elemMatch: { _id: variant, archived: { $ne: true }, stock: { $gte: quantity } } },
          },
          { $inc: { "variants.$[v].stock": -quantity, stock: -quantity } },
          { arrayFilters: [{ "v._id": variant }], session, new: true, projection: { stock: 1, variants: 1 } },
        )
      : await Product.findOneAndUpdate(
          // A simple product only: once options exist, a line must name a variant.
          { _id: product, business: businessId, stock: { $gte: quantity }, "options.0": { $exists: false } },
          { $inc: { stock: -quantity } },
          { session, new: true, projection: { stock: 1 } },
        );
    if (!updated) {
      throw new HttpError(404, `Product ${String(line.product)} is out of stock`, "out_of_stock");
    }
    changes.push({ product, variant, delta: -quantity, stockAfter: stockAfterOf(updated, variant) });
  }
  return changes;
}

/**
 * Return reserved quantities to stock (cancelled or expired reservation). Must
 * run in the same transaction as the order's reserved -> released transition.
 * A missing product or variant throws, aborting that transition.
 */
export async function restoreStock(
  lines: StockLine[],
  businessId: unknown,
  session: mongoose.ClientSession,
): Promise<StockChange[]> {
  const changes: StockChange[] = [];
  for (const line of lines) {
    const product = oid(line.product);
    const variant = variantOid(line.variant);
    const updated = variant
      ? await Product.findOneAndUpdate(
          { _id: product, business: businessId, "variants._id": variant },
          { $inc: { "variants.$[v].stock": line.quantity, stock: line.quantity } },
          { arrayFilters: [{ "v._id": variant }], session, new: true, projection: { stock: 1, variants: 1 } },
        )
      : await Product.findOneAndUpdate(
          { _id: product, business: businessId },
          { $inc: { stock: line.quantity } },
          { session, new: true, projection: { stock: 1 } },
        );
    if (!updated) {
      throw new Error(`Cannot restore inventory: product ${String(line.product)} was not found in this business`);
    }
    changes.push({ product, variant, delta: line.quantity, stockAfter: stockAfterOf(updated, variant) });
  }
  return changes;
}

/** Records movements (same transaction as the stock change). */
export async function recordMovements(
  businessId: unknown,
  changes: StockChange[],
  details: { reason: InventoryReason; order?: unknown; actor?: unknown; note?: string },
  session: mongoose.ClientSession,
): Promise<void> {
  if (changes.length === 0) return;
  await InventoryMovement.insertMany(
    changes.map((change) => ({
      business: oid(businessId),
      product: change.product,
      variant: change.variant,
      delta: change.delta,
      stockAfter: change.stockAfter,
      reason: details.reason,
      order: details.order ? oid(details.order) : null,
      actor: details.actor ? oid(details.actor) : null,
      note: (details.note ?? "").slice(0, 200),
    })),
    { session },
  );
}

export const ADJUSTMENT_REASONS = ["adjustment", "restock", "damage", "correction"] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/**
 * Owner/staff stock change for one product or variant, in its own
 * transaction. Either a signed `delta` (never below zero) or an absolute
 * `set` with the `expected` value the user saw (compare-and-set: a checkout
 * that reserved stock meanwhile makes it fail with 409 instead of erasing the
 * reservation).
 */
export async function adjustStock(input: {
  businessId: string;
  productId: string;
  variantId?: string | null;
  delta?: number;
  set?: number;
  expected?: number;
  reason: AdjustmentReason;
  note?: string;
  actorId: string;
  /** The caller's transaction, when this is one part of a larger change. The caller then announces it. */
  session?: mongoose.ClientSession;
}): Promise<{ stock: number; delta: number }> {
  const product = oid(input.productId);
  const variant = variantOid(input.variantId);
  let result = { stock: 0, delta: 0 };
  const apply = async (session: mongoose.ClientSession) => {
      const current = await Product.findOne({ _id: product, business: input.businessId })
        .select("stock options variants status")
        .session(session)
        .lean<{ stock: number; options?: unknown[]; variants?: Array<{ _id: unknown; stock: number; archived?: boolean }> }>();
      if (!current) throw new HttpError(404, "Product not found", "not_found");
      const hasVariants = Array.isArray(current.options) && current.options.length > 0;
      if (hasVariants && !variant) throw new HttpError(422, "Choose the variant to adjust", "variant_required");
      if (!hasVariants && variant) throw new HttpError(422, "This product has no variants", "invalid_variant");
      const target = variant ? (current.variants ?? []).find((v) => String(v._id) === String(variant)) : current;
      if (!target) throw new HttpError(404, "Variant not found", "variant_not_found");

      let delta: number;
      let condition: Record<string, unknown>;
      if (typeof input.set === "number") {
        if (typeof input.expected !== "number") throw new HttpError(422, "Send the stock you saw as `expected`", "expected_required");
        delta = input.set - input.expected;
        condition = variant
          ? { variants: { $elemMatch: { _id: variant, stock: input.expected } } }
          : { stock: input.expected };
      } else if (typeof input.delta === "number" && input.delta !== 0) {
        delta = input.delta;
        condition = delta < 0
          ? variant
            ? { variants: { $elemMatch: { _id: variant, stock: { $gte: -delta } } } }
            : { stock: { $gte: -delta } }
          : {};
      } else {
        throw new HttpError(422, "Nothing to change", "invalid_adjustment");
      }

      if (delta === 0) {
        // A no-op set still proves the value was current.
        const same = await Product.exists({ _id: product, business: input.businessId, ...condition }).session(session);
        if (!same) throw new HttpError(409, "Stock changed while you were editing (probably a new order). Reload to see the current amount.", "stock_changed");
        result = { stock: input.set as number, delta: 0 };
        return;
      }

      const updated = await Product.findOneAndUpdate(
        { _id: product, business: input.businessId, ...condition },
        variant ? { $inc: { "variants.$[v].stock": delta, stock: delta } } : { $inc: { stock: delta } },
        { session, new: true, projection: { stock: 1, variants: 1 }, ...(variant ? { arrayFilters: [{ "v._id": variant }] } : {}) },
      );
      if (!updated) {
        throw typeof input.set === "number"
          ? new HttpError(409, "Stock changed while you were editing (probably a new order). Reload to see the current amount.", "stock_changed")
          : new HttpError(409, "There is not enough stock to remove that many", "insufficient_stock");
      }
      const stockAfter = stockAfterOf(updated, variant);
      await recordMovements(
        input.businessId,
        [{ product, variant, delta, stockAfter }],
        { reason: input.reason, actor: input.actorId, note: input.note },
        session,
      );
      result = { stock: stockAfter ?? 0, delta };
  };
  if (input.session) {
    await apply(input.session);
    return result;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => apply(session));
  } finally {
    await session.endSession();
  }
  if (result.delta < 0) notifyStock(input.businessId, [product]);
  return result;
}
