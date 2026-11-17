import { created, handle, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertCanAddProduct } from "@/lib/billing";
import { withUsageCheck } from "@/lib/usage-limits";
import { assertObjectId } from "@/lib/ids";
import { dbConnect } from "@/lib/db";
import { saveProductVariants } from "@/lib/product-variant-service";
import { slugify } from "@/lib/slug";
import { Product } from "@/models/Product";

interface RouteContext {
  params: Promise<{ id: string; productId: string }>;
}

/**
 * `POST` — copies a product into a new DRAFT, within the plan's product limit. A
 * copy starts with no stock and no SKUs (they identify physical items), and never
 * copies reviews or ratings, which belong to the original.
 */
export async function POST(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, productId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    const pid = assertObjectId(productId, "product id");
    await dbConnect();
    await assertCanAddProduct(id);
    const source = await Product.findOne({ _id: pid, business: id }).lean();
    if (!source) throw new HttpError(404, "Product not found", "not_found");

    const name = `${source.name} (copy)`.slice(0, 160);
    const base = slugify(name) || `product-${Date.now().toString(36)}`;
    let slug = base;
    for (let counter = 2; await Product.exists({ business: id, slug }); counter += 1) slug = `${base}-${counter}`;

    const options = source.options ?? [];
    const variants = (source.variants ?? [])
      .filter((variant) => !variant.archived)
      .map((variant) => ({ options: Object.fromEntries(variant.options.map((option) => [option.name, option.value])), sku: "", price: variant.price ?? null, compareAtPrice: variant.compareAtPrice ?? null, stock: 0 }));
    // One transaction, so a copy whose variants cannot be saved never exists at all.
    const copy = await withUsageCheck(
      (session) => assertCanAddProduct(id, session),
      async (session) => {
        const [doc] = await Product.create(
          [
            {
              business: id,
              name,
              slug,
              description: source.description,
              price: source.price,
              compareAtPrice: source.compareAtPrice ?? null,
              currency: source.currency,
              imageUrl: source.imageUrl,
              images: source.images ?? [],
              imageAlt: source.imageAlt ?? "",
              category: source.category,
              seoTitle: source.seoTitle ?? "",
              seoDescription: source.seoDescription ?? "",
              lowStockThreshold: source.lowStockThreshold ?? null,
              stock: 0,
              status: "draft",
              // A copy of a sample is still a sample (lib/sample-products.ts).
              sample: source.sample ?? "",
            },
          ],
          { session },
        );
        if (options.length > 0) {
          await saveProductVariants({ businessId: id, productId: doc._id, options, variants, actorId: String(user._id), session });
        }
        return doc;
      },
    );
    const fresh = await Product.findOne({ _id: copy._id, business: id });
    return created({ product: (fresh ?? copy).toJSON() });
  });
}
