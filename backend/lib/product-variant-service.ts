import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { recordMovements, type StockChange } from "@/lib/inventory";
import { assertMediaUrlsOwned } from "@/lib/media-references";
import {
  normalizeVariants,
  productOptionsSchema,
  productVariantsInputSchema,
  type ProductVariantInput,
} from "@/lib/product-variants";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Server-only: saves a product's options and variants. Callers authorise the
 * user for `businessId` first (requireBusinessRole).
 *
 * Never rewrites the whole `variants` array (that would overwrite stock that
 * concurrent checkouts just reserved): existing variants are changed with
 * targeted `$set`s that do not touch stock, new variants are `$push`ed with
 * their initial stock (and the product total `$inc`ed), and variants missing
 * from the request are archived, not removed. Stock of existing variants only
 * changes through stock adjustments (lib/inventory.ts).
 */

export function parseVariantPayload(raw: unknown): { options: unknown; variants: unknown } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (body.options === undefined && body.variants === undefined) return null;
  return { options: body.options ?? [], variants: body.variants ?? [] };
}

export async function saveProductVariants(input: {
  businessId: string;
  productId: unknown;
  options: unknown;
  variants: unknown;
  actorId: string;
  /** The caller's transaction, when this is one part of a larger change. */
  session?: mongoose.ClientSession;
}): Promise<void> {
  const options = productOptionsSchema.parse(input.options);
  const variants: ProductVariantInput[] = productVariantsInputSchema.parse(input.variants);
  const productId = new mongoose.Types.ObjectId(String(input.productId));
  await assertMediaUrlsOwned(input.businessId, variants.map((variant) => variant.imageUrl));

  const apply = async (session: mongoose.ClientSession) => {
      const product = await Product.findOne({ _id: productId, business: input.businessId })
        .select("price stock options variants")
        .session(session)
        .lean();
      if (!product) throw new HttpError(404, "Product not found", "not_found");
      const hadOptions = (product.options ?? []).length > 0;

      if (hadOptions && options.length === 0) {
        throw new HttpError(422, "A product with variants keeps its options. Archive variants you no longer sell.", "variants_required");
      }
      if (!hadOptions && options.length === 0) {
        if (variants.length > 0) throw new HttpError(422, "Add at least one option before adding variants", "invalid_variants");
        return; // simple product stays simple
      }

      const normalized = normalizeVariants(options, variants, product.price);
      if (!normalized.ok) throw new HttpError(422, normalized.errors.join("; "), "invalid_variants");

      const existingIds = new Set((product.variants ?? []).map((v) => String(v._id)));
      for (const v of normalized.variants) {
        if (v.id && !existingIds.has(v.id)) throw new HttpError(422, "A variant does not belong to this product", "invalid_variants");
      }

      // Converting a simple product: its open reservations were taken from the
      // product-level stock and could not be returned to a variant.
      if (!hadOptions) {
        const open = await Order.exists({
          business: input.businessId,
          status: "pending",
          inventoryState: "reserved",
          "items.product": String(productId),
        }).session(session);
        if (open) {
          throw new HttpError(409, "This product has unpaid orders holding stock. Add variants after they are paid or cancelled.", "pending_orders");
        }
      }

      // 1) Options and existing variants (never stock).
      const set: Record<string, unknown> = { options };
      const arrayFilters: Array<Record<string, unknown>> = [];
      const sentIds = new Set<string>();
      normalized.variants.filter((v) => v.id).forEach((v, index) => {
        const key = `e${index}`;
        sentIds.add(v.id as string);
        arrayFilters.push({ [`${key}._id`]: new mongoose.Types.ObjectId(v.id) });
        set[`variants.$[${key}].options`] = v.optionList;
        set[`variants.$[${key}].sku`] = v.sku;
        set[`variants.$[${key}].price`] = v.price;
        set[`variants.$[${key}].compareAtPrice`] = v.compareAtPrice;
        set[`variants.$[${key}].archived`] = v.archived;
        set[`variants.$[${key}].imageUrl`] = v.imageUrl;
      });
      // Variants left out of the request are archived (orders reference them).
      [...existingIds].filter((id) => !sentIds.has(id)).forEach((id, index) => {
        const key = `a${index}`;
        arrayFilters.push({ [`${key}._id`]: new mongoose.Types.ObjectId(id) });
        set[`variants.$[${key}].archived`] = true;
      });
      await Product.updateOne(
        { _id: productId, business: input.businessId },
        { $set: set },
        { session, ...(arrayFilters.length > 0 ? { arrayFilters } : {}) },
      );

      // 2) New variants with their initial stock; the product total follows.
      const fresh = normalized.variants
        .filter((v) => !v.id)
        .map((v) => ({
          _id: new mongoose.Types.ObjectId(),
          options: v.optionList,
          sku: v.sku,
          price: v.price,
          compareAtPrice: v.compareAtPrice,
          stock: v.stock ?? 0,
          archived: v.archived,
          imageUrl: v.imageUrl,
        }));
      const freshStock = fresh.reduce((n, v) => n + v.stock, 0);
      const changes: StockChange[] = fresh
        .filter((v) => v.stock > 0)
        .map((v) => ({ product: productId, variant: v._id, delta: v.stock, stockAfter: v.stock }));

      if (!hadOptions) {
        // Product stock becomes the sum of its variants. Any old product-level
        // stock is written off with a recorded movement.
        await Product.updateOne(
          { _id: productId, business: input.businessId },
          { $push: { variants: { $each: fresh } }, $set: { stock: freshStock } },
          { session },
        );
        if (product.stock > 0) {
          await recordMovements(input.businessId, [{ product: productId, variant: null, delta: -product.stock, stockAfter: 0 }], {
            reason: "variants_created",
            actor: input.actorId,
            note: "Product stock replaced by variant stock",
          }, session);
        }
      } else if (fresh.length > 0) {
        await Product.updateOne(
          { _id: productId, business: input.businessId },
          { $push: { variants: { $each: fresh } }, $inc: { stock: freshStock } },
          { session },
        );
      }
      await recordMovements(input.businessId, changes, { reason: "initial", actor: input.actorId, note: "New variant" }, session);
  };
  if (input.session) {
    await apply(input.session);
    return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => apply(session));
  } finally {
    await session.endSession();
  }
}
