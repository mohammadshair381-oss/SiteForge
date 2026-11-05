import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { mock } from "node:test";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { connectTestDB, clearAllCollections, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { createAuthHeadersForUser, callHandler } from "./helpers/auth";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import { User } from "@/models/User";
import { s3Storage } from "@/lib/s3";
import { PATCH as businessPATCH } from "@/app/api/businesses/[id]/route";
import { POST as pagesPOST } from "@/app/api/businesses/[id]/pages/route";
import { PATCH as pagesPATCH, DELETE as pagesDELETE } from "@/app/api/businesses/[id]/pages/[pageId]/route";
import { POST as productsPOST } from "@/app/api/businesses/[id]/products/route";
import { PATCH as productPATCH } from "@/app/api/businesses/[id]/products/[productId]/route";
import { POST as mediaPOST } from "@/app/api/businesses/[id]/media/route";
import { POST as membersPOST } from "@/app/api/businesses/[id]/members/route";
import { POST as subscriptionPOST } from "@/app/api/businesses/[id]/subscription/route";
import { POST as publishPOST } from "@/app/api/businesses/[id]/publish/route";

const BASE = "http://localhost";

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
  process.env.AWS_S3_PUBLIC_URL = "https://cdn.test";
  mock.restoreAll();
  mock.method(s3Storage, "upload", async () => undefined);
  mock.method(s3Storage, "remove", async () => undefined);
  mock.method(s3Storage, "publicUrl", (key: string) => `https://cdn.test/${key}`);
});

async function setupBusinessWithRoles() {
  const owner = await createUser({ email: "owner@example.com", name: "Owner" });
  const business = await Business.create({
    name: "Business",
    slug: "business",
    subdomain: "business",
    category: "retail",
    owner: owner._id,
    description: "desc",
  });
  await Membership.create({ business: business._id, user: owner._id, role: "owner", status: "active" });

  const manager = await createUser({ email: "manager@example.com", name: "Manager" });
  await Membership.create({ business: business._id, user: manager._id, role: "manager", status: "active" });

  const staff = await createUser({ email: "staff@example.com", name: "Staff" });
  await Membership.create({ business: business._id, user: staff._id, role: "staff", status: "active" });

  const plan = await Plan.create({
    key: "free",
    name: "Free",
    price: 0,
    features: { productLimit: 10, staffLimit: 5, customDomain: false, removeBranding: false },
    active: true,
  });
  await Subscription.create({ business: business._id, plan: plan._id, status: "active", provider: "manual" });

  const ownerHeaders = await createAuthHeadersForUser(String(owner._id), "user", owner.tokenVersion);
  const managerHeaders = await createAuthHeadersForUser(String(manager._id), "user", manager.tokenVersion);
  const staffHeaders = await createAuthHeadersForUser(String(staff._id), "user", staff.tokenVersion);

  return { owner, manager, staff, business, ownerHeaders, managerHeaders, staffHeaders };
}

function ctx(id: string, pageId?: string, productId?: string) {
  return { params: Promise.resolve({ id, pageId: pageId ?? "", productId: productId ?? "" }) };
}

function req(method: string, path: string, body: unknown, headers: { cookie: string }) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("manager: can update business settings", async () => {
  const { business, managerHeaders } = await setupBusinessWithRoles();
  const res = await callHandler(
    businessPATCH,
    req("PATCH", `/api/businesses/${business._id}`, { name: "Renamed" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 200);
});

test("manager: cannot manage members", async () => {
  const { business, managerHeaders, staff } = await setupBusinessWithRoles();
  const res = await callHandler(
    membersPOST,
    req("POST", `/api/businesses/${business._id}/members`, { email: staff.email, role: "staff" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 403);
});

test("manager: cannot change subscription", async () => {
  const { business, managerHeaders } = await setupBusinessWithRoles();
  const res = await callHandler(
    subscriptionPOST,
    req("POST", `/api/businesses/${business._id}/subscription`, { planKey: "free" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 403);
});

test("manager: can create, update, publish, and delete a page", async () => {
  const { business, managerHeaders } = await setupBusinessWithRoles();
  const create = await callHandler(
    pagesPOST,
    req("POST", `/api/businesses/${business._id}/pages`, { title: "Home", slug: "home", isHome: true }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(create.status, 201);
  const page = (await create.json()).page;

  const update = await callHandler(
    pagesPATCH,
    req("PATCH", `/api/businesses/${business._id}/pages/${page._id}`, { title: "Updated", expectedVersion: page.version }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id), pageId: String(page._id) }) },
  );
  assert.equal(update.status, 200);

  const publish = await callHandler(
    pagesPATCH,
    req("PATCH", `/api/businesses/${business._id}/pages/${page._id}`, { status: "published", expectedVersion: (await update.json()).page.version }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id), pageId: String(page._id) }) },
  );
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).page.status, "published");

  const second = await callHandler(
    pagesPOST,
    req("POST", `/api/businesses/${business._id}/pages`, { title: "Temp", slug: "temp" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(second.status, 201);
  const tempPage = (await second.json()).page;

  const del: Response = await callHandler(
    pagesDELETE,
    new Request(`http://localhost/api/businesses/${business._id}/pages/${tempPage._id}`, { method: "DELETE", headers: { ...managerHeaders } }),
    { params: Promise.resolve({ id: String(business._id), pageId: String(tempPage._id) }) },
  );
  assert.equal(del.status, 200);
});

test("manager: can create, update, and archive a product", async () => {
  const { business, managerHeaders } = await setupBusinessWithRoles();
  const create = await callHandler(
    productsPOST,
    req("POST", `/api/businesses/${business._id}/products`, { name: "Product", price: 10, status: "active" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(create.status, 201);
  const product = (await create.json()).product;

  const update = await callHandler(
    productPATCH,
    req("PATCH", `/api/businesses/${business._id}/products/${product._id}`, { name: "Renamed", status: "draft" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id), productId: String(product._id) }) },
  );
  assert.equal(update.status, 200);

  const archive = await callHandler(
    productPATCH,
    req("PATCH", `/api/businesses/${business._id}/products/${product._id}`, { status: "archived" }, managerHeaders),
    { params: Promise.resolve({ id: String(business._id), productId: String(product._id) }) },
  );
  assert.equal(archive.status, 200);
});

test("manager: can upload media", async () => {
  const { business, managerHeaders } = await setupBusinessWithRoles();
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "photo.png", { type: "image/png" }));
  const res = await callHandler(
    mediaPOST,
    new Request(`http://localhost/api/businesses/${business._id}/media`, { method: "POST", headers: { ...managerHeaders }, body: form }),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 201);
});

test("staff: cannot update business settings", async () => {
  const { business, staffHeaders } = await setupBusinessWithRoles();
  const res = await callHandler(
    businessPATCH,
    req("PATCH", `/api/businesses/${business._id}`, { name: "Nope" }, staffHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 403);
});

test("staff: cannot create pages", async () => {
  const { business, staffHeaders } = await setupBusinessWithRoles();
  const res = await callHandler(
    pagesPOST,
    req("POST", `/api/businesses/${business._id}/pages`, { title: "Staff Page" }, staffHeaders),
    { params: Promise.resolve({ id: String(business._id) }) },
  );
  assert.equal(res.status, 403);
});

test("staff: cannot archive products", async () => {
  const { business, staffHeaders } = await setupBusinessWithRoles();
  const product = await Product.create({ business: business._id, name: "Product", slug: "product", price: 10, status: "active" });
  const res = await callHandler(
    productPATCH,
    req("PATCH", `/api/businesses/${business._id}/products/${product._id}`, { status: "archived" }, staffHeaders),
    { params: Promise.resolve({ id: String(business._id), productId: String(product._id) }) },
  );
  assert.equal(res.status, 403);
  const stored = await Product.findById(product._id).lean();
  assert.equal(stored?.status, "active");
});

test("manager: cannot receive super_admin platform privileges", async () => {
  const { manager } = await setupBusinessWithRoles();
  const user = await User.findById(manager._id).lean();
  assert.equal(user?.platformRole, "user");
});

test("cross-tenant: manager cannot access another business", async () => {
  const { managerHeaders } = await setupBusinessWithRoles();
  const other = await Business.create({ name: "Other", slug: "other", subdomain: "other", category: "retail", owner: (await createUser({ email: "other@example.com" }))._id, description: "desc" });
  const res = await callHandler(
    businessPATCH,
    req("PATCH", `/api/businesses/${other._id}`, { name: "Hacked" }, managerHeaders),
    { params: Promise.resolve({ id: String(other._id) }) },
  );
  assert.equal(res.status, 403);
});