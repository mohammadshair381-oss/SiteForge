
import { dbConnect } from "./db";
import { HttpError } from "./api";
import { assertCanAddProduct } from "./billing";
import { withUsageCheck } from "./usage-limits";
import { slugify } from "./slug";
import { SAMPLE_PRODUCT_COUNT, sampleCatalogFor } from "./theme-preview-samples";
import type { ThemeId } from "./constants";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";

/**
 * Starter sample products: a few ready-made products that suit the store, so a
 * new owner edits instead of starting from an empty page (owner decision,
 * 2026-11-17: hidden drafts).
 *
 * - Every sample is a DRAFT marked `sample` (its bundled photo's name). Drafts
 *   are never shown to shoppers, and the product route refuses to make a sample
 *   active until the owner changes its name, price or photo, which clears the
 *   mark. So no sample can reach a shopper as it is.
 * - Stock 0 (no inventory movement), no description, no sale price, no rating:
 *   nothing is invented beyond a name, a category and a suggested price.
 * - Each one goes through the plan's product limit in its own transaction
 *   (`withUsageCheck`), and at most SAMPLE_PRODUCT_COUNT are added, fewer when
 *   the plan has less room. A store never gets samples it already has.
 * - The photo is not stored as `imageUrl` (that must be this store's own
 *   media): only the dashboard shows it, from public/samples.
 */
export { SAMPLE_PRODUCT_COUNT };

/** Adds the starter samples for this store. Returns how many were added. */
export async function addSampleProducts(businessId: string): Promise<number> {
  await dbConnect();
  const business = await Business.findById(businessId).select("themeId category currency").lean<{ themeId: ThemeId; category?: string; currency?: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const existing = await Product.find({ business: businessId, sample: { $nin: ["", null] } }).select("sample").lean<Array<{ sample?: string }>>();
  const have = new Set(existing.map((product) => product.sample));
  const catalog = sampleCatalogFor(business.themeId, business.category).filter((item) => !have.has(item.image));
  const wanted = catalog.slice(0, Math.max(0, SAMPLE_PRODUCT_COUNT - existing.length));

  let added = 0;
  for (const item of wanted) {
    const base = `sample-${slugify(item.name) || item.image}`.slice(0, 80);
    let slug = base;
    for (let counter = 2; await Product.exists({ business: businessId, slug }); counter += 1) slug = `${base}-${counter}`;
    try {
      await withUsageCheck(
        (session) => assertCanAddProduct(businessId, session),
        (session) =>
          Product.create(
            [
              {
                business: businessId,
                name: item.name,
                slug,
                price: item.price,
                currency: business.currency || "USD",
                category: item.category,
                imageAlt: item.name,
                stock: 0,
                status: "draft",
                sample: item.image,
              },
            ],
            { session },
          ),
      );
      added += 1;
    } catch (error) {
      // No room left on the plan (or no active plan): the owner's own products come first.
      if (error instanceof HttpError && error.status === 402) break;
      throw error;
    }
  }
  return added;
}

/**
 * Archives every sample that is still a sample (soft, like every product delete:
 * nothing is erased, and restoring brings it back as a draft sample).
 */
export async function archiveSampleProducts(businessId: string): Promise<number> {
  await dbConnect();
  const result = await Product.updateMany(
    { business: businessId, sample: { $nin: ["", null] }, status: { $ne: "archived" } },
    { $set: { status: "archived" } },
  );
  return result.modifiedCount;
}

/** How many samples the owner still has to replace (not archived). */
export async function countSampleProducts(businessId: string): Promise<number> {
  await dbConnect();
  return Product.countDocuments({ business: businessId, sample: { $nin: ["", null] }, status: { $ne: "archived" } });
}
