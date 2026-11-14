import mongoose from "mongoose";
import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { editingActionsSchema, type EditingAction } from "./actions";
import { loadWebsiteEditingContext } from "./context";
import { EditingEngineError } from "./editing-engine";
import { websitePlanSchema, type WebsitePlan } from "./plan";
import { prepareEditingProposal } from "./proposal";
import { applyApprovedEditingProposal } from "./apply-approved-proposal";
import { redactText } from "@/lib/ai-builder/sanitize";
import { applyApprovedStorefrontProposal, storefrontProposalIsStale } from "@/lib/ai-builder/storefront-proposals";
import { applyApprovedWebsiteProposal } from "@/lib/ai-website/apply";
import { websiteStaleItems } from "@/lib/ai-website/proposal";
import type { WebsiteProposalData } from "@/lib/ai-website/blueprint";
import { Page } from "@/models/Page";
import {
  PROPOSAL_TTL_MS,
  WebsiteProposal,
  type ProposalStatus,
  type WebsiteProposalDoc,
} from "@/models/WebsiteProposal";

/**
 * Website change proposals (AI builder M1), server-only.
 *
 * Every function expects the caller to have authorized an owner or manager of
 * `businessId` (routes use `requireBusinessRole`); `loadWebsiteEditingContext`
 * and `applyApprovedEditingProposal` re-check membership themselves. Proposals
 * are always loaded by (id, business), so another tenant's id is "not found".
 *
 * There is no generic write: a proposal can only change DRAFT pages through
 * the validated editing actions, (target "storefront") the draft store
 * homepage and brand through lib/ai-builder/storefront-proposals.ts, or (target
 * "website") a whole website's drafts through lib/ai-website/apply.ts, and only
 * after an explicit approval and an explicit apply. Nothing here publishes.
 */

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), { message: "HTML markup is not supported." });

export const createProposalSchema = z
  .object({
    summary: summarySchema,
    actions: editingActionsSchema,
  })
  .strict();

export const proposalFromPlanSchema = z
  .object({
    summary: summarySchema.optional(),
    plan: z.unknown(),
  })
  .strict();

export const reviewProposalSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(280).optional(),
  })
  .strict();

/** Failure codes from applying that are recorded on the proposal (others are rethrown only). */
const RECORDED_APPLY_FAILURES = new Set([
  "version_conflict",
  "page_slug_conflict",
  "page_not_found",
  "page_not_replaceable",
  "section_not_found",
  "validation_error",
  "invalid_media_reference",
  "invalid_featured_product",
  "conflict",
  "draft_conflict",
  "page_not_supported",
]);

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function notFound(): HttpError {
  return new HttpError(404, "Proposal not found", "not_found");
}

function isExpired(doc: Pick<WebsiteProposalDoc, "status" | "expiresAt">, now = new Date()): boolean {
  return (doc.status === "pending" || doc.status === "approved") && doc.expiresAt.getTime() <= now.getTime();
}

/** Record expiry once (conditional), so an expired proposal can never be applied. */
async function expireIfNeeded(doc: WebsiteProposalDoc): Promise<WebsiteProposalDoc> {
  if (!isExpired(doc)) return doc;
  const updated = await WebsiteProposal.findOneAndUpdate(
    { _id: doc._id, business: doc.business, status: { $in: ["pending", "approved"] } },
    {
      $set: { status: "failed", failureCode: "expired" },
      $push: { history: { at: new Date(), action: "expired", actor: null, note: "expired" } },
    },
    { new: true },
  ).lean<WebsiteProposalDoc>();
  return updated ?? doc;
}

/**
 * Converts a validated planner plan into create-page actions. A plan only adds
 * new draft pages: one naming an existing page to replace is refused. A planned
 * page without sections gets one hero section built from its own title and
 * purpose (no new content is invented).
 */
export function planToEditingActions(planInput: unknown): { plan: WebsitePlan; actions: EditingAction[] } {
  const plan = websitePlanSchema.parse(planInput);
  if (plan.pages.some((page) => page.existingPageId)) {
    throw new HttpError(422, "A plan adds new draft pages and cannot replace existing ones. Remove those pages from the plan, or change them in the website editor.", "plan_replacement_not_supported");
  }
  const actions = plan.pages.map((page, index) => ({
    actionId: `page-${index + 1}`,
    kind: "create-page" as const,
    title: page.title,
    slug: page.slug,
    sections:
      page.sections.length > 0
        ? page.sections
        : [{ id: "hero", type: "hero" as const, order: 0, visible: true, settings: { headline: page.title.slice(0, 160), subheadline: page.purpose.slice(0, 240) } }],
  }));
  return { plan, actions: editingActionsSchema.parse(actions) };
}

export async function createProposal(input: {
  businessId: string;
  actorId: string;
  source: "manual" | "planner" | "ai";
  summary: string;
  actions: unknown;
  /** The owner's own words (AI proposals), shown in the review. */
  request?: string;
  /** Media of this business that a new page copied from an existing page may keep. */
  approvedMedia?: string[];
  /** Of the pages created, which came from AI. Absent on an AI proposal: all of them. */
  aiPageSlugs?: string[];
}) {
  const actions = editingActionsSchema.parse(input.actions);
  const targetIds = [...new Set(actions.filter((a) => a.kind !== "create-page").map((a) => (a as { pageId: string }).pageId))];
  if (targetIds.some((id) => !OBJECT_ID.test(id))) {
    throw new HttpError(422, "Actions may only target existing pages of this business.", "unsupported_page_reference");
  }
  await dbConnect();

  // Business-scoped, draft-only context (re-checks owner/manager membership).
  const context = await loadWebsiteEditingContext(input.businessId, targetIds);
  if (context.editingContext.pages.length !== targetIds.length) {
    throw new HttpError(409, "Only draft pages can be changed by a proposal.", "page_not_draft");
  }
  if (input.approvedMedia?.length) {
    context.editingContext.allowedMediaUrls = [...new Set([...context.editingContext.allowedMediaUrls, ...input.approvedMedia])];
  }

  const business = new mongoose.Types.ObjectId(input.businessId);
  const newSlugs = actions.filter((a) => a.kind === "create-page").map((a) => (a as { slug: string }).slug);
  if (newSlugs.length > 0 && (await Page.exists({ business, slug: { $in: newSlugs } }))) {
    throw new HttpError(409, "A proposed page slug is already used by this business.", "page_slug_conflict");
  }

  const _id = new mongoose.Types.ObjectId();
  let prepared;
  try {
    prepared = prepareEditingProposal(context.editingContext, { proposalId: String(_id), summary: input.summary, actions });
  } catch (error) {
    if (error instanceof EditingEngineError) {
      throw new HttpError(error.code === "version_conflict" ? 409 : 422, error.message, error.code);
    }
    throw error;
  }

  const now = new Date();
  const doc = await WebsiteProposal.create({
    _id,
    business,
    createdBy: new mongoose.Types.ObjectId(input.actorId),
    source: input.source,
    ...(input.request ? { request: redactText(input.request, 500) } : {}),
    ...(input.aiPageSlugs ? { aiPageSlugs: input.aiPageSlugs } : {}),
    summary: redactText(prepared.summary, 280),
    actions: prepared.actions,
    pageVersions: prepared.pageVersions,
    diff: prepared.diff,
    preview: prepared.preview,
    status: "pending",
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    history: [{ at: now, action: "created", actor: new mongoose.Types.ObjectId(input.actorId), note: input.source }],
  });
  return toView(doc.toObject() as WebsiteProposalDoc, [], input.actorId);
}

/** Pages whose current state no longer matches what the proposal was prepared against. */
async function stalePages(doc: Pick<WebsiteProposalDoc, "business" | "pageVersions">): Promise<string[]> {
  if (doc.pageVersions.length === 0) return [];
  const pages = await Page.find({ business: doc.business, _id: { $in: doc.pageVersions.map((p) => p.pageId) } })
    .select("_id version status")
    .lean();
  const byId = new Map(pages.map((p) => [String(p._id), p]));
  return doc.pageVersions
    .filter(({ pageId, expectedVersion }) => {
      const page = byId.get(pageId);
      return !page || page.status !== "draft" || page.version !== expectedVersion;
    })
    .map((p) => p.pageId);
}

/**
 * What someone typed to get a proposal is for that person only: every owner and manager can see the proposal
 * itself, so its `request` goes to nobody else. A whole-website proposal comes from a private conversation, so
 * its request goes to nobody at all, including anything an older proposal stored. Scrubbed here too, for those.
 */
function requestFor(doc: Pick<WebsiteProposalDoc, "target" | "request" | "createdBy">, viewerId: string | undefined): string {
  if (doc.target === "website" || !viewerId || String(doc.createdBy) !== viewerId) return "";
  return redactText(doc.request ?? "", 500);
}

function toView(doc: WebsiteProposalDoc, stale: string[], viewerId?: string) {
  return {
    id: String(doc._id),
    source: doc.source,
    target: doc.target ?? "pages",
    request: requestFor(doc, viewerId),
    notes: (doc.target === "website" ? ((doc.website as WebsiteProposalData | undefined)?.notes ?? []) : (doc.storefront?.notes ?? [])).map((note) => redactText(note, 200)),
    summary: redactText(doc.summary, 280),
    status: doc.status as ProposalStatus,
    failureCode: doc.failureCode ?? null,
    stale: stale.length > 0,
    stalePageIds: doc.target === "website" ? [] : stale,
    /** Whole-website proposals: what changed since, in the owner's words. */
    staleItems: doc.target === "website" ? stale : [],
    actionsCount: Array.isArray(doc.actions) ? doc.actions.length : 0,
    diff: doc.diff,
    preview: doc.preview,
    pageVersions: doc.pageVersions,
    appliedPages: doc.appliedPages ?? [],
    createdAt: doc.createdAt,
    reviewedAt: doc.reviewedAt ?? null,
    appliedAt: doc.appliedAt ?? null,
    expiresAt: doc.expiresAt,
    history: (doc.history ?? []).map((h) => ({ at: h.at, action: h.action, actor: h.actor ? String(h.actor) : null, note: h.note ?? null })),
  };
}

export type ProposalView = ReturnType<typeof toView>;

/** View of a freshly created proposal, for the person who just created it (nothing can be stale yet). */
export function proposalView(doc: WebsiteProposalDoc): ProposalView {
  return toView(doc, [], String(doc.createdBy));
}

export async function listProposals(businessId: string, filter: { target?: "pages" | "storefront" } = {}, viewerId?: string) {
  await dbConnect();
  const query: Record<string, unknown> = { business: new mongoose.Types.ObjectId(businessId) };
  // Proposals created before targets existed have no field: they are page proposals.
  if (filter.target === "storefront") query.target = "storefront";
  if (filter.target === "pages") query.target = { $nin: ["storefront", "website"] };
  const docs = await WebsiteProposal.find(query)
    .sort({ createdAt: -1 })
    .limit(50)
    .select("source target request createdBy summary status failureCode actions pageVersions createdAt reviewedAt appliedAt expiresAt business")
    .lean<WebsiteProposalDoc[]>();
  const out = [];
  for (const raw of docs) {
    const doc = await expireIfNeeded(raw);
    out.push({
      id: String(doc._id),
      source: doc.source,
      target: doc.target ?? "pages",
      request: requestFor(doc, viewerId),
      summary: redactText(doc.summary, 280),
      status: doc.status,
      failureCode: doc.failureCode ?? null,
      actionsCount: Array.isArray(doc.actions) ? doc.actions.length : 0,
      pagesTouched: doc.pageVersions.length,
      createdAt: doc.createdAt,
      reviewedAt: doc.reviewedAt ?? null,
      appliedAt: doc.appliedAt ?? null,
      expiresAt: doc.expiresAt,
    });
  }
  return out;
}

async function loadScoped(businessId: string, proposalId: string): Promise<WebsiteProposalDoc> {
  if (!OBJECT_ID.test(proposalId)) throw notFound();
  await dbConnect();
  const doc = await WebsiteProposal.findOne({
    _id: new mongoose.Types.ObjectId(proposalId),
    business: new mongoose.Types.ObjectId(businessId),
  }).lean<WebsiteProposalDoc>();
  if (!doc) throw notFound();
  return expireIfNeeded(doc);
}

/** What makes a proposal stale: page versions, or the draft homepage/brand hash. */
async function staleTargets(doc: WebsiteProposalDoc): Promise<string[]> {
  if (doc.target === "storefront") return (await storefrontProposalIsStale(doc)) ? ["storefront"] : [];
  if (doc.target === "website") return websiteStaleItems(doc);
  return stalePages(doc);
}

export async function getProposal(businessId: string, proposalId: string, viewerId?: string): Promise<ProposalView> {
  const doc = await loadScoped(businessId, proposalId);
  // A whole website that failed on a version conflict can still be refreshed, so the owner is told what changed.
  const refreshable = doc.target === "website" && doc.status === "failed" && doc.failureCode === "version_conflict";
  const stale = doc.status === "pending" || doc.status === "approved" || refreshable ? await staleTargets(doc) : [];
  return toView(doc, stale, viewerId);
}

async function markFailed(doc: Pick<WebsiteProposalDoc, "_id" | "business">, from: ProposalStatus[], code: string, actorId: string | null) {
  await WebsiteProposal.updateOne(
    { _id: doc._id, business: doc.business, status: { $in: from } },
    {
      $set: { status: "failed", failureCode: code },
      $push: { history: { at: new Date(), action: "apply_failed", actor: actorId ? new mongoose.Types.ObjectId(actorId) : null, note: code } },
    },
  );
}

export async function reviewProposal(input: { businessId: string; proposalId: string; actorId: string; decision: "approve" | "reject"; note?: string }) {
  const doc = await loadScoped(input.businessId, input.proposalId);
  if (doc.status !== "pending") {
    throw new HttpError(409, `This proposal is ${doc.status}; only pending proposals can be reviewed.`, "proposal_not_pending");
  }
  if (input.decision === "approve") {
    const stale = await staleTargets(doc);
    if (stale.length > 0) {
      await markFailed(doc, ["pending"], "version_conflict", input.actorId);
      throw new HttpError(
        409,
        doc.target === "storefront"
          ? "Your homepage changed after this suggestion was prepared. Ask again for a fresh suggestion."
          : doc.target === "website"
            ? "Your website changed after this proposal was prepared. Ask again for a fresh one."
          : "A page changed after this proposal was prepared. Create a new proposal.",
        "version_conflict",
      );
    }
  }
  const status = input.decision === "approve" ? "approved" : "rejected";
  const actor = new mongoose.Types.ObjectId(input.actorId);
  const updated = await WebsiteProposal.findOneAndUpdate(
    { _id: doc._id, business: doc.business, status: "pending", expiresAt: { $gt: new Date() } },
    {
      $set: { status, reviewedBy: actor, reviewedAt: new Date() },
      $push: { history: { at: new Date(), action: status, actor, note: input.note ?? null } },
    },
    { new: true },
  ).lean<WebsiteProposalDoc>();
  if (!updated) throw new HttpError(409, "This proposal was changed by someone else. Reload it.", "proposal_not_pending");
  return toView(updated, [], input.actorId);
}

/**
 * Claims an approved proposal and applies it to drafts in ONE transaction: if
 * applying fails, the claim rolls back too, and the failure is then recorded.
 * Concurrent applies serialise on the proposal document; only one succeeds.
 */
export async function applyProposal(input: { businessId: string; proposalId: string; actorId: string }) {
  const doc = await loadScoped(input.businessId, input.proposalId);
  if (doc.status !== "approved") {
    throw new HttpError(409, `This proposal is ${doc.status}; only approved proposals can be applied.`, "proposal_not_approved");
  }
  const actor = new mongoose.Types.ObjectId(input.actorId);
  const session = await mongoose.startSession();
  let applied: WebsiteProposalDoc | null = null;
  try {
    await session.withTransaction(async () => {
      applied = null;
      const now = new Date();
      const claimed = await WebsiteProposal.findOneAndUpdate(
        { _id: doc._id, business: doc.business, status: "approved", expiresAt: { $gt: now } },
        { $set: { status: "applied", appliedAt: now }, $push: { history: { at: now, action: "applied", actor, note: null } } },
        { new: true, session },
      ).lean<WebsiteProposalDoc>();
      if (!claimed) throw new HttpError(409, "This proposal is no longer approved.", "proposal_not_approved");

      if (claimed.target === "storefront") {
        // Draft homepage (+ brand) through the editor's own write path.
        await applyApprovedStorefrontProposal(input.businessId, claimed, { session, actorUserId: input.actorId });
        applied = claimed;
        return;
      }

      if (claimed.target === "website") {
        // All of it or none of it, in this transaction: the claim above rolls back with any failure.
        const result = await applyApprovedWebsiteProposal(input.businessId, claimed, { session, actorUserId: input.actorId });
        await WebsiteProposal.updateOne({ _id: claimed._id }, { $set: { appliedPages: result.pages } }, { session });
        applied = { ...claimed, appliedPages: result.pages };
        return;
      }

      const result = await applyApprovedEditingProposal(
        input.businessId,
        {
          proposalId: String(claimed._id),
          summary: claimed.summary,
          actions: claimed.actions,
          pageVersions: claimed.pageVersions.map((p) => ({ pageId: p.pageId, expectedVersion: p.expectedVersion })),
          diff: claimed.diff,
          preview: claimed.preview,
          status: "approved",
          review: { decision: "approved", reviewerId: String(claimed.reviewedBy), reviewedAt: new Date(claimed.reviewedAt as Date).toISOString() },
        },
        { session, actorUserId: input.actorId, ...(claimed.source === "ai" ? { generatedBy: "ai" as const, aiPageSlugs: claimed.aiPageSlugs } : {}) },
      );
      await WebsiteProposal.updateOne({ _id: claimed._id }, { $set: { appliedPages: result.pages } }, { session });
      applied = { ...claimed, appliedPages: result.pages };
    });
  } catch (error) {
    if (error instanceof HttpError && RECORDED_APPLY_FAILURES.has(error.code)) {
      await markFailed(doc, ["approved"], error.code, input.actorId);
    }
    if (error instanceof z.ZodError) {
      await markFailed(doc, ["approved"], "validation_error", input.actorId);
      throw new HttpError(422, "This proposal no longer passes validation.", "validation_error");
    }
    throw error;
  } finally {
    await session.endSession();
  }
  if (!applied) throw new HttpError(500, "Proposal was not applied", "internal_error");
  return toView(applied, [], input.actorId);
}
