import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, createPlan, createSubscription } from "./helpers/tenant";
import { createUser } from "./helpers/fixtures";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { THEME_IDS } from "@/lib/constants";
import { publishDesignDraft, updateDesignDraft } from "@/lib/design-service";
import { getStorefrontSettings, publishStorefrontSettings, saveStorefrontDraft } from "@/lib/storefront-settings";
import { presetConfig } from "@/lib/storefront-config";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { Business } from "@/models/Business";
import { Order } from "@/models/Order";
import { Product } from "@/models/Product";

/**
 * Theme switching (nine themes) changes only `Business.themeId`: the draft
 * and published homepage, products and stock, orders and every other setting
 * stay exactly as they were, and switching back restores the original store.
 * The navigation/page/product side is covered by navigation-design.test.ts.
 */

before(async () => {
  await startIntegrationSuite();
  const uri = getTestMongoUri();
  if (!uri.startsWith("mongodb://127.0.0.1:") && !uri.startsWith("mongodb://localhost:")) throw new Error(`unexpected URI ${uri}`);
  await connectTestDB();
});
after(async () => {
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  await clearAllCollections();
});

async function patchTheme(businessId: string, actor: { _id: unknown; tokenVersion: number }, body: unknown) {
  const headers = await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion);
  const res = (await callHandler(
    businessPATCH as never,
    new Request(`http://localhost/api/businesses/${businessId}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: businessId }) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

test("switching through all nine themes keeps the homepage drafts, products, stock and orders; switching back restores the store", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  // A plan that includes all nine themes (theme access itself: theme-entitlements.test.ts).
  const plan = await createPlan({ price: 0, themes: [...THEME_IDS] });
  await createSubscription(business._id, plan._id, { status: "active" });
  const id = String(business._id);
  await Business.updateOne({ _id: id }, { $set: { category: "clothing", themeId: "studio" } });

  const published = { ...presetConfig("clothing"), announcement: { enabled: true, text: "Published announcement", href: "/products" } };
  await saveStorefrontDraft(id, published);
  await publishStorefrontSettings(id);
  const draft = { ...published, announcement: { enabled: true, text: "Draft announcement", href: "/products" } };
  await saveStorefrontDraft(id, draft);
  const product = await Product.create({ business: id, name: "Linen Shirt", slug: "linen-shirt", price: 40, compareAtPrice: 50, stock: 7, status: "active", category: "Shirts" });
  await Order.create({
    business: id, ownerToken: "token-1", customerName: "Shopper", customerEmail: "shopper@example.com",
    items: [{ product: String(product._id), productName: "Linen Shirt", quantity: 1, unitPrice: 40, currency: "USD" }],
    subtotal: 40, total: 40, currency: "USD", status: "paid", paidAt: new Date(),
  });

  const before = await getStorefrontSettings(id);
  const businessBefore = await Business.findById(id).lean();
  for (const themeId of [...THEME_IDS, "studio"] as const) {
    // A live store changes theme through the design draft and publishing.
    await updateDesignDraft(id, { themeId });
    await publishDesignDraft(id, { createdBy: owner._id });
    assert.equal((await Business.findById(id).lean())?.themeId, themeId);
    assert.deepEqual(await getStorefrontSettings(id), before, `${themeId}: draft and published homepage unchanged`);
    const stored = await Product.findById(product._id).lean();
    assert.deepEqual([stored?.price, stored?.compareAtPrice, stored?.stock, stored?.status], [40, 50, 7, "active"], `${themeId}: product untouched`);
    assert.equal(await Order.countDocuments({ business: id }), 1);
    // The store still renders from the same data in the new theme.
    const data = await loadStorefrontPreviewData(id);
    assert.equal(data?.business.themeId, themeId);
    assert.deepEqual(data?.products.map((p) => p.slug), ["linen-shirt"]);
  }
  const businessAfter = await Business.findById(id).lean();
  // Every design-draft save moves the draft's version on (lib/draft-version.ts), once per
  // theme switched to above, so it is checked on its own rather than compared.
  assert.equal(businessAfter?.designDraftVersion, (businessBefore?.designDraftVersion ?? 0) + THEME_IDS.length + 1, "one version per design save");
  // Publishing a design also stores the design choices; everything else is identical.
  const withoutDesign = (doc: unknown) => {
    const { updatedAt: _updatedAt, designDraftVersion: _designDraftVersion, themeSettings, ...rest } = doc as Record<string, unknown>;
    const { design: _design, primaryColor: _primary, accentColor: _accent, font: _font, ...settings } = themeSettings as Record<string, unknown>;
    return { ...rest, themeSettings: settings };
  };
  assert.deepEqual(withoutDesign(businessAfter), withoutDesign(businessBefore), "back on the original theme, the business document is identical");
});

test("unknown theme ids are refused and staff cannot switch themes", async () => {
  const { owner, business } = await createBusinessWithOwner();
  const id = String(business._id);
  const bad = await patchTheme(id, owner, { themeId: "nonexistent" });
  assert.ok(bad.status === 400 || bad.status === 422, `status ${bad.status}`);
  assert.equal((await Business.findById(id).lean())?.themeId, "aurora", "the stored theme is unchanged");

  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const denied = await patchTheme(id, staff, { themeId: "forma" });
  assert.equal(denied.status, 403);
  assert.equal((await Business.findById(id).lean())?.themeId, "aurora");
});
