import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { call, freshIp, login, registerVerified, sessionCookie, setCookies, store } from "./helpers/customer-accounts";
import { GET as cartGET, POST as cartPOST } from "@/app/api/businesses/[id]/cart/route";
import { drainAfterResponseTasks } from "@/lib/after-response";
import { clearEmailOutbox } from "@/lib/email";
import { Cart } from "@/models/Cart";
import { Customer } from "@/models/Customer";
import { Product } from "@/models/Product";

/**
 * A signed-in customer's account cart (one per store) absorbing a guest cart
 * (`mergeGuestCart`, lib/cart/shopper-cart.ts). The account cart used to lose its
 * own lines here: they were copied from Mongoose subdocuments, which keeps the
 * document's internals rather than its fields. Route handlers run against the
 * in-memory replica set, where the account-cart index exists.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
  await connectTestDB();
});
after(async () => {
  delete process.env.CUSTOMER_ACCOUNTS_ENABLED;
  clearRequestCookies();
  await drainAfterResponseTasks();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  process.env.CUSTOMER_ACCOUNTS_ENABLED = "true";
  clearRequestCookies();
  await drainAfterResponseTasks();
  clearEmailOutbox();
  await clearAllCollections();
});

const EMAIL = "ada@example.com";
const EARLIER_VISIT = "Items from your earlier visit were added to your cart.";

async function product(businessId: unknown, name: string, price: number, stock = 10) {
  return Product.create({
    business: businessId,
    name,
    slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
    price,
    currency: "USD",
    stock,
    status: "active",
  });
}

function cartToken(response: Response): string {
  const raw = setCookies(response).find((c) => c.startsWith("cart-token="));
  assert.ok(raw, "cart cookie");
  return raw.split(";")[0].slice("cart-token=".length);
}

/** A new guest cart (no session) holding these lines; returns its token. */
async function guestCart(host: string, lines: Array<[unknown, number]>): Promise<string> {
  let token: string | null = null;
  for (const [productId, quantity] of lines) {
    const response = await call(cartPOST, host, { productId: String(productId), quantity }, { ip: freshIp(), ...(token ? { cookie: `cart-token=${token}` } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    token = cartToken(response);
  }
  assert.ok(token);
  return token;
}

/** A signed-in cart request carrying a guest cart's cookie: this is what merges it. */
async function visitSignedIn(host: string, session: string, token: string): Promise<Response> {
  const response = await call(cartGET, host, undefined, { ip: freshIp(), cookie: `cart-token=${token}; ${session}` });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}

/** A signed-in customer whose account cart already holds `accountLines`. */
async function customerWithAccountCart(lines: Array<[unknown, number]> | ((businessId: unknown) => Promise<Array<[unknown, number]>>)) {
  const shop = await store();
  await registerVerified(shop.host, EMAIL);
  const session = sessionCookie(await login(shop.host, EMAIL));
  const customer = await Customer.findOne({ business: shop.business._id, email: EMAIL }).lean();
  assert.ok(customer);
  const resolved = typeof lines === "function" ? await lines(shop.business._id) : lines;
  const first = await guestCart(shop.host, resolved);
  // The customer's first cart simply becomes theirs.
  const claimed = await visitSignedIn(shop.host, session, first);
  assert.equal(cartToken(claimed), first);
  const account = await Cart.findOne({ business: shop.business._id, customer: customer._id }).lean();
  assert.equal(account?.ownerToken, first, "the first cart became the account cart");
  return { ...shop, session, customerId: customer._id as mongoose.Types.ObjectId, accountToken: first };
}

const linesOf = (items: Array<{ product: unknown; quantity: number }>) =>
  items.map((item) => [String(item.product), item.quantity] as const).sort(([a], [b]) => a.localeCompare(b));

test("merging keeps the account cart's items, adds the guest's, and adds up a product in both", async () => {
  const shop = await store();
  const [tea, mug, pot] = await Promise.all([product(shop.business._id, "Tea", 5), product(shop.business._id, "Mug", 12), product(shop.business._id, "Pot", 30)]);
  await registerVerified(shop.host, EMAIL);
  const session = sessionCookie(await login(shop.host, EMAIL));
  const customer = await Customer.findOne({ business: shop.business._id, email: EMAIL }).lean();
  const accountToken = await guestCart(shop.host, [[tea._id, 1], [mug._id, 2]]);
  await visitSignedIn(shop.host, session, accountToken);

  const guestToken = await guestCart(shop.host, [[tea._id, 2], [pot._id, 1]]);
  const merged = await visitSignedIn(shop.host, session, guestToken);
  assert.equal(cartToken(merged), accountToken, "the response points the browser at the account cart");

  const account = await Cart.findOne({ business: shop.business._id, customer: customer?._id }).lean();
  assert.ok(account);
  assert.deepEqual(linesOf(account.items), linesOf([
    { product: tea._id, quantity: 3 },
    { product: mug._id, quantity: 2 },
    { product: pot._id, quantity: 1 },
  ]));
  assert.equal(account.subtotal, 3 * 5 + 2 * 12 + 30);
  assert.equal(account.total, account.subtotal);
  assert.ok(account.notices?.includes(EARLIER_VISIT));
  assert.equal(await Cart.countDocuments({ ownerToken: guestToken }), 0, "the guest cart is used up");
  assert.equal(await Cart.countDocuments({ business: shop.business._id }), 1, "one cart per customer per store");

  // Persisted: a later visit with only the account cart shows the same lines.
  const later = await call(cartGET, shop.host, undefined, { ip: freshIp(), cookie: `cart-token=${accountToken}; ${session}` });
  const body = (await later.json()) as { items: Array<{ product: string; quantity: number }>; subtotal: number };
  assert.deepEqual(linesOf(body.items), linesOf(account.items));
  assert.equal(body.subtotal, 69);
});

test("merging an empty guest cart leaves the account cart's items in place", async () => {
  const shop = await customerWithAccountCart(async (businessId) => {
    const [tea, mug] = await Promise.all([product(businessId, "Tea", 5), product(businessId, "Mug", 12)]);
    return [[tea._id, 2], [mug._id, 1]];
  });
  const beforeMerge = await Cart.findOne({ business: shop.business._id, customer: shop.customerId }).lean();
  const emptyToken = crypto.randomUUID();
  await Cart.create({ business: shop.business._id, ownerToken: emptyToken, items: [], subtotal: 0, total: 0 });

  await visitSignedIn(shop.host, shop.session, emptyToken);
  const afterMerge = await Cart.findOne({ business: shop.business._id, customer: shop.customerId }).lean();
  assert.deepEqual(linesOf(afterMerge?.items ?? []), linesOf(beforeMerge?.items ?? []));
  assert.equal(afterMerge?.subtotal, 2 * 5 + 12);
  assert.ok(!afterMerge?.notices?.includes(EARLIER_VISIT), "nothing came from the empty cart");
  assert.equal(await Cart.countDocuments({ ownerToken: emptyToken }), 0);
});

test("merging still drops unavailable lines and another store's products, and limits quantities to stock", async () => {
  const shop = await store();
  const other = await store();
  const tea = await product(shop.business._id, "Tea", 5, 3);
  const mug = await product(shop.business._id, "Mug", 12);
  const pot = await product(shop.business._id, "Pot", 30);
  const foreign = await product(other.business._id, "Foreign", 1);
  await registerVerified(shop.host, EMAIL);
  const session = sessionCookie(await login(shop.host, EMAIL));
  const customer = await Customer.findOne({ business: shop.business._id, email: EMAIL }).lean();
  const accountToken = await guestCart(shop.host, [[tea._id, 2], [mug._id, 1]]);
  await visitSignedIn(shop.host, session, accountToken);

  const guestToken = await guestCart(shop.host, [[tea._id, 2], [pot._id, 1]]);
  // A line naming another store's product can only come from a forged or stale record.
  await Cart.updateOne({ ownerToken: guestToken }, { $push: { items: { product: String(foreign._id), variant: "", quantity: 1, priceSnapshot: 1, currency: "USD" } } });
  await Product.updateOne({ _id: mug._id }, { $set: { status: "archived" } });

  await visitSignedIn(shop.host, session, guestToken);
  const account = await Cart.findOne({ business: shop.business._id, customer: customer?._id }).lean();
  assert.ok(account);
  assert.deepEqual(linesOf(account.items), linesOf([
    { product: tea._id, quantity: 3 },
    { product: pot._id, quantity: 1 },
  ]), "tea limited to its stock of 3; the archived mug and the foreign product are gone");
  assert.ok(!account.items.some((item) => String(item.product) === String(foreign._id)));
  assert.equal(account.subtotal, 3 * 5 + 30);
  const notices = account.notices ?? [];
  assert.ok(notices.some((n) => n.includes("Mug") && n.includes("no longer available")), notices.join(" | "));
  assert.ok(notices.some((n) => n.includes("fewer of Tea")), notices.join(" | "));
  assert.equal(await Product.countDocuments({ _id: foreign._id, business: other.business._id }), 1, "the other store's product is untouched");
});

test("another store's guest cart never merges into this store's account cart", async () => {
  const shop = await customerWithAccountCart(async (businessId) => [[(await product(businessId, "Tea", 5))._id, 1]]);
  const other = await store();
  const elsewhere = await product(other.business._id, "Elsewhere", 7);
  const otherToken = await guestCart(other.host, [[elsewhere._id, 2]]);
  const beforeMerge = await Cart.findOne({ business: shop.business._id, customer: shop.customerId }).lean();

  // The other store's cart cookie arrives with this store's session.
  await visitSignedIn(shop.host, shop.session, otherToken);
  const afterMerge = await Cart.findOne({ business: shop.business._id, customer: shop.customerId }).lean();
  assert.deepEqual(linesOf(afterMerge?.items ?? []), linesOf(beforeMerge?.items ?? []));
  const untouched = await Cart.findOne({ business: other.business._id, ownerToken: otherToken }).lean();
  assert.ok(untouched, "the other store's cart still exists");
  assert.equal(untouched.customer, undefined, "and still belongs to no customer");
  assert.deepEqual(linesOf(untouched.items), [[String(elsewhere._id), 2]]);
});
