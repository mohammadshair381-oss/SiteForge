import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import crypto from "node:crypto";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as ordersRoute from "@/app/api/businesses/[id]/orders/route";
import * as reviewsRoute from "@/app/api/storefront/orders/[orderId]/reviews/route";
import * as ownerReviewsRoute from "@/app/api/businesses/[id]/reviews/route";
import * as ownerReviewRoute from "@/app/api/businesses/[id]/reviews/[reviewId]/route";
import * as categoriesRoute from "@/app/api/businesses/[id]/categories/route";
import * as categoryRoute from "@/app/api/businesses/[id]/categories/[categoryId]/route";
import { getCategoryMetadata, getSitemapForHost } from "@/lib/seo";
import { getPublicStorefront } from "@/lib/tenant";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { productJsonLd } from "@/lib/structured-data";
import { Cart } from "@/models/Cart";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";
import { ProductReview } from "@/models/ProductReview";

/**
 * Verified-purchase reviews with moderation, managed categories (rename keeps
 * products linked, storefront links, isolation), and SEO outputs built from
 * real data only.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };

async function api(handler: unknown, method: string, url: string, params: Record<string, string>, actor: Actor | null, body?: unknown) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost", ...auth },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function store() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  const tea = await Product.create({ business: business._id, name: "Green Tea", slug: "green-tea", price: 10, currency: "USD", stock: 50, status: "active", category: "Tea", imageUrl: "https://cdn.example.com/tea.jpg" });
  const mug = await Product.create({ business: business._id, name: "Mug", slug: "mug", price: 12, currency: "USD", stock: 50, status: "active", category: "kitchen" });
  return { owner, business, id: String(business._id), host: `${business.subdomain}.localhost:3000`, tea, mug };
}

/** Places a guest order and returns its id and proof (as the browser would get). */
async function placeOrder(host: string, businessId: string, productId: unknown, name = "Ada Lovelace") {
  const token = crypto.randomUUID();
  await Cart.create({ business: businessId, ownerToken: token, items: [{ product: String(productId), quantity: 1, priceSnapshot: 10, currency: "USD" }] });
  const res = await ordersRoute.POST(new Request("http://localhost/api/businesses/x/orders", {
    method: "POST",
    headers: { "content-type": "application/json", host, cookie: `cart-token=${token}`, "x-forwarded-for": "203.0.113.70" },
    body: JSON.stringify({ customerName: name, customerEmail: "ada@example.com", idempotencyKey: crypto.randomUUID() }),
  }));
  const body = (await res.json()) as Record<string, any>;
  return { orderId: body.orderId as string, proof: body.orderProof as string };
}

async function review(host: string, orderId: string, proof: string | null, method: "GET" | "POST", body?: unknown) {
  const handler = method === "GET" ? reviewsRoute.GET : reviewsRoute.POST;
  const res = await handler(
    new Request(`http://localhost/api/storefront/orders/${orderId}/reviews`, {
      method,
      headers: { "content-type": "application/json", host, "x-forwarded-for": "203.0.113.71", ...(proof ? { "x-order-proof": proof } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ orderId }) } as never,
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("reviews: verified paid purchases only, one per product, moderated, no fabricated ratings", async () => {
  const { owner, id, host, tea, mug, business } = await store();
  const other = await store();
  const { orderId, proof } = await placeOrder(host, id, tea._id);

  // Unpaid order: nothing to review; wrong/no proof and another store: 404.
  assert.deepEqual((await review(host, orderId, proof, "GET")).body.items, []);
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 5 })).body.code, "review_not_eligible");
  await Order.updateOne({ _id: orderId }, { $set: { status: "paid", paidAt: new Date() } });
  assert.equal((await review(host, orderId, null, "POST", { productId: String(tea._id), rating: 5 })).status, 404);
  assert.equal((await review(host, orderId, "not-the-proof", "POST", { productId: String(tea._id), rating: 5 })).status, 404);
  assert.equal((await review(other.host, orderId, proof, "POST", { productId: String(tea._id), rating: 5 })).status, 404);

  // Only products in the order; ratings 1-5; no HTML; limited links.
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(mug._id), rating: 5 })).body.code, "review_not_eligible");
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 6 })).status, 422);
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 5, body: "<script>x</script>" })).status, 422);
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 5, body: "http://a.example http://b.example http://c.example" })).status, 422);

  const created = await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 4, title: "Lovely", body: "Fresh and fragrant." });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.review.status, "pending");
  assert.equal((await review(host, orderId, proof, "POST", { productId: String(tea._id), rating: 1 })).body.code, "review_exists");
  const stored = await ProductReview.findOne({ order: orderId }).lean();
  assert.equal(stored!.authorName, "Ada L.", "no surname or e-mail published");

  // Pending reviews never count.
  let product = await Product.findById(tea._id).lean();
  assert.equal(product!.ratingCount ?? 0, 0);
  const frame = async () => loadStorefrontFrame((await getPublicStorefront(host))!, null);
  assert.equal((await frame()).view.products.find((p) => p.slug === "green-tea")!.rating, undefined);

  // Moderation: owners/managers of this business only.
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const reviewId = String(stored!._id);
  assert.equal((await api(ownerReviewRoute.PATCH, "PATCH", `/api/businesses/${id}/reviews/${reviewId}`, { id, reviewId }, staff, { action: "approve" })).status, 403);
  assert.equal((await api(ownerReviewRoute.PATCH, "PATCH", `/api/businesses/${other.id}/reviews/${reviewId}`, { id: other.id, reviewId }, other.owner, { action: "approve" })).status, 404);
  assert.equal((await api(ownerReviewsRoute.GET, "GET", `/api/businesses/${id}/reviews?status=pending`, { id }, owner)).body.reviews.length, 1);
  const approved = await api(ownerReviewRoute.PATCH, "PATCH", `/api/businesses/${id}/reviews/${reviewId}`, { id, reviewId }, owner, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  product = await Product.findById(tea._id).lean();
  assert.deepEqual([product!.ratingAverage, product!.ratingCount], [4, 1]);
  assert.deepEqual((await frame()).view.products.find((p) => p.slug === "green-tea")!.rating, { average: 4, count: 1 });

  // A second verified review, then unpublishing one: the summary follows.
  const second = await placeOrder(host, id, tea._id, "Grace Hopper");
  await Order.updateOne({ _id: second.orderId }, { $set: { status: "paid", paidAt: new Date() } });
  const r2 = await review(host, second.orderId, second.proof, "POST", { productId: String(tea._id), rating: 5 });
  await api(ownerReviewRoute.PATCH, "PATCH", `/api/businesses/${id}/reviews/${r2.body.review.id}`, { id, reviewId: r2.body.review.id }, owner, { action: "approve" });
  assert.deepEqual([(await Product.findById(tea._id).lean())!.ratingAverage, (await Product.findById(tea._id).lean())!.ratingCount], [4.5, 2]);
  await api(ownerReviewRoute.PATCH, "PATCH", `/api/businesses/${id}/reviews/${reviewId}`, { id, reviewId }, owner, { action: "reject" });
  assert.deepEqual([(await Product.findById(tea._id).lean())!.ratingAverage, (await Product.findById(tea._id).lean())!.ratingCount], [5, 1]);
});

test("categories: managed, renamed with their products, tenant-scoped, linked from the store", async () => {
  const { owner, id, host, business } = await store();
  const other = await store();
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");

  const list = await api(categoriesRoute.GET, "GET", `/api/businesses/${id}/categories`, { id }, owner);
  assert.deepEqual(list.body.unmanaged.map((u: any) => u.name).sort(), ["Tea", "kitchen"]);
  assert.equal((await api(categoriesRoute.POST, "POST", `/api/businesses/${id}/categories`, { id }, staff, { action: "import" })).status, 403);
  const imported = await api(categoriesRoute.POST, "POST", `/api/businesses/${id}/categories`, { id }, manager, { action: "import" });
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.unmanaged.length, 0);
  assert.equal((await api(categoriesRoute.POST, "POST", `/api/businesses/${id}/categories`, { id }, owner, { name: "TEA" })).body.code, "category_name_taken");

  const kitchen = imported.body.categories.find((c: any) => c.name === "kitchen");
  const renamed = await api(categoryRoute.PUT, "PUT", `/api/businesses/${id}/categories/${kitchen.id}`, { id, categoryId: kitchen.id }, owner, {
    name: "Kitchen & Dining", slug: "kitchen", description: "Mugs and more", active: true,
  });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await Product.findOne({ business: id, slug: "mug" }).lean())!.category, "Kitchen & Dining", "products follow a rename");
  assert.equal((await Product.findOne({ business: other.id, slug: "mug" }).lean())!.category, "kitchen", "other stores are untouched");
  assert.equal((await api(categoryRoute.PUT, "PUT", `/api/businesses/${other.id}/categories/${kitchen.id}`, { id: other.id, categoryId: kitchen.id }, other.owner, { name: "X" })).status, 404);

  // Storefront: managed order and /category links; a hidden category disappears.
  let commerce = (await loadStorefrontFrame((await getPublicStorefront(host))!, null)).commerce;
  // Imported by product count, then name ("kitchen" before "Tea").
  assert.deepEqual(commerce.header.categoryLinks.map((l) => l.href), ["/category/kitchen", "/category/tea"]);
  const tea = imported.body.categories.find((c: any) => c.name === "Tea");
  await api(categoryRoute.PUT, "PUT", `/api/businesses/${id}/categories/${tea.id}`, { id, categoryId: tea.id }, owner, { name: "Tea", slug: "tea", active: false });
  commerce = (await loadStorefrontFrame((await getPublicStorefront(host))!, null)).commerce;
  assert.deepEqual(commerce.header.categoryLinks.map((l) => l.href), ["/category/kitchen"]);

  // SEO: category metadata and sitemap list only active categories with products.
  const meta = await getCategoryMetadata(host, "kitchen");
  assert.equal((meta.title as { absolute: string }).absolute, `Kitchen & Dining | ${business.name}`);
  assert.equal(meta.description, "Mugs and more");
  assert.deepEqual(await getCategoryMetadata(host, "tea"), {}, "hidden category has no metadata");
  const sitemap = (await getSitemapForHost(host)).map((e) => e.url);
  assert.ok(sitemap.some((u) => u.endsWith("/category/kitchen")));
  assert.ok(!sitemap.some((u) => u.endsWith("/category/tea")));
});

test("structured data: real prices and availability; rating only with approved reviews", async () => {
  const { host } = await store();
  const result = (await getPublicStorefront(host))!;
  const { view } = await loadStorefrontFrame(result, null);
  const tea = view.products.find((p) => p.slug === "green-tea")!;
  const ld = productJsonLd({ product: tea, url: "https://x.example/product/green-tea", origin: "https://x.example", sellerName: view.name, images: [tea.imageUrl] });
  assert.equal((ld.offers as any)["@type"], "Offer");
  assert.equal((ld.offers as any).price, 10);
  assert.equal((ld.offers as any).availability, "https://schema.org/InStock");
  assert.equal("aggregateRating" in ld, false);
  const rated = productJsonLd({ product: tea, url: "u", origin: "o", sellerName: "s", images: [], rating: { average: 4.5, count: 2 } });
  assert.deepEqual((rated.aggregateRating as any).reviewCount, 2);
});
