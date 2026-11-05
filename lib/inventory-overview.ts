import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { lowStockLevel, availabilityOf, type ProductAvailability } from "@/lib/inventory-rules";
import { variantLabel } from "@/lib/product-variants";
import { Product } from "@/models/Product";
import { InventoryMovement } from "@/models/InventoryMovement";

/**
 * Server-only read models for the dashboard Inventory page (business users of
 * this business only; callers authorise with requireBusinessRole first).
 * Exact counts are fine here: this is never served to shoppers.
 */

export interface InventoryRow {
  productId: string;
  productName: string;
  productStatus: string;
  variantId: string | null;
  label: string;
  sku: string;
  stock: number;
  threshold: number;
  state: ProductAvailability;
}

export async function listInventory(businessId: string): Promise<InventoryRow[]> {
  await dbConnect();
  const products = await Product.find({ business: businessId, status: { $ne: "archived" } })
    .select("name status sku stock options variants lowStockThreshold")
    .sort({ name: 1 })
    .lean();
  const rows: InventoryRow[] = [];
  for (const p of products) {
    const threshold = lowStockLevel(p.lowStockThreshold);
    if ((p.options ?? []).length > 0) {
      for (const v of p.variants ?? []) {
        if (v.archived) continue;
        rows.push({
          productId: String(p._id), productName: p.name, productStatus: p.status, variantId: String(v._id),
          label: variantLabel(v.options), sku: v.sku ?? "", stock: v.stock, threshold, state: availabilityOf(v.stock, p.lowStockThreshold),
        });
      }
    } else {
      rows.push({
        productId: String(p._id), productName: p.name, productStatus: p.status, variantId: null,
        label: "", sku: p.sku ?? "", stock: p.stock, threshold, state: availabilityOf(p.stock, p.lowStockThreshold),
      });
    }
  }
  return rows;
}

export interface MovementRow {
  id: string;
  variantId: string | null;
  delta: number;
  stockAfter: number | null;
  reason: string;
  orderId: string | null;
  note: string;
  createdAt: string;
}

export async function listMovements(businessId: string, productId: string, limit = 100): Promise<MovementRow[]> {
  await dbConnect();
  const rows = await InventoryMovement.find({
    business: new mongoose.Types.ObjectId(businessId),
    product: new mongoose.Types.ObjectId(productId),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .lean();
  return rows.map((m) => ({
    id: String(m._id),
    variantId: m.variant ? String(m.variant) : null,
    delta: m.delta,
    stockAfter: m.stockAfter ?? null,
    reason: m.reason,
    orderId: m.order ? String(m.order) : null,
    note: m.note ?? "",
    createdAt: new Date(m.createdAt).toISOString(),
  }));
}
