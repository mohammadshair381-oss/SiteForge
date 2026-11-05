import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as productsRoute from "@/app/api/businesses/[id]/products/route";
import * as productRoute from "@/app/api/businesses/[id]/products/[productId]/route";
import * as cartRoute from "@/app/api/businesses/[id]/cart/route";
import * as ordersRoute from "@/app/api/businesses/[id]/orders/route";
import * as inventoryRoute from "@/app/api/businesses/[id]/inventory/route";
import * as movementsRoute from "@/app/api/businesses/[id]/inventory/[productId]/movements/route";
import { cancelOrder } from "@/lib/orders/lifecycle";
import { toStorefrontView } from "@/lib/storefront";
import { getPublicStorefront } from "@/lib/tenant";
import { Product } from "@/models/Product";
import { Order } from "@/models/Order";
import { InventoryMovement } from "@/models/InventoryMovement";

/**
 * Product variants and inventory: per-variant price/SKU/stock, server-side
 * selection validation, exact variant on orders, no overselling under
 * concurrency, restock on cancellation, adjustments with history, and no
 * stock counts in the public view.
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
  return { owner, business, id: String(business._id), host: `${business.subdomain}.localhost:3000` };
}

const shirtBody = {
  name: "Linen Shirt",
  price: 40,
  status: "active",
  options: [
    { name: "Size", values: ["S", "M", "L"] },
    { name: "Color", values: ["White", "Blue"] },
  ],
  variants: [
    { options: { Size: "S", Color: "White" }, sku: "SH-S-W", stock: 2 },
    { options: { Size: "M", Color: "White" }, sku: "SH-M-W", stock: 1 },
    { options: { Size: "L", Color: "Blue" }, sku: "SH-L-B", price: 45, stock: 5 },
  ],
};

async function createShirt(id: string, owner: Actor) {
  const res = await api(productsRoute.POST, "POST", `/api/businesses/${id}/products`, { id }, owner, shirtBody);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const product = await Product.findById(res.body.product._id).lean();
  const v = (size: string, color: string) => product!.variants.find((x) => x.options[0].value === size && x.options[1].value === color)!;
  return { product: product!, sw: v("S", "White"), mw: v("M", "White"), lb: v("L", "Blue") };
}

/** Storefront cart call with the store Host and a cart cookie. */
async function cart(method: string, host: string, token: string, body?: unknown, query = "") {
  const handler = (cartRoute as Record<string, unknown>)[method] as (r: Request) => Promise<Response>;
  const res = await handler(
    new Request(`http://localhost/api/businesses/x/cart${query}`, {
      method,
      headers: { "content-type": "application/json", host, cookie: `cart-token=${token}`, "x-forwarded-for": "203.0.113.9" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function checkout(host: string, token: string) {
  const res = await ordersRoute.POST(
    new Request("http://localhost/api/businesses/x/orders", {
      method: "POST",
      headers: { "content-type": "application/json", host, cookie: `cart-token=${token}`, "x-forwarded-for": "203.0.113.9" },
      body: JSON.stringify({ customerName: "Ada", customerEmail: "ada@example.com", idempotencyKey: crypto.randomUUID() }),
    }),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("variant product: per-variant SKU, price and stock; product stock is the sum; initial history", async () => {
  const { owner, id } = await store();
  const { product, lb } = await createShirt(id, owner);
  assert.equal(product.stock, 8);
  assert.equal(product.variants.length, 3);
  assert.equal(lb.price, 45);
  assert.equal(lb.sku, "SH-L-B");
  const initial = await InventoryMovement.find({ product: product._id, reason: "initial" }).lean();
  assert.equal(initial.reduce((n, m) => n + m.delta, 0), 8);

  // Invalid matrices are rejected (value not offered, duplicate combination).
  for (const variants of [
    [{ options: { Size: "XL", Color: "White" } }],
    [{ options: { Size: "S", Color: "White" } }, { options: { Size: "s", Color: "white" } }],
    [{ options: { Size: "S" } }],
  ]) {
    const res = await api(productsRoute.POST, "POST", `/api/businesses/${id}/products`, { id }, owner, { ...shirtBody, name: `Bad ${crypto.randomUUID()}`, variants });
    assert.equal(res.status, 422, JSON.stringify(variants));
  }
  assert.equal(await Product.countDocuments({ business: id }), 1, "rejected products are not left behind");
});

test("cart validates the selection server-side and keeps one line per variant", async () => {
  const { owner, id, host } = await store();
  const other = await store();
  const { product, sw, lb } = await createShirt(id, owner);
  const foreign = await createShirt(other.id, other.owner);
  const token = crypto.randomUUID();

  assert.equal((await cart("POST", host, token, { productId: String(product._id) })).body.code, "variant_required");
  assert.equal((await cart("POST", host, token, { productId: String(product._id), variantId: String(foreign.sw._id) })).body.code, "variant_unavailable");
  assert.equal((await cart("POST", host, token, { productId: String(product._id), variantId: String(sw._id), quantity: 3 })).body.code, "out_of_stock");

  await cart("POST", host, token, { productId: String(product._id), variantId: String(sw._id) });
  const res = await cart("POST", host, token, { productId: String(product._id), variantId: String(lb._id), quantity: 2 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((i: any) => [i.variantLabel, i.quantity, i.priceSnapshot]), [
    ["Size: S / Color: White", 1, 40],
    ["Size: L / Color: Blue", 2, 45],
  ]);
  const removed = await cart("DELETE", host, token, undefined, `?productId=${product._id}&variantId=${lb._id}`);
  assert.equal(removed.body.items.length, 1);
});

test("checkout records the exact variant, reserves its stock, and cancellation restores it", async () => {
  const { owner, id, host } = await store();
  const { product, lb } = await createShirt(id, owner);
  const token = crypto.randomUUID();
  await cart("POST", host, token, { productId: String(product._id), variantId: String(lb._id), quantity: 2 });
  const placed = await checkout(host, token);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));

  const order = await Order.findById(placed.body.orderId).lean();
  assert.deepEqual(
    { variant: order!.items[0].variant, label: order!.items[0].variantLabel, sku: order!.items[0].sku, unit: order!.items[0].unitPrice },
    { variant: String(lb._id), label: "Size: L / Color: Blue", sku: "SH-L-B", unit: 45 },
  );
  assert.equal(order!.total, 90);
  let p = await Product.findById(product._id).lean();
  assert.equal(p!.variants.find((v) => String(v._id) === String(lb._id))!.stock, 3);
  assert.equal(p!.stock, 6);
  assert.equal(await InventoryMovement.countDocuments({ order: order!._id, reason: "order_reserved" }), 1);

  // Editing the variant (SKU/price) never overwrites the reserved stock.
  const edit = await api(productRoute.PATCH, "PATCH", `/api/businesses/${id}/products/${product._id}`, { id, productId: String(product._id) }, owner, {
    options: shirtBody.options,
    variants: p!.variants.map((v) => ({ id: String(v._id), options: Object.fromEntries(v.options.map((o) => [o.name, o.value])), sku: `${v.sku}-2`, price: v.price, stock: 999 })),
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  p = await Product.findById(product._id).lean();
  assert.equal(p!.variants.find((v) => String(v._id) === String(lb._id))!.stock, 3, "edit must not touch stock");
  assert.equal(p!.stock, 6);

  const cancelled = await cancelOrder({ orderId: String(order!._id), businessId: id, reason: "customer" });
  assert.equal(cancelled.applied, true);
  p = await Product.findById(product._id).lean();
  assert.equal(p!.variants.find((v) => String(v._id) === String(lb._id))!.stock, 5);
  assert.equal(p!.stock, 8);
  assert.equal(await InventoryMovement.countDocuments({ order: order!._id, reason: "order_released" }), 1);
});

test("concurrent checkouts can never oversell a variant", async () => {
  const { owner, id, host } = await store();
  const { product, mw } = await createShirt(id, owner); // M/White has 1 unit
  const tokens = Array.from({ length: 5 }, () => crypto.randomUUID());
  for (const token of tokens) {
    // Seed carts directly: the cart API would (correctly) refuse after the first sale.
    const { Cart } = await import("@/models/Cart");
    await Cart.create({ business: id, ownerToken: token, items: [{ product: String(product._id), variant: String(mw._id), variantLabel: "x", quantity: 1, priceSnapshot: 40, currency: "USD" }] });
  }
  const results = await Promise.all(tokens.map((t) => checkout(host, t)));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "out_of_stock"));
  const p = await Product.findById(product._id).lean();
  assert.equal(p!.variants.find((v) => String(v._id) === String(mw._id))!.stock, 0);
  assert.equal(p!.stock, 7);
});

test("archived variants cannot be bought; a stale cart line fails at checkout without side effects", async () => {
  const { owner, id, host } = await store();
  const { product, sw, mw, lb } = await createShirt(id, owner);
  const token = crypto.randomUUID();
  await cart("POST", host, token, { productId: String(product._id), variantId: String(sw._id) });
  // Archive S/White by leaving it out of the variant list.
  const res = await api(productRoute.PATCH, "PATCH", `/api/businesses/${id}/products/${product._id}`, { id, productId: String(product._id) }, owner, {
    options: shirtBody.options,
    variants: [mw, lb].map((v) => ({ id: String(v._id), options: Object.fromEntries(v.options.map((o) => [o.name, o.value])), sku: v.sku, price: v.price })),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const stored = await Product.findById(product._id).lean();
  assert.equal(stored!.variants.find((v) => String(v._id) === String(sw._id))!.archived, true);
  assert.equal(stored!.variants.length, 3, "archived, not removed");

  const placed = await checkout(host, token);
  assert.equal(placed.body.code, "variant_unavailable");
  assert.equal(await Order.countDocuments({ business: id }), 0);
  assert.equal((await cart("POST", host, crypto.randomUUID(), { productId: String(product._id), variantId: String(sw._id) })).body.code, "variant_unavailable");

  // The public view lists purchasable variants with availability only.
  const result = await getPublicStorefront(host);
  const view = toStorefrontView(result!.business, result!.products, false);
  const shirt = view.products.find((x) => x.id === String(product._id))!;
  assert.deepEqual(shirt.variants!.map((v) => [v.label, v.availability]), [
    ["Size: M / Color: White", "low_stock"],
    ["Size: L / Color: Blue", "low_stock"],
  ]);
  assert.ok(!JSON.stringify(view).includes('"stock"'), "no stock counts in the public view");
});

test("a simple product with open reservations cannot be converted to variants", async () => {
  const { owner, id, host } = await store();
  const created = await api(productsRoute.POST, "POST", `/api/businesses/${id}/products`, { id }, owner, { name: "Mug", price: 10, stock: 5, status: "active" });
  const productId = created.body.product._id;
  const token = crypto.randomUUID();
  await cart("POST", host, token, { productId });
  assert.equal((await checkout(host, token)).status, 200);
  const res = await api(productRoute.PATCH, "PATCH", `/api/businesses/${id}/products/${productId}`, { id, productId }, owner, {
    options: [{ name: "Color", values: ["Red"] }],
    variants: [{ options: { Color: "Red" }, stock: 3 }],
  });
  assert.equal(res.body.code, "pending_orders");
  assert.equal((await Product.findById(productId).lean())!.stock, 4);
});

test("stock adjustments: atomic, never negative, compare-and-set, history, role and tenant checks", async () => {
  const { owner, id, business } = await store();
  const other = await store();
  const { product, sw } = await createShirt(id, owner);
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const adjust = (actor: Actor, body: unknown, bizId = id) => api(inventoryRoute.POST, "POST", `/api/businesses/${bizId}/inventory`, { id: bizId }, actor, body);
  const pid = String(product._id);

  assert.equal((await adjust(staff, { productId: pid, variantId: String(sw._id), delta: 10, reason: "restock" })).status, 200, "staff may restock");
  assert.equal((await adjust(owner, { productId: pid, variantId: String(sw._id), delta: -50, reason: "damage" })).body.code, "insufficient_stock");
  assert.equal((await adjust(owner, { productId: pid, delta: 1, reason: "restock" })).body.code, "variant_required");
  assert.equal((await adjust(owner, { productId: pid, variantId: String(sw._id), set: 3, expected: 5, reason: "correction" })).body.code, "stock_changed");
  const set = await adjust(owner, { productId: pid, variantId: String(sw._id), set: 4, expected: 12, reason: "correction", note: "Counted" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.stock, 4);
  // Another business cannot adjust (or even see) this product.
  assert.equal((await adjust(other.owner, { productId: pid, variantId: String(sw._id), delta: 1, reason: "restock" })).status, 403);
  assert.equal((await adjust(other.owner, { productId: pid, variantId: String(sw._id), delta: 1, reason: "restock" }, other.id)).status, 404);

  const p = await Product.findById(product._id).lean();
  assert.equal(p!.stock, 4 + 1 + 5, "product total follows the variants");
  const history = await api(movementsRoute.GET, "GET", `/api/businesses/${id}/inventory/${pid}/movements`, { id, productId: pid }, staff);
  assert.deepEqual(history.body.movements.slice(0, 2).map((m: any) => [m.reason, m.delta, m.stockAfter, m.note]), [
    ["correction", -8, 4, "Counted"],
    ["restock", 10, 12, ""],
  ]);
  const overview = await api(inventoryRoute.GET, "GET", `/api/businesses/${id}/inventory`, { id }, staff);
  assert.deepEqual(overview.body.items.map((r: any) => [r.label, r.stock, r.state]), [
    ["Size: S / Color: White", 4, "low_stock"],
    ["Size: M / Color: White", 1, "low_stock"],
    ["Size: L / Color: Blue", 5, "low_stock"],
  ]);
});

test("simple products keep working; stock form edits are recorded", async () => {
  const { owner, id, host } = await store();
  const created = await api(productsRoute.POST, "POST", `/api/businesses/${id}/products`, { id }, owner, { name: "Plain Mug", price: 12, stock: 3, status: "active", lowStockThreshold: 2 });
  const productId = created.body.product._id;
  const token = crypto.randomUUID();
  assert.equal((await cart("POST", host, token, { productId, quantity: 2 })).status, 200);
  assert.equal((await cart("POST", host, crypto.randomUUID(), { productId, variantId: new mongoose.Types.ObjectId().toString() })).body.code, "variant_unavailable");
  assert.equal((await checkout(host, token)).status, 200);
  const edit = await api(productRoute.PATCH, "PATCH", `/api/businesses/${id}/products/${productId}`, { id, productId }, owner, { stock: 10, expectedStock: 1 });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.product.stock, 10);
  const reasons = (await InventoryMovement.find({ product: productId }).sort({ createdAt: 1, _id: 1 }).lean()).map((m) => [m.reason, m.delta]);
  assert.deepEqual(reasons, [["initial", 3], ["order_reserved", -2], ["adjustment", 9]]);
});
