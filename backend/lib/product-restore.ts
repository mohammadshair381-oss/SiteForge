import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { assertCanAddProduct } from "@/lib/billing";
import { adjustStock, recordMovements } from "@/lib/inventory";
import { notifyStock } from "@/lib/notification-events";
import { saveProductVariants } from "@/lib/product-variant-service";
import { withUsageCheck } from "@/lib/usage-limits";
import { Product } from "@/models/Product";

interface StockState {
  stock?: number;
  options?: unknown[];
  variants?: Array<{ stock: number }>;
}

/** Stock is kept while archived, so it should still add up. If it does not, restoring would sell what is not there. */
function assertInventoryConsistent(product: StockState): void {
  const stock = Number(product.stock ?? 0);
  const variants = product.variants ?? [];
  const hasVariants = (product.options ?? []).length > 0;
  const sane = Number.isInteger(stock) && stock >= 0 && variants.every((variant) => Number.isInteger(variant.stock) && variant.stock >= 0);
  if (!sane || (hasVariants && variants.reduce((sum, variant) => sum + variant.stock, 0) !== stock)) {
    throw new HttpError(409, "This product's stock records do not add up, so it was left archived and nothing was changed. Please contact support.", "inventory_inconsistent");
  }
}

/**
 * Brings a product back from the archive with everything that came with the request, as one
 * transaction: the plan's limit, the status and other fields, a history entry saying who restored
 * it, any stock change and any variant changes. If any of them fails, none of it happened.
 * History is only added to. Archived variants stay archived unless the request changes them.
 */
export async function restoreArchivedProduct(input: {
  businessId: string;
  productId: string;
  /** The fields this edit changes, including `status`. */
  changes: Record<string, unknown>;
  stock: { set: number; expected: number } | null;
  variants: { options: unknown; variants: unknown } | null;
  actorId: string;
}): Promise<void> {
  const product = new mongoose.Types.ObjectId(input.productId);
  await withUsageCheck(
    (session) => assertCanAddProduct(input.businessId, session),
    async (session) => {
      const scope = { _id: product, business: input.businessId, status: "archived" };
      const current = await Product.findOne(scope).select("stock options variants").session(session).lean<StockState>();
      if (!current) throw new HttpError(409, "This product is no longer archived. Reload to see its current state.", "not_archived");
      assertInventoryConsistent(current);
      await Product.updateOne(scope, { $set: input.changes }, { session });
      await recordMovements(input.businessId, [{ product, variant: null, delta: 0, stockAfter: Number(current.stock ?? 0) }], { reason: "product_restored", actor: input.actorId, note: "Restored from archive" }, session);
      if (input.stock) {
        await adjustStock({ businessId: input.businessId, productId: input.productId, set: input.stock.set, expected: input.stock.expected, reason: "adjustment", note: "Product form", actorId: input.actorId, session });
      }
      if (input.variants) {
        await saveProductVariants({ businessId: input.businessId, productId: product, ...input.variants, actorId: input.actorId, session });
      }
    },
  );
  notifyStock(input.businessId, [product]);
}
