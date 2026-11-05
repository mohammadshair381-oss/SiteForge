import { dbConnect } from "@/lib/db";
import { handle, ok, created, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertCanAddProduct } from "@/lib/billing";
import { withUsageCheck } from "@/lib/usage-limits";
import { productCreateSchema } from "@/lib/validation";
import { assertMediaUrlsOwned } from "@/lib/media-references";
import { slugify } from "@/lib/slug";
import { Product } from "@/models/Product";
import { InventoryMovement } from "@/models/InventoryMovement";
import { parseVariantPayload, saveProductVariants } from "@/lib/product-variant-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET [?status=archived]` — current products, or the archived ones to restore. */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();
    const archived = new URL(request.url).searchParams.get("status") === "archived";
    const products = await Product.find({
      business: id,
      status: archived ? "archived" : { $ne: "archived" },
    })
      .sort({ createdAt: -1 })
      .lean();
    return ok({ products });
  });
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();
    await assertCanAddProduct(id);

    const raw = await readJson(request);
    const body = productCreateSchema.parse(raw);
    const variantPayload = parseVariantPayload(raw);
    const withVariants = Array.isArray(variantPayload?.options) && (variantPayload.options as unknown[]).length > 0;
    await assertMediaUrlsOwned(id, [body.imageUrl, ...(body.images ?? [])]);

    const base = slugify(body.name) || `product-${Date.now().toString(36)}`;
    let slug = base;
    let counter = 1;
    while (await Product.exists({ business: id, slug })) {
      counter += 1;
      slug = `${base}-${counter}`;
    }

    // A variant product's stock is the sum of its variants (added below).
    // One transaction, so invalid variants can never leave a half-created product behind.
    const product = await withUsageCheck(
      (session) => assertCanAddProduct(id, session),
      async (session) => {
        const [doc] = await Product.create([{ ...body, ...(withVariants ? { stock: 0 } : {}), business: id, slug }], { session });
        if (withVariants && variantPayload) {
          await saveProductVariants({ businessId: id, productId: doc._id, ...variantPayload, actorId: String(user._id), session });
        } else if (doc.stock > 0) {
          await InventoryMovement.create(
            [{ business: id, product: doc._id, variant: null, delta: doc.stock, stockAfter: doc.stock, reason: "initial", actor: user._id, note: "Product created" }],
            { session },
          );
        }
        return doc;
      },
    );

    const fresh = await Product.findById(product._id);
    return created({ product: (fresh ?? product).toJSON() });
  });
}
