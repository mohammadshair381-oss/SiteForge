import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { Cart, type CartItem } from "@/models/Cart";
import { describeCartLines, type CartLineStatus } from "./lines";
import { CART_ABANDONED_AFTER_MS, CART_EXPIRY_MS } from "./rules";

/**
 * Abandoned carts for a store's owners and managers (server-only; callers authorise first).
 * Carts hold no contact details, and this adds none: a cart only says what was in it and
 * whether an account owned it. Nothing here sends anything to a shopper.
 */
const LIST_LIMIT = 50;
/** Most expired carts removed in one go. */
const PURGE_BATCH = 500;

/** Deletes carts past their expiry, oldest first. Only ever carts, and only expired ones. */
export async function purgeExpiredCarts(input: { businessId?: string; limit?: number; now?: Date } = {}): Promise<number> {
  await dbConnect();
  const cutoff = new Date((input.now ?? new Date()).getTime() - CART_EXPIRY_MS);
  const due = await Cart.find({ ...(input.businessId ? { business: input.businessId } : {}), updatedAt: { $lt: cutoff } })
    .sort({ updatedAt: 1 })
    .limit(Math.min(input.limit ?? PURGE_BATCH, PURGE_BATCH))
    .select("_id")
    .lean();
  if (due.length === 0) return 0;
  // Re-checks the date, so a cart used a moment ago is not removed.
  const result = await Cart.deleteMany({ _id: { $in: due.map((cart) => cart._id) }, updatedAt: { $lt: cutoff } });
  return result.deletedCount ?? 0;
}

export interface AbandonedCartView {
  id: string;
  updatedAt: string;
  createdAt: string;
  expiresAt: string;
  placedBy: "registered" | "guest";
  itemCount: number;
  /** At today's prices, counting only what could still be bought. */
  value: number;
  currency: string;
  /** Whether anything in it can still be bought. */
  recoverable: boolean;
  lines: Array<{ name: string; variantLabel: string; quantity: number; status: CartLineStatus }>;
}

export interface AbandonedCartSummary {
  active: number;
  abandoned: number;
  /** Came back to an abandoned cart within the 30 days a cart lasts. */
  recovered: number;
  carts: AbandonedCartView[];
}

export async function loadAbandonedCarts(businessId: string, now: Date = new Date()): Promise<AbandonedCartSummary> {
  await dbConnect();
  // Keeping the list honest is not worth failing the page over.
  await purgeExpiredCarts({ businessId, limit: 100, now }).catch(() => undefined);
  const business = new mongoose.Types.ObjectId(businessId);
  const abandonedBefore = new Date(now.getTime() - CART_ABANDONED_AFTER_MS);
  const hasItems = { "items.0": { $exists: true } };
  const where = { business, ...hasItems, updatedAt: { $lt: abandonedBefore } };
  const [active, abandoned, recovered, rows] = await Promise.all([
    Cart.countDocuments({ business, ...hasItems, updatedAt: { $gte: abandonedBefore } }),
    Cart.countDocuments(where),
    Cart.countDocuments({ business, ...hasItems, recoveredAt: { $ne: null, $exists: true } }),
    Cart.find(where).sort({ updatedAt: -1 }).limit(LIST_LIMIT).select("items updatedAt createdAt customer").lean<Array<{ _id: unknown; items: CartItem[]; updatedAt: Date; createdAt: Date; customer?: unknown }>>(),
  ]);
  const carts = await Promise.all(
    rows.map(async (row) => {
      const lines = await describeCartLines(row.items, businessId);
      const buyable = lines.filter((line) => line.status === "ok" || line.status === "insufficient_stock");
      return {
        id: String(row._id),
        updatedAt: new Date(row.updatedAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString(),
        expiresAt: new Date(new Date(row.updatedAt).getTime() + CART_EXPIRY_MS).toISOString(),
        placedBy: row.customer ? ("registered" as const) : ("guest" as const),
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        value: Math.round(buyable.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) * 100) / 100,
        currency: lines[0]?.currency ?? "USD",
        recoverable: buyable.length > 0,
        lines: lines.map((line) => ({ name: line.name || "Removed product", variantLabel: line.variantLabel, quantity: line.quantity, status: line.status })),
      };
    }),
  );
  return { active, abandoned, recovered, carts };
}
