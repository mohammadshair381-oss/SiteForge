import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import mongoose from "mongoose";

import { startIntegrationSuite, stopIntegrationSuite, getTestMongoUri } from "./helpers/env";
import { clearAllCollections, connectTestDB, disconnectTestDB } from "./helpers/db";
import { createUser } from "./helpers/fixtures";
import { callHandler, createAuthHeadersForUser } from "./helpers/auth";
import { createBusinessWithOwner, createMembership } from "./helpers/tenant";
import { clearRequestCookies } from "./helpers/mock-next-headers-setup";
import * as listRoute from "@/app/api/businesses/[id]/proposals/route";
import * as planRoute from "@/app/api/businesses/[id]/proposals/from-plan/route";
import * as detailRoute from "@/app/api/businesses/[id]/proposals/[proposalId]/route";
import * as reviewRoute from "@/app/api/businesses/[id]/proposals/[proposalId]/review/route";
import * as applyRoute from "@/app/api/businesses/[id]/proposals/[proposalId]/apply/route";
import { applyProposal } from "@/lib/ai-planning/proposal-service";
import { resolveStorefrontPage } from "@/lib/storefront-pages";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { User } from "@/models/User";
import { WebsiteProposal } from "@/models/WebsiteProposal";

/**
 * AI builder M1 without external AI: structured proposals, validation,
 * review, draft-only application, history, staleness and concurrency.
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
  clearRequestCookies();
  await disconnectTestDB();
  await stopIntegrationSuite();
});
beforeEach(async () => {
  clearRequestCookies();
  await clearAllCollections();
});

type Actor = { _id: unknown; tokenVersion: number };

async function req(
  handler: unknown,
  method: "GET" | "POST",
  businessId: unknown,
  path: string,
  actor: Actor | null,
  body?: unknown,
  extra: { proposalId?: string; origin?: string } = {},
) {
  const id = String(businessId);
  const headers = actor ? await createAuthHeadersForUser(String(actor._id), "user", actor.tokenVersion) : {};
  const params = extra.proposalId ? { id, proposalId: extra.proposalId } : { id };
  const res = (await callHandler(
    handler as never,
    new Request(`http://localhost/api/businesses/${id}/proposals${path}`, {
      method,
      headers: { "content-type": "application/json", host: "localhost", ...(extra.origin ? { origin: extra.origin } : {}), ...headers },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve(params) } as never,
  )) as Response;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

type StoredSection = { type: string; settings: { headline?: string } };
/** Typed view of a stored page's sections (the model types them as unknown). */
const sectionsOf = (page: { sections?: unknown } | null | undefined) => (page?.sections ?? []) as StoredSection[];

const hero = (headline: string) => ({ id: "hero", type: "hero", order: 0, visible: true, settings: { headline } });

async function setup() {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  const page = await Page.create({ business: business._id, title: "About", slug: "about", sections: [hero("Old headline")], status: "draft" });
  return { owner, business, page };
}

function editActions(pageId: string, version = 0) {
  return [
    { actionId: "a1", kind: "update-section", pageId, expectedVersion: version, section: hero("New headline") },
    {
      actionId: "a2",
      kind: "add-section",
      pageId,
      expectedVersion: version,
      index: 1,
      section: { id: "about-body", type: "about", order: 1, visible: true, settings: { title: "Our story", body: "Since 2020." } },
    },
  ];
}

async function create(businessId: unknown, actor: Actor, actions: unknown, summary = "Refresh the About page") {
  return req(listRoute.POST, "POST", businessId, "", actor, { summary, actions });
}
const review = (b: unknown, actor: Actor, proposalId: string, decision: "approve" | "reject") =>
  req(reviewRoute.POST, "POST", b, `/${proposalId}/review`, actor, { decision }, { proposalId });
const apply = (b: unknown, actor: Actor, proposalId: string) => req(applyRoute.POST, "POST", b, `/${proposalId}/apply`, actor, {}, { proposalId });

test("only verified owners/managers of this business can create, review or apply proposals", async () => {
  const { owner, business, page } = await setup();
  const staff = await createUser();
  await createMembership(business._id, staff._id, "staff");
  const manager = await createUser();
  await createMembership(business._id, manager._id, "manager");
  const other = await createBusinessWithOwner();
  const actions = editActions(String(page._id));

  assert.equal((await create(business._id, staff, actions)).status, 403);
  assert.equal((await create(business._id, other.owner, actions)).status, 403);
  assert.equal((await req(listRoute.GET, "GET", business._id, "", staff)).status, 403);
  assert.equal((await req(listRoute.POST, "POST", business._id, "", owner, { summary: "x", actions }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await req(listRoute.POST, "POST", business._id, "", null, { summary: "x", actions })).status, 401);
  await User.updateOne({ _id: manager._id }, { $set: { emailVerifiedAt: null } });
  assert.equal((await create(business._id, manager, actions)).body.code, "email_unverified");

  const made = await create(business._id, owner, actions);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.proposal.id;
  // Another tenant cannot read it through its own business.
  assert.equal((await req(detailRoute.GET, "GET", other.business._id, `/${id}`, other.owner, undefined, { proposalId: id })).status, 404);
  assert.equal((await review(other.business._id, other.owner, id, "approve")).status, 404);
  assert.equal(await WebsiteProposal.countDocuments(), 1);
});

test("a proposal is validated and previewed without touching the page; approve then apply writes drafts only", async () => {
  const { owner, business, page } = await setup();
  const made = await create(business._id, owner, editActions(String(page._id)));
  assert.equal(made.status, 201);
  const p = made.body.proposal;
  assert.equal(p.status, "pending");
  assert.equal(p.stale, false);
  const previewPage = p.preview.pages.find((pg: { id: string }) => pg.id === String(page._id));
  assert.equal(previewPage.sections[0].settings.headline, "New headline");
  assert.equal(previewPage.sections.length, 2);
  assert.equal(sectionsOf(await Page.findById(page._id).lean())[0].settings.headline, "Old headline", "preview never saves");

  const listed = await req(listRoute.GET, "GET", business._id, "", owner);
  assert.equal(listed.body.proposals[0].status, "pending");

  assert.equal((await apply(business._id, owner, p.id)).body.code, "proposal_not_approved", "pending cannot be applied");
  assert.equal((await review(business._id, owner, p.id, "approve")).body.proposal.status, "approved");
  assert.equal((await review(business._id, owner, p.id, "reject")).body.code, "proposal_not_pending");

  const applied = await apply(business._id, owner, p.id);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.published, false);
  assert.equal(applied.body.proposal.status, "applied");
  assert.deepEqual(applied.body.proposal.appliedPages.map((x: { id: string }) => x.id), [String(page._id)], "one entry per page");

  const after = await Page.findById(page._id).lean();
  assert.equal(after?.status, "draft", "never published");
  assert.equal(sectionsOf(after)[0].settings.headline, "New headline");
  assert.equal(after?.sections.length, 2, "two actions on one page both applied (regression)");
  assert.equal((await Business.findById(business._id).lean())?.status, "published", "business status untouched");

  const detail = await req(detailRoute.GET, "GET", business._id, `/${p.id}`, owner, undefined, { proposalId: p.id });
  assert.deepEqual(detail.body.proposal.history.map((h: { action: string }) => h.action), ["created", "approved", "applied"]);
  assert.equal((await apply(business._id, owner, p.id)).body.code, "proposal_not_approved", "cannot apply twice");
});

test("invalid, cross-tenant, published-page and stale actions are refused at creation", async () => {
  const { owner, business, page } = await setup();
  const other = await createBusinessWithOwner();
  const foreign = await Page.create({ business: other.business._id, title: "X", slug: "x", sections: [hero("X")], status: "draft" });
  const published = await Page.create({ business: business._id, title: "Live", slug: "live", sections: [hero("Live")], status: "published" });

  const html = editActions(String(page._id));
  (html[0].section.settings as { headline: string }).headline = "<script>alert(1)</script>";
  assert.equal((await create(business._id, owner, html)).status, 422);
  assert.equal((await create(business._id, owner, [{ actionId: "a1", kind: "delete-business" }])).status, 422);
  assert.equal((await create(business._id, owner, editActions("proposal-x"))).body.code, "unsupported_page_reference");
  assert.equal((await create(business._id, owner, editActions(String(foreign._id)))).status, 404, "another business's page");
  assert.equal((await create(business._id, owner, editActions(String(published._id)))).body.code, "page_not_draft");
  const stale = await create(business._id, owner, editActions(String(page._id), 7));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "version_conflict");
  assert.equal((await create(business._id, owner, editActions(String(page._id)), "<b>bold</b>")).status, 422);
  assert.equal(await WebsiteProposal.countDocuments(), 0);
});

test("a page edited after preparation makes the proposal fail visibly, at approval or at apply", async () => {
  const { owner, business, page } = await setup();
  const first = (await create(business._id, owner, editActions(String(page._id)))).body.proposal;
  await Page.updateOne({ _id: page._id }, { $inc: { version: 1 } });
  const detail = await req(detailRoute.GET, "GET", business._id, `/${first.id}`, owner, undefined, { proposalId: first.id });
  assert.equal(detail.body.proposal.stale, true);
  const approve = await review(business._id, owner, first.id, "approve");
  assert.equal(approve.status, 409);
  assert.equal((await WebsiteProposal.findById(first.id).lean())?.status, "failed");

  const second = (await create(business._id, owner, editActions(String(page._id), 1))).body.proposal;
  assert.equal((await review(business._id, owner, second.id, "approve")).status, 200);
  await Page.updateOne({ _id: page._id }, { $inc: { version: 1 } });
  const res = await apply(business._id, owner, second.id);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "version_conflict");
  const failed = await WebsiteProposal.findById(second.id).lean();
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.failureCode, "version_conflict");
  assert.equal(sectionsOf(await Page.findById(page._id).lean())[0].settings.headline, "Old headline", "nothing partially applied");
});

test("concurrent applies of one approved proposal apply it exactly once", async () => {
  const { owner, business, page } = await setup();
  const p = (await create(business._id, owner, editActions(String(page._id)))).body.proposal;
  await review(business._id, owner, p.id, "approve");
  const results = await Promise.allSettled(
    [1, 2, 3].map(() => applyProposal({ businessId: String(business._id), proposalId: p.id, actorId: String(owner._id) })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const after = await Page.findById(page._id).lean();
  assert.equal(after?.sections.length, 2, "the added section exists once");
  assert.equal(after?.version, 2, "one version bump per applied action");
  assert.equal((await WebsiteProposal.findById(p.id).lean())?.status, "applied");
});

test("rejecting and expiry: rejected and expired proposals can never be applied", async () => {
  const { owner, business, page } = await setup();
  const a = (await create(business._id, owner, editActions(String(page._id)))).body.proposal;
  assert.equal((await review(business._id, owner, a.id, "reject")).body.proposal.status, "rejected");
  assert.equal((await apply(business._id, owner, a.id)).status, 409);

  const b = (await create(business._id, owner, editActions(String(page._id)))).body.proposal;
  await review(business._id, owner, b.id, "approve");
  await WebsiteProposal.collection.updateOne({ _id: new mongoose.Types.ObjectId(b.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await apply(business._id, owner, b.id)).status, 409);
  const expired = await WebsiteProposal.findById(b.id).lean();
  assert.equal(expired?.status, "failed");
  assert.equal(expired?.failureCode, "expired");
  assert.equal((await Page.findById(page._id).lean())?.version, 0, "page untouched");
});

test("the manual planner's plan becomes a proposal of new draft pages; replacements and taken slugs are refused", async () => {
  const { owner, business } = await setup();
  const plan = (pages: Array<Record<string, unknown>>) => ({
    businessSummary: "Tea shop.",
    targetAudience: "Tea lovers.",
    recommendedTheme: "studio",
    requestedPageCount: pages.length,
    designPreferences: { notes: "" },
    specialRequirements: "",
    productIds: [],
    pages,
    navigation: pages.map((p) => ({ pageSlug: p.slug, label: p.title })),
    assumptions: [],
    unansweredQuestions: [],
    summary: "Plan.",
  });
  const page = (slug: string, isHome = false, extra: Record<string, unknown> = {}) => ({
    title: slug.toUpperCase(), slug, purpose: `The ${slug} page`, proposedContent: "", isHome, sections: [], ...extra,
  });

  const made = await req(planRoute.POST, "POST", business._id, "/from-plan", owner, { plan: plan([page("home2", true), page("menu")]) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.proposal.source, "planner");
  assert.equal(made.body.proposal.actionsCount, 2);
  assert.equal(await Page.countDocuments({ business: business._id }), 1, "nothing created yet");

  await review(business._id, owner, made.body.proposal.id, "approve");
  const appliedPlan = await apply(business._id, owner, made.body.proposal.id);
  assert.equal(appliedPlan.status, 200, JSON.stringify(appliedPlan.body));
  const created = await Page.find({ business: business._id, slug: { $in: ["home2", "menu"] } }).lean();
  assert.equal(created.length, 2);
  assert.ok(created.every((p) => p.status === "draft" && p.isHome === false && sectionsOf(p)[0].type === "hero"));

  const taken = await req(planRoute.POST, "POST", business._id, "/from-plan", owner, { plan: plan([page("about", true)]) });
  assert.equal(taken.body.code, "page_slug_conflict");
  const replacing = await req(planRoute.POST, "POST", business._id, "/from-plan", owner, {
    plan: plan([page("about", true, { existingPageId: String(new mongoose.Types.ObjectId()), expectedVersion: 0 })]),
  });
  assert.equal(replacing.body.code, "plan_replacement_not_supported");
});

test("a manual proposal creating a store's first page keeps the homepage, even when it uses the slug home", async () => {
  const { owner, business } = await createBusinessWithOwner({ status: "published" });
  assert.equal((await resolveStorefrontPage(business._id, null)).kind, "legacy-business");
  const made = await create(business._id, owner, [{ actionId: "a1", kind: "create-page", title: "Home", slug: "home", sections: [hero("Draft only")] }], "Add a first page");
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await review(business._id, owner, made.body.proposal.id, "approve");
  const applied = await apply(business._id, owner, made.body.proposal.id);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  const home = await resolveStorefrontPage(business._id, null);
  assert.ok(home.kind === "page" && home.sections.length === 0, "`/` is still the commerce homepage");
  const pages = await Page.find({ business: business._id }).lean();
  assert.equal(pages.length, 2);
  const draft = pages.find((p) => p.slug === "home");
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.isHome, false);
  const mirror = pages.find((p) => p.isHome);
  assert.equal(mirror?.slug, "home-2");
  assert.equal(mirror?.status, "published");
});
