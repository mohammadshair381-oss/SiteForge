import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import type { Types } from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createBusinessWithOwner, createPlan, createSubscription } from "./helpers/tenant";
import {
  CLOSED_ROBOTS,
  getProductMetadata,
  getRobotsForHost,
  getSitemapForHost,
  getStorefrontPageMetadata,
} from "@/lib/seo";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";

/**
 * Host-aware robots/sitemap and canonical metadata against the real public
 * storefront gate. ROOT_DOMAINS is "localhost:3000" in the harness and
 * NODE_ENV is not production, so canonical origins are http://<sub>.localhost:3000.
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

const hero = { id: "hero-1", type: "hero", order: 0, visible: true, settings: { headline: "Hi" } };

async function store(options: { status?: "draft" | "published" | "suspended"; entitled?: boolean } = {}) {
  const { business } = await createBusinessWithOwner({ status: options.status ?? "published" });
  const plan = await createPlan({ price: 0 });
  await createSubscription(business._id, plan._id, {
    status: options.entitled === false ? "past_due" : "active",
    currentPeriodEnd: null,
  });
  const host = `${business.subdomain}.localhost:3000`;
  return { business, host, origin: `http://${host}` };
}

async function product(businessId: Types.ObjectId, slug: string, status: "draft" | "active" | "archived") {
  return Product.create({
    business: businessId,
    name: slug,
    slug,
    price: 5,
    currency: "USD",
    status,
    stock: 3,
    sku: `SKU-${crypto.randomUUID().slice(0, 6)}`,
  });
}

async function page(
  businessId: Types.ObjectId,
  slug: string,
  options: { isHome?: boolean; status?: "draft" | "published"; publishedSections?: unknown[]; sections?: unknown[] } = {},
) {
  return Page.create({
    business: businessId,
    title: slug,
    slug,
    isHome: options.isHome ?? false,
    status: options.status ?? "published",
    sections: options.sections ?? [hero],
    publishedSections: options.publishedSections ?? [hero],
  });
}

const urls = (entries: Array<{ url: string }>) => entries.map((entry) => entry.url).sort();

test("an eligible store lists only published pages with content and active products", async () => {
  const { business, host, origin } = await store();
  await page(business._id, "home", { isHome: true, publishedSections: [] });
  await page(business._id, "about");
  await page(business._id, "secret-draft", { status: "draft" });
  await page(business._id, "empty", { publishedSections: [], sections: [] });
  await product(business._id, "mug", "active");
  await product(business._id, "draft-mug", "draft");
  await product(business._id, "old-mug", "archived");

  assert.deepEqual(urls(await getSitemapForHost(host)), [
    `${origin}/`,
    `${origin}/about`,
    `${origin}/product/mug`,
    `${origin}/products`,
  ]);

  const robots = await getRobotsForHost(host);
  assert.equal(robots.sitemap, `${origin}/sitemap.xml`);
  assert.deepEqual(robots.rules, { userAgent: "*", allow: "/", disallow: ["/cart", "/order/", "/account", "/api/"] });
});

test("host isolation: each host lists only its own tenant's URLs", async () => {
  const a = await store();
  const b = await store();
  await page(a.business._id, "home", { isHome: true });
  await page(a.business._id, "a-only");
  await product(a.business._id, "a-mug", "active");
  await page(b.business._id, "home", { isHome: true });
  await page(b.business._id, "b-only");
  await product(b.business._id, "b-mug", "active");

  const aUrls = urls(await getSitemapForHost(a.host));
  const bUrls = urls(await getSitemapForHost(b.host));
  assert.ok(aUrls.every((url) => url.startsWith(`${a.origin}/`)));
  assert.ok(bUrls.every((url) => url.startsWith(`${b.origin}/`)));
  assert.equal(aUrls.some((url) => url.includes("b-only") || url.includes("b-mug")), false);
  assert.equal(bUrls.some((url) => url.includes("a-only") || url.includes("a-mug")), false);
});

test("unknown, unpublished, suspended and unentitled storefronts are closed and empty", async () => {
  const cases = [
    { host: "nobody.localhost:3000" },
    { host: "", },
    { host: (await store({ status: "draft" })).host },
    { host: (await store({ status: "suspended" })).host },
    { host: (await store({ entitled: false })).host },
  ];
  for (const { host } of cases) {
    assert.deepEqual(await getRobotsForHost(host), CLOSED_ROBOTS, `robots for "${host}"`);
    assert.deepEqual(await getSitemapForHost(host), [], `sitemap for "${host}"`);
  }
});

test("a page published empty and then draft-edited is not advertised; a true legacy page is", async () => {
  const { business, host, origin } = await store();
  await page(business._id, "home", { isHome: true });
  // Published with an empty snapshot, later edited as a draft.
  await page(business._id, "draft-edits", { publishedSections: [], sections: [hero] });
  // Written before snapshots existed: the field is entirely absent.
  const legacy = await page(business._id, "legacy");
  await Page.collection.updateOne({ _id: legacy._id }, { $unset: { publishedSections: "" } });

  assert.deepEqual(urls(await getSitemapForHost(host)), [`${origin}/`, `${origin}/legacy`]);
});

test("a verified custom-domain host gets an open robots policy pointing at the subdomain sitemap, and no sitemap of its own", async () => {
  const { business, origin } = await store();
  const plan = await createPlan({ price: 0, customDomain: true });
  await Subscription.updateMany({ business: business._id }, { $set: { plan: plan._id } });
  const domain = `shop-${crypto.randomUUID().slice(0, 8)}.example-store.com`;
  await Business.updateOne({ _id: business._id }, { $set: { customDomain: domain } });
  const { DomainVerification } = await import("@/models/DomainVerification");
  await DomainVerification.create({
    business: business._id,
    domain,
    tokenHash: "a".repeat(64),
    status: "verified",
    verifiedAt: new Date(),
    ownershipCheckedAt: new Date(),
    expiresAt: null,
  });
  await page(business._id, "home", { isHome: true });

  const robots = await getRobotsForHost(domain);
  assert.equal(robots.sitemap, `${origin}/sitemap.xml`, "canonical sitemap stays on the subdomain");
  assert.deepEqual(await getSitemapForHost(domain), [], "no cross-host URLs from the custom domain");
  assert.deepEqual((await getStorefrontPageMetadata(domain, null)).alternates, { canonical: `${origin}/` });
});

test("an expired paid subscription closes robots and empties the sitemap", async () => {
  const { business, host } = await store();
  await page(business._id, "home", { isHome: true });
  const paid = await createPlan({ price: 1900 });
  await Subscription.updateMany(
    { business: business._id },
    { $set: { plan: paid._id, currentPeriodEnd: new Date(Date.now() - 60_000) } },
  );
  assert.deepEqual(await getRobotsForHost(host), CLOSED_ROBOTS);
  assert.deepEqual(await getSitemapForHost(host), []);
});

test("legacy storefront without Page documents lists the homepage and products", async () => {
  const { business, host, origin } = await store();
  await product(business._id, "legacy-mug", "active");
  assert.deepEqual(urls(await getSitemapForHost(host)), [`${origin}/`, `${origin}/product/legacy-mug`, `${origin}/products`]);

  const meta = await getStorefrontPageMetadata(host, null);
  assert.deepEqual(meta.alternates, { canonical: `${origin}/` });
});

test("platform host gets the platform policy; storefront rules never apply to it", async () => {
  const robots = await getRobotsForHost("localhost:3000");
  assert.equal(robots.sitemap, "http://localhost:3000/sitemap.xml");
  const rules = robots.rules as { disallow: string[] };
  for (const path of ["/dashboard", "/admin", "/api/"]) assert.ok(rules.disallow.includes(path));
  assert.deepEqual(urls(await getSitemapForHost("localhost:3000")), [
    "http://localhost:3000/",
    "http://localhost:3000/pricing",
    "http://localhost:3000/privacy",
    "http://localhost:3000/register",
    "http://localhost:3000/terms",
    "http://localhost:3000/themes",
  ]);
});

test("canonical metadata uses the tenant subdomain for pages and products", async () => {
  const { business, host, origin } = await store();
  await page(business._id, "home", { isHome: true });
  await page(business._id, "about");
  await page(business._id, "draft-page", { status: "draft" });
  await product(business._id, "mug", "active");
  await product(business._id, "hidden-mug", "archived");

  assert.deepEqual((await getStorefrontPageMetadata(host, null)).alternates, { canonical: `${origin}/` });
  const about = await getStorefrontPageMetadata(host, "about");
  assert.deepEqual(about.alternates, { canonical: `${origin}/about` });
  assert.equal((about.openGraph as { url?: string }).url, `${origin}/about`);

  // Draft or missing pages get no canonical (they 404).
  assert.equal("alternates" in (await getStorefrontPageMetadata(host, "draft-page")), false);
  assert.equal("alternates" in (await getStorefrontPageMetadata(host, "missing")), false);

  const productMeta = await getProductMetadata(host, "mug");
  assert.deepEqual(productMeta.alternates, { canonical: `${origin}/product/mug` });
  assert.deepEqual(await getProductMetadata(host, "hidden-mug"), {});

  // Ineligible stores expose no metadata at all.
  await Business.updateOne({ _id: business._id }, { $set: { status: "suspended" } });
  assert.deepEqual(await getStorefrontPageMetadata(host, "about"), {});
  assert.deepEqual(await getProductMetadata(host, "mug"), {});
});
