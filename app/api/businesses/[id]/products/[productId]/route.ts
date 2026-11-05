import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { assertObjectId } from "@/lib/ids";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertCanAddProduct } from "@/lib/billing";
import { productUpdateSchema, isValidCompareAtPrice } from "@/lib/validation";
import { assertMediaUrlsOwned } from "@/lib/media-references";
import { slugify } from "@/lib/slug";
import { Product } from "@/models/Product";
import { adjustStock } from "@/lib/inventory";
import { parseVariantPayload, saveProductVariants } from "@/lib/product-variant-service";
import { assertBusinessNotSuspended } from "@/lib/publish-gates";
import { restoreArchivedProduct } from "@/lib/product-restore";

interface RouteContext {
  params: Promise<{ id: string; productId: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, productId } = await context.params;
    const { membership, user } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const pid = assertObjectId(productId, "product id");
    const raw = await readJson(request);
    const body = productUpdateSchema.parse(raw);
    const variantPayload = parseVariantPayload(raw);
    await dbConnect();

    const product = await Product.findOne({ _id: pid, business: id });
    if (!product) throw new HttpError(404, "Product not found", "not_found");

    if (body.status !== undefined) await assertBusinessNotSuspended(id);
    if (body.status === "archived" && membership.role === "staff") {
      throw new HttpError(
        403,
        "Only owners and managers can archive products",
        "forbidden",
      );
    }

    await assertMediaUrlsOwned(id, [body.imageUrl, ...(body.images ?? [])]);

    // Reactivating an archived product increases the non-archived product count,
    // so it must respect the plan limit. Other status changes (draft <-> active)
    // do not change the count and archived-onward transitions decrease it.
    const reactivating =
      product.status === "archived" &&
      body.status !== undefined &&
      body.status !== "archived";
    if (reactivating) {
      await assertCanAddProduct(id);
    }

    if (body.name && body.name !== product.name) {
      const base = slugify(body.name) || product.slug;
      let slug = base;
      let counter = 1;
      while (await Product.exists({ business: id, slug, _id: { $ne: product._id } })) {
        counter += 1;
        slug = `${base}-${counter}`;
      }
      product.slug = slug;
    }

    // Stock edits: orders reserve stock by decrementing it, so an absolute write
    // based on a stale value would erase reservations and oversell. A change
    // needs `expectedStock` and is an atomic compare-and-set.
    const { expectedStock, ...fields } = body;
    const hasVariants = (product.options ?? []).length > 0 || (Array.isArray(variantPayload?.options) && (variantPayload.options as unknown[]).length > 0);
    if (hasVariants && fields.stock !== undefined) {
      throw new HttpError(422, "This product's stock is set per variant (Inventory)", "variant_stock");
    }
    if (fields.stock !== undefined && expectedStock === undefined && fields.stock !== product.stock) {
      throw new HttpError(422, "Send the stock you were shown as expectedStock, or adjust it in Inventory", "expected_stock_required");
    }
    const guarded = fields.stock !== undefined && expectedStock !== undefined;
    const requestedStock = fields.stock;
    delete fields.stock;

    // Sale pricing is checked against the price the product will have after
    // this edit (either field may change on its own).
    const nextPrice = fields.price ?? product.price;
    const nextCompareAt = fields.compareAtPrice !== undefined ? fields.compareAtPrice : product.compareAtPrice ?? null;
    if (!isValidCompareAtPrice(nextPrice, nextCompareAt)) {
      throw new HttpError(422, "The original price must be higher than the price", "invalid_compare_at_price");
    }

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        (product as unknown as Record<string, unknown>)[key] = value;
      }
    }
    // Validate the other changes before committing stock, so a rejected edit
    // never leaves a half-applied stock change behind.
    await product.validate();

    // Leaving the archive is all or nothing: the limit, this edit, its stock and its variants.
    if (reactivating) {
      const plain = product.toObject() as unknown as Record<string, unknown>;
      await restoreArchivedProduct({
        businessId: id,
        productId: String(pid),
        changes: Object.fromEntries(product.directModifiedPaths().map((path) => [path, plain[path]])),
        stock: guarded && requestedStock !== undefined ? { set: requestedStock, expected: expectedStock as number } : null,
        variants: variantPayload,
        actorId: String(user._id),
      });
      const restored = await Product.findOne({ _id: pid, business: id });
      return ok({ product: (restored ?? product).toJSON() });
    }

    let guardedStock: number | undefined;
    if (guarded && requestedStock !== undefined) {
      // Compare-and-set with a recorded movement (lib/inventory.ts).
      await adjustStock({
        businessId: id,
        productId: String(pid),
        set: requestedStock,
        expected: expectedStock,
        reason: "adjustment",
        note: "Product form",
        actorId: String(user._id),
      });
      guardedStock = requestedStock;
    }

    await product.save();
    if (variantPayload) {
      await saveProductVariants({ businessId: id, productId: pid, ...variantPayload, actorId: String(user._id) });
    }
    const fresh = await Product.findOne({ _id: pid, business: id });
    const json = (fresh ?? product).toJSON() as Record<string, unknown>;
    if (guardedStock !== undefined && !fresh) json.stock = guardedStock;
    return ok({ product: json });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, productId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const pid = assertObjectId(productId, "product id");
    await dbConnect();

    await assertBusinessNotSuspended(id);
    // Soft delete: archive instead of destroying data so it can be restored.
    const product = await Product.findOne({ _id: pid, business: id });
    if (!product) throw new HttpError(404, "Product not found", "not_found");

    product.status = "archived";
    await product.save();
    return ok({ archived: true, id: productId });
  });
}
