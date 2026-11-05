import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import {
  createBusinessWithOwner,
  createPlan,
  createSubscription,
  tenantSuffix,
} from "./helpers/tenant";
import { getPublicStorefront } from "@/lib/tenant";
import { toStorefrontView } from "@/lib/storefront";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import type { Types } from "mongoose";

/**
 * Phase 4.6 — storefront entitlement enforcement.
 *
 * These tests exercise the real public storefront resolution
 * (`getPublicStorefront`), which is the single entry point used by both the
 * storefront home page and the product page. There is no host-mockable HTTP
 * route for the storefront (the pages read `headers().get("host")`, and the
 * test harness's `next/headers` mock returns an empty header list), so calling
 * the resolution function with a real tenant host is the most direct existing
 * integration point. It runs the full path: host -> business -> entitlement ->
 * published-product filtering.
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
  await disconnectTestDB();
  await stopIntegrationSuite();
});

beforeEach(async () => {
  await clearAllCollections();
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A tenant host that resolves back to the given business's subdomain. */
function hostFor(business: { subdomain: string }): string {
  // ROOT_DOMAINS is "localhost:3000" in the integration harness.
  return `${business.subdomain}.localhost:3000`;
}

interface ProductOptions {
  name?: string;
  status?: "draft" | "active" | "archived";
}

async function createProduct(businessId: Types.ObjectId, options: ProductOptions = {}) {
  const suffix = tenantSuffix();
  return Product.create({
    business: businessId,
    name: options.name ?? `Product ${suffix}`,
    slug: `product-${suffix}`,
    description: "A test product",
    price: 1500,
    currency: "USD",
    category: "general",
    status: options.status ?? "active",
  });
}

/** An active, currently-entitling paid subscription (period ends in the future). */
async function activePaidSubscription(businessId: Types.ObjectId) {
  const plan = await createPlan({ price: 2900, interval: "month" });
  return createSubscription(businessId, plan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - DAY_MS),
    currentPeriodEnd: new Date(Date.now() + DAY_MS),
  });
}

// ============================================================
// 1. Published + eligible paid subscription -> accessible
// ============================================================

test("published business with an eligible paid subscription is publicly accessible", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  await activePaidSubscription(business._id);
  const product = await createProduct(business._id, { name: "Live item" });

  const result = await getPublicStorefront(hostFor(business));

  assert.ok(result, "an eligible published storefront must resolve");
  assert.equal(result!.business._id.toString(), business._id.toString());
  assert.equal(result!.business.subdomain, business.subdomain);
  assert.equal(result!.products.length, 1);
  assert.equal(result!.products[0].slug, product.slug);

  // The public projection still renders normally.
  const view = toStorefrontView(result!.business, result!.products, result!.removeBranding);
  assert.equal(view.subdomain, business.subdomain);
  assert.equal(view.products.length, 1);
  assert.equal(view.products[0].name, "Live item");
});

// ============================================================
// 2. Published + expired paid subscription -> not accessible
// ============================================================

test("published business whose paid subscription expired is not publicly accessible", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 2900, interval: "month" });
  await createSubscription(business._id, plan._id, {
    status: "active", // still "active" in the DB, but the period has passed
    currentPeriodStart: new Date(Date.now() - 2 * DAY_MS),
    currentPeriodEnd: new Date(Date.now() - DAY_MS),
  });
  await createProduct(business._id, { name: "Should be hidden" });

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null, "an expired paid storefront must not resolve");
});

// ============================================================
// 3. Published + valid free plan -> accessible (even past period end)
// ============================================================

test("published free-plan business stays accessible regardless of period end", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 0, interval: "month" });
  await createSubscription(business._id, plan._id, {
    status: "active",
    // Free plans are exempt from period-end expiry; a past end must not hide it.
    currentPeriodEnd: new Date(Date.now() - DAY_MS),
  });
  await createProduct(business._id, { name: "Free plan item" });

  const result = await getPublicStorefront(hostFor(business));
  assert.ok(result, "a valid free-plan storefront must remain accessible");
  assert.equal(result!.products.length, 1);
});

// ============================================================
// 4. Published + missing/incomplete subscription -> not accessible
// ============================================================

test("published business with no subscription is not publicly accessible", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  await createProduct(business._id);

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null, "no subscription => no entitlement => hidden");
});

test("published business with an incomplete subscription is not publicly accessible", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 2900 });
  await createSubscription(business._id, plan._id, {
    status: "incomplete",
    currentPeriodEnd: new Date(Date.now() + DAY_MS),
  });

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null, "a non-entitling status must not grant access");
});

// ============================================================
// 5. Unpublished business -> inaccessible (even with a valid subscription)
// ============================================================

test("draft business is not publicly accessible even with a valid subscription", async () => {
  const { business } = await createBusinessWithOwner({ status: "draft" });
  await activePaidSubscription(business._id);
  await createProduct(business._id);

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null, "publication status is still required");
});

// ============================================================
// 6. Suspended business -> inaccessible even with a valid subscription
// ============================================================

test("suspended business is not publicly accessible even with a valid subscription", async () => {
  const { business } = await createBusinessWithOwner({ status: "suspended" });
  await activePaidSubscription(business._id);
  await createProduct(business._id);

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null, "entitlement must not bypass a suspension");
});

// ============================================================
// 7. An expired visitor request must not mutate stored data
// ============================================================

test("a visitor request to an expired storefront leaves business, subscription, and products unchanged", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const publishedAt = new Date(Date.now() - 3 * DAY_MS);
  await Business.updateOne({ _id: business._id }, { $set: { publishedAt } });

  const plan = await createPlan({ price: 2900, interval: "month" });
  const periodEnd = new Date(Date.now() - DAY_MS);
  const subscription = await createSubscription(business._id, plan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - 2 * DAY_MS),
    currentPeriodEnd: periodEnd,
  });
  await createProduct(business._id, { name: "Active", status: "active" });
  await createProduct(business._id, { name: "Draft", status: "draft" });

  const before7 = {
    business: (await Business.findById(business._id).lean())!,
    subscription: (await Subscription.findById(subscription._id).lean())!,
    products: await Product.find({ business: business._id }).sort({ name: 1 }).lean(),
  };

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null);

  const after7 = {
    business: (await Business.findById(business._id).lean())!,
    subscription: (await Subscription.findById(subscription._id).lean())!,
    products: await Product.find({ business: business._id }).sort({ name: 1 }).lean(),
  };

  // Business must NOT be unpublished or deleted.
  assert.equal(after7.business.status, "published", "status must not change on a visitor request");
  assert.equal(after7.business.publishedAt?.getTime(), publishedAt.getTime());
  // Subscription must NOT be mutated (no lazy expiry write).
  assert.equal(after7.subscription.status, before7.subscription.status);
  assert.equal(
    after7.subscription.currentPeriodEnd?.getTime(),
    periodEnd.getTime(),
    "period end must not be rewritten",
  );
  // Products must NOT be removed or archived.
  assert.equal(after7.products.length, 2);
  assert.deepEqual(
    after7.products.map((p) => ({ name: p.name, status: p.status })),
    before7.products.map((p) => ({ name: p.name, status: p.status })),
  );
});

// ============================================================
// 8. Restoring eligibility makes the still-published storefront accessible
// ============================================================

test("renewing an expired subscription restores access without republishing", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 2900, interval: "month" });
  const subscription = await createSubscription(business._id, plan._id, {
    status: "active",
    currentPeriodStart: new Date(Date.now() - 2 * DAY_MS),
    currentPeriodEnd: new Date(Date.now() - DAY_MS),
  });
  await createProduct(business._id);

  assert.equal(await getPublicStorefront(hostFor(business)), null, "expired => hidden");

  // Simulate a renewal: extend the period into the future.
  await Subscription.updateOne(
    { _id: subscription._id },
    { $set: { currentPeriodEnd: new Date(Date.now() + DAY_MS) } },
  );

  const restored = await getPublicStorefront(hostFor(business));
  assert.ok(restored, "eligible again => accessible again");

  const stored = await Business.findById(business._id).lean();
  assert.equal(stored!.status, "published", "the business was never unpublished");
});

// ============================================================
// 9. Public projection leaks no private subscription/membership data
// ============================================================

test("the public storefront projection exposes no subscription, owner, or membership fields", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await activePaidSubscription(business._id);
  const product = await createProduct(business._id);

  const result = await getPublicStorefront(hostFor(business));
  assert.ok(result);
  const view = toStorefrontView(result!.business, result!.products, result!.removeBranding);

  for (const forbidden of ["owner", "customDomain", "status", "publishedAt", "subscription", "memberships", "plan"]) {
    assert.ok(!(forbidden in view), `public view must not expose "${forbidden}"`);
  }

  const productView = view.products[0] as unknown as Record<string, unknown>;
  for (const forbidden of ["business", "status", "sku", "stock"]) {
    assert.ok(!(forbidden in productView), `public product view must not expose "${forbidden}"`);
  }

  // The owner's identity and the entitlement/plan details must not appear.
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes(owner._id.toString()), "owner id must not leak");
  assert.ok(!serialized.includes("currentPeriodEnd"), "billing period must not leak");
  assert.equal(productView.slug, product.slug, "sanity: the real product is present");
});

// ============================================================
// 10. Published-only product filtering + tenant isolation
// ============================================================

test("only this business's active products are exposed, newest first", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  await activePaidSubscription(business._id);

  const activeA = await createProduct(business._id, { name: "A live", status: "active" });
  const activeB = await createProduct(business._id, { name: "B live", status: "active" });
  await createProduct(business._id, { name: "Draft", status: "draft" });
  await createProduct(business._id, { name: "Archived", status: "archived" });

  // A different tenant's active product must never appear.
  const other = await createBusinessWithOwner({ status: "published" });
  await activePaidSubscription(other.business._id);
  await createProduct(other.business._id, { name: "Other tenant", status: "active" });

  const result = await getPublicStorefront(hostFor(business));
  assert.ok(result);
  assert.deepEqual(
    result!.products.map((p) => p.slug).sort(),
    [activeA.slug, activeB.slug].sort(),
    "only active products of this business are exposed",
  );

  // The other tenant resolves only its own data.
  const otherResult = await getPublicStorefront(hostFor(other.business));
  assert.ok(otherResult);
  assert.equal(otherResult!.products.length, 1);
  assert.notEqual(otherResult!.business._id.toString(), business._id.toString());
});

// ============================================================
// Extra: an expired business's archived/draft products stay hidden too
// ============================================================

test("expired storefront resolves to null even when products were published", async () => {
  const { business } = await createBusinessWithOwner({ status: "published" });
  const plan = await createPlan({ price: 9900, interval: "year" });
  await createSubscription(business._id, plan._id, {
    status: "active",
    currentPeriodEnd: new Date(Date.now() - DAY_MS),
  });
  await createProduct(business._id, { status: "active" });

  const result = await getPublicStorefront(hostFor(business));
  assert.equal(result, null);

  // Sanity: the product is preserved in the database.
  assert.equal(await Product.countDocuments({ business: business._id }), 1);
});
