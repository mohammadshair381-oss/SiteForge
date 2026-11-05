import mongoose from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { assertMediaUrlsOwned } from "@/lib/media-references";
import { slugify } from "@/lib/slug";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { ProductCategory, type ProductCategoryDoc } from "@/models/ProductCategory";

/**
 * Server-only managed product categories. Callers authorise with
 * requireBusinessRole first. Writes are serialised per business (a write to
 * the business document inside the transaction) so names and slugs stay
 * unique even before the unique index exists. Categories are deactivated,
 * never deleted.
 */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive exact match on the product category text. */
export function categoryNameFilter(name: string): Record<string, unknown> {
  return { $regex: `^${escapeRegex(name.trim())}$`, $options: "i" };
}

const plain = (max: number) => z.string().trim().max(max).refine((v) => !/[<>]/.test(v), "Use plain text");

export const categoryInputSchema = z.object({
  name: plain(80).pipe(z.string().min(1, "Enter a name")),
  slug: z.string().trim().toLowerCase().max(64).regex(/^[a-z0-9-]*$/, "Use letters, numbers and dashes").prefault(""),
  description: plain(500).prefault(""),
  imageUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === "" || v.startsWith("/api/businesses/") || /^https:\/\//.test(v), "Use an image from your media library")
    .prefault(""),
  sort: z.coerce.number().int().min(0).max(10_000).optional(),
  active: z.boolean().prefault(true),
  /** Search-engine title/description. Omitted = kept as stored ("" clears). */
  seoTitle: plain(160).optional(),
  seoDescription: plain(320).optional(),
});

export interface CategoryView {
  id: string;
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  seoTitle: string;
  seoDescription: string;
  sort: number;
  active: boolean;
  productCount: number;
}

function toView(c: ProductCategoryDoc, productCount = 0): CategoryView {
  return { id: String(c._id), name: c.name, slug: c.slug, description: c.description ?? "", imageUrl: c.imageUrl ?? "", seoTitle: c.seoTitle ?? "", seoDescription: c.seoDescription ?? "", sort: c.sort ?? 0, active: c.active, productCount };
}

/** Product counts by lower-cased category text (non-archived products). */
async function countsByCategory(businessId: string): Promise<Map<string, { name: string; count: number }>> {
  const rows = await Product.aggregate<{ _id: string; name: string; count: number }>([
    { $match: { business: new mongoose.Types.ObjectId(businessId), status: { $ne: "archived" }, category: { $type: "string", $ne: "" } } },
    { $group: { _id: { $toLower: "$category" }, name: { $first: "$category" }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, { name: r.name, count: r.count }]));
}

export async function listCategories(businessId: string): Promise<{ categories: CategoryView[]; unmanaged: Array<{ name: string; productCount: number }> }> {
  await dbConnect();
  const [rows, counts] = await Promise.all([
    ProductCategory.find({ business: businessId }).sort({ sort: 1, name: 1 }).lean<ProductCategoryDoc[]>(),
    countsByCategory(businessId),
  ]);
  const managed = new Set(rows.map((r) => r.name.toLowerCase()));
  return {
    categories: rows.map((r) => toView(r, counts.get(r.name.toLowerCase())?.count ?? 0)),
    unmanaged: [...counts.entries()].filter(([key]) => !managed.has(key)).map(([, v]) => ({ name: v.name, productCount: v.count })),
  };
}

async function lockBusiness(businessId: string, session: mongoose.ClientSession): Promise<void> {
  const locked = await Business.updateOne({ _id: businessId }, { $set: { updatedAt: new Date() } }, { session, timestamps: false });
  if (locked.matchedCount === 0) throw new HttpError(404, "Business not found", "not_found");
}

async function uniqueSlug(businessId: string, wanted: string, excludeId: string | null, session: mongoose.ClientSession): Promise<string> {
  const base = slugify(wanted) || "category";
  let slug = base;
  for (let n = 2; await ProductCategory.exists({ business: businessId, slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).session(session); n++) {
    slug = `${base}-${n}`;
  }
  return slug;
}

export async function createCategory(businessId: string, input: unknown): Promise<CategoryView> {
  const data = categoryInputSchema.parse(input);
  await dbConnect();
  await assertMediaUrlsOwned(businessId, [data.imageUrl]);
  const session = await mongoose.startSession();
  let created: ProductCategoryDoc | null = null;
  try {
    await session.withTransaction(async () => {
      await lockBusiness(businessId, session);
      if (await ProductCategory.exists({ business: businessId, name: categoryNameFilter(data.name) }).session(session)) {
        throw new HttpError(409, "A category with this name already exists", "category_name_taken");
      }
      const slug = await uniqueSlug(businessId, data.slug || data.name, null, session);
      const last = await ProductCategory.findOne({ business: businessId }).sort({ sort: -1 }).select("sort").session(session).lean<{ sort: number }>();
      const [doc] = await ProductCategory.create([{ ...data, slug, business: businessId, sort: data.sort ?? (last ? last.sort + 1 : 0) }], { session });
      created = doc.toObject() as ProductCategoryDoc;
    });
  } finally {
    await session.endSession();
  }
  return toView(created as unknown as ProductCategoryDoc);
}

/**
 * Edits a category. A rename updates the category text of this business's
 * products in the same transaction, so the association never breaks.
 */
export async function updateCategory(businessId: string, categoryId: string, input: unknown): Promise<CategoryView> {
  const data = categoryInputSchema.parse(input);
  await dbConnect();
  await assertMediaUrlsOwned(businessId, [data.imageUrl]);
  const session = await mongoose.startSession();
  let updated: ProductCategoryDoc | null = null;
  try {
    await session.withTransaction(async () => {
      await lockBusiness(businessId, session);
      const current = await ProductCategory.findOne({ _id: categoryId, business: businessId }).session(session).lean<ProductCategoryDoc>();
      if (!current) throw new HttpError(404, "Category not found", "not_found");
      if (await ProductCategory.exists({ business: businessId, _id: { $ne: categoryId }, name: categoryNameFilter(data.name) }).session(session)) {
        throw new HttpError(409, "A category with this name already exists", "category_name_taken");
      }
      const slug = data.slug && data.slug !== current.slug ? await uniqueSlug(businessId, data.slug, categoryId, session) : current.slug;
      updated = await ProductCategory.findOneAndUpdate(
        { _id: categoryId, business: businessId },
        {
          $set: {
            name: data.name, slug, description: data.description, imageUrl: data.imageUrl, active: data.active,
            ...(data.sort !== undefined ? { sort: data.sort } : {}),
            ...(data.seoTitle !== undefined ? { seoTitle: data.seoTitle } : {}),
            ...(data.seoDescription !== undefined ? { seoDescription: data.seoDescription } : {}),
          },
        },
        { session, new: true },
      ).lean<ProductCategoryDoc>();
      if (current.name !== data.name) {
        await Product.updateMany({ business: businessId, category: categoryNameFilter(current.name) }, { $set: { category: data.name } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }
  return toView(updated as unknown as ProductCategoryDoc);
}

/** Explicit owner action: manage every category text that has products. */
export async function importCategories(businessId: string): Promise<number> {
  await dbConnect();
  const session = await mongoose.startSession();
  let createdCount = 0;
  try {
    await session.withTransaction(async () => {
      createdCount = 0;
      await lockBusiness(businessId, session);
      const counts = await countsByCategory(businessId);
      const existing = await ProductCategory.find({ business: businessId }).select("name sort").session(session).lean<Array<{ name: string; sort: number }>>();
      const managed = new Set(existing.map((e) => e.name.toLowerCase()));
      let sort = existing.reduce((max, e) => Math.max(max, e.sort ?? 0), -1) + 1;
      for (const [key, { name }] of [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))) {
        if (managed.has(key)) continue;
        const slug = await uniqueSlug(businessId, name, null, session);
        await ProductCategory.create([{ business: businessId, name: name.trim(), slug, sort: sort++, active: true }], { session });
        createdCount++;
      }
    });
  } finally {
    await session.endSession();
  }
  return createdCount;
}

/** Public data: active managed categories of a business (storefront). */
export interface PublicCategory {
  name: string;
  slug: string;
  description: string;
  imageUrl: string;
  seoTitle: string;
  seoDescription: string;
  sort: number;
  active: boolean;
}

export async function loadPublicCategories(businessId: unknown): Promise<PublicCategory[]> {
  await dbConnect();
  const rows = await ProductCategory.find({ business: businessId }).sort({ sort: 1, name: 1 }).lean<ProductCategoryDoc[]>();
  return rows.map((r) => ({ name: r.name, slug: r.slug, description: r.description ?? "", imageUrl: r.imageUrl ?? "", seoTitle: r.seoTitle ?? "", seoDescription: r.seoDescription ?? "", sort: r.sort ?? 0, active: r.active }));
}
