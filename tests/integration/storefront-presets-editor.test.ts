import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership, grantActiveFreePlan } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import { POST as businessesPOST } from "@/app/api/businesses/route";
import * as storefrontRoute from "@/app/api/businesses/[id]/storefront/route";
import * as storefrontPublishRoute from "@/app/api/businesses/[id]/storefront/publish/route";
import * as pageRoute from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { getPublicStorefront } from "@/lib/tenant";
import { loadStorefrontFrame } from "@/lib/storefront-commerce";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { Product } from "@/models/Product";

/**
 * Business-type homepage presets, section management through the storefront
 * API (validation, permissions, tenant isolation), and retiring a classic
 * custom homepage in favour of the store homepage.
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

test("a new business starts with the homepage preset of its business type", async () => {
  const user = await createUser();
  const create = async (name: string, category: string) => {
    const res = (await callHandler(
      businessesPOST,
      new Request("http://localhost/api/businesses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion)) },
        body: JSON.stringify({ name, category }),
      }),
    )) as Response;
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).business;
  };
  const shop = await create("Sole Mates", "shoes");
  const grocer = await create("Corner Grocer", "grocery");
  const general = await create("Gift Box", "retail");
  const stored = async (id: string) => ((await Business.findById(id).lean())!.themeSettings as unknown as Record<string, any>).storefront;
  const shoes = await stored(shop._id);
  assert.equal(shoes.preset, "shoes");
  assert.deepEqual(shoes.sections.slice(0, 2).map((s: any) => s.title), ["Shop by style", "Featured shoes"]);
  assert.equal((await stored(grocer._id)).sections.find((s: any) => s.type === "featured").title, "Daily essentials");
  assert.equal((await stored(general._id)).preset, "general");
  // The business-type list includes the store types (validated by the API).
  const invalid = (await callHandler(
    businessesPOST,
    new Request("http://localhost/api/businesses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await createAuthHeadersForUser(String(user._id), "user", user.tokenVersion)) },
      body: JSON.stringify({ name: "Nope", category: "spaceships" }),
    }),
  )) as Response;
  assert.equal(invalid.status, 422);
});

test("homepage sections: add, duplicate, reorder, disable; validated; owners/managers of this business only", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  const id = String(business._id);
  const other = await createBusinessWithOwner({ status: "published" });
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const tea = await Product.create({ business: business._id, name: "Tea", slug: "tea", price: 5, stock: 3, status: "active", category: "Tea" });
  const mug = await Product.create({ business: business._id, name: "Mug", slug: "mug", price: 9, stock: 3, status: "active", category: "Kitchen" });

  const current = (await api(storefrontRoute.GET, "GET", `/api/businesses/${id}/storefront`, { id }, owner)).body.draft;
  const sections = [
    { id: "story", type: "story", text: "Small-batch tea since 2019." },
    { id: "featured", type: "featured", title: "Teas", productIds: [String(tea._id)] },
    { id: "featured-2", type: "featured", title: "Mugs", productIds: [String(mug._id)], appearance: { background: "alt", spacing: "compact", align: "center" } },
    { id: "best-sellers", type: "bestSellers", enabled: false },
  ];
  const save = (actor: Actor, body: unknown, bizId = id) => api(storefrontRoute.PUT, "PUT", `/api/businesses/${bizId}/storefront`, { id: bizId }, actor, body);

  assert.equal((await save(staff, { ...current, sections })).status, 403, "staff cannot edit the homepage");
  assert.equal((await save(other.owner, { ...current, sections })).status, 403, "another business cannot edit it");
  assert.equal((await save(owner, { ...current, sections: [...sections, { id: "story-2", type: "story" }] })).status, 422, "single-instance types");
  assert.equal((await save(owner, { ...current, sections: [{ id: "x", type: "featured", productIds: [String(other.business._id).padStart(24, "0")] }] })).body.code, "invalid_featured_product");

  const saved = await save(owner, { ...current, sections });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.draft.sections.map((s: any) => s.id), ["story", "featured", "featured-2", "best-sellers"]);

  // Draft only: the public store keeps the published homepage until publish.
  const host = `${business.subdomain}.localhost:3000`;
  const frame = async () => loadStorefrontFrame((await getPublicStorefront(host))!, null);
  assert.notDeepEqual((await frame()).commerce.sections.map((s) => s.id), ["story", "featured", "featured-2"]);
  assert.equal((await api(storefrontPublishRoute.POST, "POST", `/api/businesses/${id}/storefront/publish`, { id }, owner, {})).status, 200);
  const live = (await frame()).commerce;
  assert.deepEqual(live.sections.map((s) => [s.id, s.title]), [["story", "About " + business.name], ["featured", "Teas"], ["featured-2", "Mugs"]]);
  const mugs = live.sections[2];
  assert.equal(mugs.appearance.background, "alt");
  // The other business is untouched.
  assert.equal(((await Business.findById(other.business._id).lean())!.themeSettings as unknown as Record<string, unknown>).storefront, undefined);
});

test("a classic custom homepage keeps rendering until the store homepage is published over it", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  await grantActiveFreePlan(business._id);
  const id = String(business._id);
  const classic = [{ id: "hero", type: "hero", order: 0, visible: true, settings: { headline: "Old classic homepage" } }];
  const home = await Page.create({ business: business._id, title: "Home", slug: "home", isHome: true, status: "published", sections: classic, publishedSections: classic });

  let resolution = await resolveStorefrontPage(business._id, null);
  assert.equal(resolution.kind, "page");
  assert.equal(resolution.kind === "page" && resolution.sections.length, 1, "legacy custom homepage compatibility");

  // The editor's publish: storefront settings, then retire the classic sections.
  assert.equal((await api(storefrontPublishRoute.POST, "POST", `/api/businesses/${id}/storefront/publish`, { id }, owner, {})).status, 200);
  const cleared = await api(pageRoute.PATCH, "PATCH", `/api/businesses/${id}/pages/${home._id}`, { id, pageId: String(home._id) }, owner, {
    sections: [],
    status: "published",
    expectedVersion: home.version ?? 0,
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  resolution = await resolveStorefrontPage(business._id, null);
  assert.ok(resolution.kind === "page" && resolution.sections.length === 0, "the store now renders the commerce homepage");
});
