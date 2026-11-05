import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as settingsRoute from "@/app/api/businesses/[id]/storefront/route";
import * as publishSettingsRoute from "@/app/api/businesses/[id]/storefront/publish/route";
import * as publishStoreRoute from "@/app/api/businesses/[id]/publish/route";
import * as productRoute from "@/app/api/businesses/[id]/products/[productId]/route";
import { getPublicStorefront } from "@/lib/tenant";
import { loadBestSellerIds, loadStorefrontFrame } from "@/lib/storefront-commerce";
import { Business } from "@/models/Business";
import { Media } from "@/models/Media";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";
import { User } from "@/models/User";

/**
 * Storefront homepage settings: owner/manager-only draft + publish, tenant
 * isolation, validation of every reference, draft never public, best sellers
 * only from this store's paid orders, and real sale pricing.
 */

const PUBLIC_BASE = "https://cdn.test";

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) {
    throw new Error(`Test harness using unexpected MongoDB URI: ${uri}`);
  }
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
  process.env.AWS_S3_PUBLIC_URL = PUBLIC_BASE;
});

type Actor = { _id: unknown; tokenVersion: number };

async function call(
  handler: unknown,
  method: "GET" | "PUT" | "POST" | "PATCH",
  url: string,
  params: Record<string, string>,
  actor: Actor | null,
  body?: unknown,
  extra: { origin?: string; contentType?: string } = {},
) {
  const auth = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost${url}`, {
      method,
      headers: {
        "content-type": extra.contentType ?? "application/json",
        host: "localhost",
        ...(extra.origin ? { origin: extra.origin } : {}),
        ...auth,
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

const saveDraft = (businessId: unknown, actor: Actor | null, body: unknown, extra = {}) =>
  call(settingsRoute.PUT, "PUT", `/api/businesses/${businessId}/storefront`, { id: String(businessId) }, actor, body, extra);
const getSettings = (businessId: unknown, actor: Actor | null) =>
  call(settingsRoute.GET, "GET", `/api/businesses/${businessId}/storefront`, { id: String(businessId) }, actor);
const publishSettings = (businessId: unknown, actor: Actor | null) =>
  call(publishSettingsRoute.POST, "POST", `/api/businesses/${businessId}/storefront/publish`, { id: String(businessId) }, actor, {});

async function setup() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  await Business.updateOne({ _id: business._id }, { $set: { "themeSettings.primaryColor": "#123456" } });
  const product = await Product.create({ business: business._id, name: "Green Tea", slug: "green-tea", price: 100, stock: 5, status: "active", category: "Tea" });
  return { owner, business, product, host: `${business.subdomain}.localhost:3000` };
}

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  hero: { headline: "Fresh tea, every week", primaryCta: { label: "Shop tea", href: "/products?category=Tea" } },
  announcement: { enabled: true, text: "Free delivery this week" },
  ...overrides,
});

test("only owners and managers of this business can read or save storefront settings", async () => {
  const { owner, business } = await setup();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const other = await createBusinessWithOwner();

  assert.equal((await saveDraft(business._id, null, draftBody())).status, 401);
  assert.equal((await saveDraft(business._id, staff, draftBody())).status, 403);
  assert.equal((await saveDraft(business._id, other.owner, draftBody())).status, 403);
  assert.equal((await getSettings(business._id, staff)).status, 403);
  assert.equal((await getSettings(business._id, other.owner)).status, 403);
  assert.equal((await saveDraft(business._id, owner, draftBody(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await saveDraft(business._id, owner, draftBody(), { contentType: "text/plain" })).status, 415);

  const saved = await saveDraft(business._id, manager, draftBody());
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.draft.hero.headline, "Fresh tea, every week");
  const read = await getSettings(business._id, owner);
  assert.equal(read.body.draft.hero.headline, "Fresh tea, every week");
  assert.equal(read.body.published, null);
  assert.equal(read.body.hasUnpublishedChanges, true);

  // Only the storefront key was written; other theme settings are untouched.
  const stored = await Business.findById(business._id).lean();
  const ts = stored!.themeSettings as unknown as Record<string, unknown>;
  assert.equal(ts.primaryColor, "#123456");
  assert.equal((ts.storefront as { hero: { headline: string } }).hero.headline, "Fresh tea, every week");
  // The other business is unchanged.
  const otherStored = await Business.findById(other.business._id).lean();
  assert.equal((otherStored!.themeSettings as unknown as Record<string, unknown>).storefront, undefined);
});

test("invalid content and foreign references are rejected", async () => {
  const { owner, business } = await setup();
  const other = await setup();

  const html = await saveDraft(business._id, owner, draftBody({ hero: { headline: "<b>Sale</b>" } }));
  assert.equal(html.status, 422);
  const external = await saveDraft(business._id, owner, draftBody({ hero: { primaryCta: { label: "Go", href: "https://evil.example" } } }));
  assert.equal(external.status, 422);
  const social = await saveDraft(business._id, owner, draftBody({ footer: { social: { instagram: "https://evil.example/x" } } }));
  assert.equal(social.status, 422);

  // Featured products must be this business's own, non-archived products.
  const foreign = await saveDraft(business._id, owner, draftBody({ featuredProductIds: [String(other.product._id)] }));
  assert.equal(foreign.status, 422);
  assert.equal(foreign.body.code, "invalid_featured_product");
  const archived = await Product.create({ business: business._id, name: "Old", slug: "old", price: 5, status: "archived" });
  assert.equal((await saveDraft(business._id, owner, draftBody({ featuredProductIds: [String(archived._id)] }))).status, 422);

  // Media owned by another business cannot be used.
  const storageKey = `media/${String(other.business._id)}/hero-image`;
  await Media.create({ business: other.business._id, storageKey, originalName: "hero.png", mimeType: "image/png", size: 128 });
  const media = await saveDraft(business._id, owner, draftBody({ hero: { imageUrl: `${PUBLIC_BASE}/${storageKey}` } }));
  assert.equal(media.status, 400);
  assert.equal(media.body.code, "invalid_media_reference");

  // Nothing was stored by the rejected requests.
  const stored = await Business.findById(business._id).lean();
  assert.equal((stored!.themeSettings as unknown as Record<string, unknown>).storefront, undefined);
});

test("local-storage media (no S3 configured): own images are accepted, foreign keys are not", async () => {
  const { owner, business } = await setup();
  const other = await setup();
  const saved = { aws: process.env.AWS_S3_PUBLIC_URL, s3: process.env.S3_PUBLIC_URL, local: process.env.LOCAL_MEDIA_ENABLED };
  delete process.env.AWS_S3_PUBLIC_URL;
  delete process.env.S3_PUBLIC_URL;
  process.env.LOCAL_MEDIA_ENABLED = "true";
  try {
    const local = (businessId: unknown, key: string) =>
      `/api/businesses/${String(businessId)}/local-media?key=${Buffer.from(key).toString("base64")}`;
    const ownKey = `media/${String(business._id)}/hero.png`;
    const otherKey = `media/${String(other.business._id)}/hero.png`;
    for (const [biz, key] of [[business._id, ownKey], [other.business._id, otherKey]] as const) {
      await Media.create({ business: biz, storageKey: key, originalName: "hero.png", mimeType: "image/png", size: 128 });
    }

    const ok = await saveDraft(business._id, owner, draftBody({ hero: { imageUrl: local(business._id, ownKey) } }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    for (const url of [
      local(other.business._id, otherKey), // another business's image
      local(business._id, otherKey), // own id in the path, foreign key
      local(business._id, `media/${String(business._id)}/../${String(other.business._id)}/hero.png`), // traversal
      local(business._id, `media/${String(business._id)}/missing.png`), // no Media record
    ]) {
      const res = await saveDraft(business._id, owner, draftBody({ hero: { imageUrl: url } }));
      assert.equal(res.body.code, "invalid_media_reference", url);
    }
  } finally {
    if (saved.aws !== undefined) process.env.AWS_S3_PUBLIC_URL = saved.aws;
    if (saved.s3 !== undefined) process.env.S3_PUBLIC_URL = saved.s3;
    if (saved.local !== undefined) process.env.LOCAL_MEDIA_ENABLED = saved.local;
    else delete process.env.LOCAL_MEDIA_ENABLED;
  }
});

test("drafts stay private until published; publishing requires a verified owner/manager and no suspension", async () => {
  const { owner, business, host } = await setup();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  assert.equal((await saveDraft(business._id, owner, draftBody())).status, 200);

  const publicFrame = async () => {
    const result = await getPublicStorefront(host);
    assert.ok(result, "store is public");
    return loadStorefrontFrame(result!, null);
  };

  // Draft is not public, and never rides along in the public view's theme.
  let frame = await publicFrame();
  assert.notEqual(frame.commerce.hero?.headline, "Fresh tea, every week");
  assert.equal(frame.commerce.announcement, null);
  assert.equal(JSON.stringify(frame.view).includes("Fresh tea"), false);

  assert.equal((await publishSettings(business._id, staff)).status, 403);
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await publishSettings(business._id, owner)).body.code, "email_unverified");
  await User.updateOne({ _id: owner._id }, { $set: { emailVerifiedAt: new Date() } });

  await Business.updateOne({ _id: business._id }, { $set: { status: "suspended" } });
  assert.equal((await publishSettings(business._id, owner)).body.code, "suspended");
  await Business.updateOne({ _id: business._id }, { $set: { status: "published" } });

  const published = await publishSettings(business._id, owner);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  frame = await publicFrame();
  assert.equal(frame.commerce.hero?.headline, "Fresh tea, every week");
  assert.deepEqual(frame.commerce.hero?.primaryCta, { label: "Shop tea", href: "/products?category=Tea" });
  assert.equal(frame.commerce.announcement?.text, "Free delivery this week");
  assert.equal((await getSettings(business._id, owner)).body.hasUnpublishedChanges, false);

  // A newer draft does not change the public store until it is published again.
  await saveDraft(business._id, owner, draftBody({ hero: { headline: "Next week's draft" } }));
  frame = await publicFrame();
  assert.equal(frame.commerce.hero?.headline, "Fresh tea, every week");

  // Publishing the store itself also snapshots the storefront draft.
  const store = await call(publishStoreRoute.POST, "POST", `/api/businesses/${business._id}/publish`, { id: String(business._id) }, owner, { publish: true });
  assert.equal(store.status, 200, JSON.stringify(store.body));
  frame = await publicFrame();
  assert.equal(frame.commerce.hero?.headline, "Next week's draft");
});

test("best sellers come only from this store's paid orders", async () => {
  const { business } = await setup();
  const other = await setup();
  const a = await Product.create({ business: business._id, name: "A", slug: "a", price: 10, stock: 5, status: "active" });
  const b = await Product.create({ business: business._id, name: "B", slug: "b", price: 10, stock: 5, status: "active" });
  const order = (biz: unknown, product: unknown, quantity: number, status: string) =>
    Order.create({
      business: biz,
      ownerToken: `t-${Math.random()}`,
      customerName: "Shopper",
      customerEmail: "shopper@example.com",
      items: [{ product: String(product), productName: "x", quantity, unitPrice: 10, currency: "INR" }],
      subtotal: 10 * quantity,
      total: 10 * quantity,
      status,
      paidAt: status === "paid" ? new Date() : null,
    });
  await order(business._id, a._id, 2, "paid");
  await order(business._id, b._id, 5, "paid");
  await order(business._id, a._id, 50, "pending"); // unpaid: never counts
  await order(business._id, a._id, 50, "cancelled");
  await order(other.business._id, other.product._id, 99, "paid"); // other tenant

  assert.deepEqual(await loadBestSellerIds(business._id), [String(b._id), String(a._id)]);
  assert.deepEqual(await loadBestSellerIds(other.business._id), [String(other.product._id)]);
});

test("product sale price: the original price must be higher than the price", async () => {
  const { owner, business, product } = await setup();
  const patch = (body: unknown) =>
    call(productRoute.PATCH, "PATCH", `/api/businesses/${business._id}/products/${product._id}`, { id: String(business._id), productId: String(product._id) }, owner, body);

  assert.equal((await patch({ compareAtPrice: 80 })).status, 422);
  assert.equal((await patch({ compareAtPrice: 100 })).status, 422);
  const ok = await patch({ compareAtPrice: 150 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // Raising the price above the stored original price is rejected too.
  const raised = await patch({ price: 200 });
  assert.equal(raised.status, 422);
  assert.equal(raised.body.code, "invalid_compare_at_price");
  assert.equal((await patch({ price: 200, compareAtPrice: null })).status, 200);
  const stored = await Product.findById(product._id).lean();
  assert.equal(stored!.price, 200);
  assert.equal(stored!.compareAtPrice, null);
});
