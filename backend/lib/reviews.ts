import mongoose from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";
import { hiddenOnEveryScreen, type ResponsiveSettings } from "@/lib/section-responsive";
import type { StoreReview } from "@/lib/storefront";
import { ProductReview, type ProductReviewDoc, type ReviewStatus } from "@/models/ProductReview";

/**
 * Server-only product reviews. Rules:
 * - verified purchase only: the shopper proves ownership of a PAID order of
 *   this business (order proof, like the order status page), and the product
 *   must be in that order;
 * - one review per (order, product), serialised on the order document;
 * - plain text, bounded length, at most 2 links, rate-limited by the route;
 * - every review starts `pending`; only an owner/manager approval publishes
 *   it. The product's rating summary counts APPROVED reviews only and is
 *   recomputed in the moderation transaction.
 * Nothing here can create a review without an order, or a rating out of 1-5.
 */

const plain = (max: number) =>
  z.string().trim().max(max).refine((v) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), "Use plain text");

export const reviewInputSchema = z
  .object({
    productId: z.string().regex(/^[a-f0-9]{24}$/i),
    rating: z.number().int().min(1).max(5),
    title: plain(100).prefault(""),
    body: plain(2000).prefault(""),
  })
  .refine((v) => ((v.title + " " + v.body).match(/https?:\/\/|www\./gi) ?? []).length <= 2, {
    message: "Please remove links from your review",
    path: ["body"],
  });

/** "Ada Lovelace" -> "Ada L." (no e-mail or full surname is published). */
export function reviewAuthorName(customerName: string): string {
  const parts = customerName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Verified buyer";
  const first = parts[0].slice(0, 30);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.` : first;
}

interface OwnedOrder {
  _id: mongoose.Types.ObjectId;
  business: mongoose.Types.ObjectId;
  status: string;
  customerName: string;
  items: Array<{ product: string; productName: string; variantLabel?: string }>;
}

/** Reviewable products of an order the caller already proved they own. */
export async function reviewableItems(order: OwnedOrder): Promise<Array<{ productId: string; productName: string; review: { status: ReviewStatus; rating: number } | null }>> {
  if (order.status !== "paid") return [];
  await dbConnect();
  const existing = await ProductReview.find({ order: order._id }).select("product status rating").lean();
  const byProduct = new Map(existing.map((r) => [String(r.product), r]));
  const seen = new Set<string>();
  const out: Array<{ productId: string; productName: string; review: { status: ReviewStatus; rating: number } | null }> = [];
  for (const item of order.items ?? []) {
    const id = String(item.product);
    if (seen.has(id)) continue;
    seen.add(id);
    const review = byProduct.get(id);
    out.push({ productId: id, productName: item.productName, review: review ? { status: review.status, rating: review.rating } : null });
  }
  return out;
}

export async function submitReview(order: OwnedOrder, input: unknown): Promise<{ id: string; status: ReviewStatus }> {
  const data = reviewInputSchema.parse(input);
  if (order.status !== "paid") {
    throw new HttpError(409, "You can review products once your order is paid", "review_not_eligible");
  }
  if (!(order.items ?? []).some((i) => String(i.product) === data.productId)) {
    throw new HttpError(404, "That product is not in this order", "review_not_eligible");
  }
  await dbConnect();
  const session = await mongoose.startSession();
  let created: ProductReviewDoc | null = null;
  try {
    await session.withTransaction(async () => {
      // Serialise reviews of this order (and re-check it is still paid).
      const locked = await Order.updateOne(
        { _id: order._id, business: order.business, status: "paid" },
        { $set: { updatedAt: new Date() } },
        { session, timestamps: false },
      );
      if (locked.matchedCount === 0) throw new HttpError(409, "You can review products once your order is paid", "review_not_eligible");
      if (await ProductReview.exists({ order: order._id, product: data.productId }).session(session)) {
        throw new HttpError(409, "You have already reviewed this product", "review_exists");
      }
      if (!(await Product.exists({ _id: data.productId, business: order.business }).session(session))) {
        throw new HttpError(404, "That product is not available", "review_not_eligible");
      }
      const [doc] = await ProductReview.create(
        [
          {
            business: order.business,
            product: data.productId,
            order: order._id,
            authorName: reviewAuthorName(order.customerName),
            rating: data.rating,
            title: data.title,
            body: data.body,
            status: "pending",
          },
        ],
        { session },
      );
      created = doc.toObject() as ProductReviewDoc;
    });
  } finally {
    await session.endSession();
  }
  const review = created as unknown as ProductReviewDoc;
  return { id: String(review._id), status: review.status };
}

/** Recomputes a product's approved-review summary (inside a transaction). */
async function refreshSummary(businessId: unknown, productId: unknown, session: mongoose.ClientSession): Promise<void> {
  const [summary] = await ProductReview.aggregate<{ avg: number; count: number }>([
    { $match: { business: new mongoose.Types.ObjectId(String(businessId)), product: new mongoose.Types.ObjectId(String(productId)), status: "approved" } },
    { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]).session(session);
  await Product.updateOne(
    { _id: productId, business: businessId },
    { $set: { ratingAverage: summary ? Math.round(summary.avg * 100) / 100 : null, ratingCount: summary?.count ?? 0 } },
    { session },
  );
}

export async function moderateReview(input: { businessId: string; reviewId: string; action: "approve" | "reject"; actorId: string }): Promise<ReviewView> {
  await dbConnect();
  const session = await mongoose.startSession();
  let updated: ProductReviewDoc | null = null;
  try {
    await session.withTransaction(async () => {
      updated = await ProductReview.findOneAndUpdate(
        { _id: input.reviewId, business: input.businessId },
        { $set: { status: input.action === "approve" ? "approved" : "rejected", moderatedBy: input.actorId, moderatedAt: new Date() } },
        { session, new: true },
      ).lean<ProductReviewDoc>();
      if (!updated) throw new HttpError(404, "Review not found", "not_found");
      // The product summary follows in the same transaction.
      await refreshSummary(input.businessId, updated.product, session);
    });
  } finally {
    await session.endSession();
  }
  return toView(updated as unknown as ProductReviewDoc);
}

export interface ReviewView {
  id: string;
  productId: string;
  productName?: string;
  authorName: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  createdAt: string;
}

function toView(r: ProductReviewDoc, productName?: string): ReviewView {
  return {
    id: String(r._id), productId: String(r.product), ...(productName ? { productName } : {}), authorName: r.authorName,
    rating: r.rating, title: r.title ?? "", body: r.body ?? "", status: r.status, createdAt: new Date(r.createdAt).toISOString(),
  };
}

/** Owner/manager list (callers authorise first). */
export async function listReviewsForBusiness(businessId: string, status: ReviewStatus | null): Promise<ReviewView[]> {
  await dbConnect();
  const rows = await ProductReview.find({ business: businessId, ...(status ? { status } : {}) }).sort({ createdAt: -1 }).limit(200).lean<ProductReviewDoc[]>();
  const names = new Map(
    (await Product.find({ _id: { $in: rows.map((r) => r.product) }, business: businessId }).select("name").lean()).map((p) => [String(p._id), p.name]),
  );
  return rows.map((r) => toView(r, names.get(String(r.product))));
}

const MAX_STORE_REVIEWS = 12;
/** What a reviews section shows when it does not say (components/storefront/SectionRenderer.tsx). */
const DEFAULT_SECTION_REVIEWS = 6;

interface LooseReviewSection {
  type?: string;
  visible?: boolean;
  settings?: { limit?: number };
  style?: { responsive?: ResponsiveSettings };
}

/**
 * How many approved reviews these sections show: 0 means none is visible, so nothing is read.
 * Takes page sections, or homepage sections, where a content block sits inside `block`.
 */
export function reviewsWanted(sections: unknown): number {
  if (!Array.isArray(sections)) return 0;
  let wanted = 0;
  for (const entry of sections as Array<(LooseReviewSection & { enabled?: boolean; block?: LooseReviewSection; responsive?: ResponsiveSettings }) | null>) {
    const section = entry?.type === "block" ? entry.block : entry;
    if (!entry || !section || entry.enabled === false || section.type !== "reviews" || section.visible === false) continue;
    if (hiddenOnEveryScreen(entry.responsive) || hiddenOnEveryScreen(section.style?.responsive)) continue;
    wanted = Math.max(wanted, section.settings?.limit ?? DEFAULT_SECTION_REVIEWS);
  }
  return Math.min(wanted, MAX_STORE_REVIEWS);
}

/** Public: this store's newest approved reviews, for a reviews section. Never fails a page. */
export async function recentApprovedReviews(businessId: unknown, limit = MAX_STORE_REVIEWS): Promise<StoreReview[]> {
  try {
    await dbConnect();
    const rows = await ProductReview.find({ business: businessId, status: "approved", order: { $exists: true } }).sort({ createdAt: -1 }).limit(Math.min(Math.max(limit, 1), MAX_STORE_REVIEWS)).select("product authorName rating title body").lean<ProductReviewDoc[]>();
    const products = await Product.find({ _id: { $in: rows.map((row) => row.product) }, business: businessId }).select("name").lean<Array<{ _id: unknown; name: string }>>();
    const nameOf = new Map(products.map((product) => [String(product._id), product.name]));
    return rows.map((row) => ({ id: String(row._id), authorName: row.authorName, rating: row.rating, title: row.title ?? "", body: row.body ?? "", productName: nameOf.get(String(row.product)) ?? "" }));
  } catch {
    return [];
  }
}

/** Public: approved reviews of one product (newest first). */
export async function approvedReviews(businessId: unknown, productId: unknown, limit = 10): Promise<ReviewView[]> {
  await dbConnect();
  const rows = await ProductReview.find({ business: businessId, product: productId, status: "approved" })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<ProductReviewDoc[]>();
  return rows.map((r) => toView(r));
}
