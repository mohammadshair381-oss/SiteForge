import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { dbConnect } from "@/lib/db";
import { assertObjectId } from "@/lib/ids";
import { assertSectionMediaOwned } from "@/lib/media-references";
import { assertCanAddPages } from "@/lib/usage-limits";
import { editingProposalSchema, type EditingProposal } from "./proposal";
import { editingActionsSchema } from "./actions";
import { Page } from "@/models/Page";
import { sectionsArraySchema, type Section } from "@/lib/sections";

const applyInputSchema = z.union([
  z.object({ proposal: editingProposalSchema }).strict(),
  editingProposalSchema,
]);

export interface ApplyApprovedProposalResult {
  applied: true;
  pages: Array<{
    id: string;
    title: string;
    slug: string;
    created: boolean;
  }>;
  message: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) {
    return true;
  }
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

/**
 * The person applying a proposal must still be an active owner or manager of
 * the business (checked again at apply time, for every proposal target).
 */
export async function assertProposalActor(businessId: string, actorUserId?: string): Promise<void> {
  if (actorUserId) {
    const { User } = await import("@/models/User");
    const { Membership } = await import("@/models/Membership");
    const user = await User.findById(actorUserId);
    if (!user || !user.active) {
      throw new HttpError(401, "Authentication required", "unauthenticated");
    }
    const authorizedBusinessId = assertObjectId(businessId, "business id");
    const membership = await Membership.findOne({ business: authorizedBusinessId, user: user._id });
    if (!membership || membership.status !== "active" || !["owner", "manager"].includes(membership.role)) {
      throw new HttpError(403, "Insufficient permissions for this action", "forbidden");
    }
  } else {
    await requireBusinessRole(businessId, ["owner", "manager"]);
  }
}

/**
 * Applies a trusted, server-validated approved editing proposal.
 *
 * No route accepts a client-submitted proposal or approval state: `applyProposal`
 * (./proposal-service.ts) loads the stored proposal, claims it and calls this.
 * Callers MUST load the proposal from trusted server state, verify approval
 * themselves, re-authorize and re-check everything before calling this function.
 * This function never trusts client-supplied approval status/reviewer identity.
 */
export async function applyApprovedEditingProposal(
  businessId: string,
  proposalInput: unknown,
  options: {
    session?: ClientSession;
    actorUserId?: string;
    /** Pages created by an AI proposal are marked as AI-generated. */
    generatedBy?: "ai";
    /** Which of them, when a plan also holds pages the owner wrote. Absent: all. */
    aiPageSlugs?: string[];
  } = {},
): Promise<ApplyApprovedProposalResult> {
  const parsed = applyInputSchema.parse(proposalInput);
  const proposal = (parsed as any).proposal ?? parsed;

  // Must be explicitly approved - never trust client state
  if (proposal.status !== "approved") {
    throw new HttpError(409, "Only approved proposals can be applied.", "proposal_not_approved");
  }
  if (!proposal.review || proposal.review.decision !== "approved") {
    throw new HttpError(409, "Only approved proposals can be applied.", "proposal_not_approved");
  }

  await dbConnect();

  // Authorization: require owner/manager
  await assertProposalActor(businessId, options.actorUserId);

  const authorizedBusinessId = assertObjectId(businessId, "business id");

  // Re-validate actions against schema (defense in depth)
  const actions = editingActionsSchema.parse(proposal.actions);

  // Collect affected pages and expected versions
  const expectedVersions = new Map<string, number>();
  for (const action of actions) {
    if (action.kind !== "create-page") {
      expectedVersions.set(action.pageId, action.expectedVersion);
    }
  }

  // Build page version bindings from proposal
  const boundVersions = new Map<string, number>();
  for (const pv of proposal.pageVersions) {
    boundVersions.set(pv.pageId, pv.expectedVersion);
  }
  // Ensure they match
  if (boundVersions.size !== expectedVersions.size) {
    throw new HttpError(409, "Proposal page version bindings do not match actions.", "version_conflict");
  }
  for (const [pageId, expectedVersion] of expectedVersions) {
    if (boundVersions.get(pageId) !== expectedVersion) {
      throw new HttpError(409, "Proposal page version bindings do not match actions.", "version_conflict");
    }
  }

  const session = options.session ?? (await mongoose.startSession());
  const shouldEndSession = !options.session;
  let appliedPages: ApplyApprovedProposalResult["pages"] = [];

  try {
    if (options.session) {
      appliedPages = await applyInTransaction({
        businessId: authorizedBusinessId as any,
        actions,
        expectedVersions,
        session,
        generatedBy: options.generatedBy,
        aiPageSlugs: options.aiPageSlugs,
      });
    } else {
      try {
        await session.withTransaction(async () => {
          appliedPages = await applyInTransaction({
            businessId: authorizedBusinessId as any,
            actions,
            expectedVersions,
            session,
            generatedBy: options.generatedBy,
            aiPageSlugs: options.aiPageSlugs,
          });
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (isTransactionalConflict(error)) {
          throw new HttpError(409, "The change conflicted with another update. Please retry.", "conflict");
        }
        if (isDuplicateKeyError(error)) {
          throw new HttpError(409, "A page slug was claimed during application. No changes were applied.", "page_slug_conflict");
        }
        throw error;
      }
    }
  } finally {
    if (shouldEndSession) {
      await session.endSession();
    }
  }

  return {
    applied: true,
    pages: appliedPages,
    message: "Approved proposal applied to draft pages only. No pages were published and no unrelated business data was modified.",
  };
}

async function applyInTransaction({
  businessId,
  actions,
  expectedVersions,
  session,
  generatedBy,
  aiPageSlugs,
}: {
  generatedBy?: "ai";
  aiPageSlugs?: string[];
  businessId: mongoose.Types.ObjectId;
  actions: ReturnType<typeof editingActionsSchema.parse>;
  expectedVersions: Map<string, number>;
  session: ClientSession;
}): Promise<ApplyApprovedProposalResult["pages"]> {
  const { Business } = await import("@/models/Business");
  const businessDoc = await Business.findById(businessId).session(session);
  if (!businessDoc) {
    throw new HttpError(404, "Business not found.", "not_found");
  }

  // Load all affected pages (existing ones) with full data
  const existingPageIds = [...expectedVersions.keys()];
  const pagesById = new Map<string, any>();
  if (existingPageIds.length > 0) {
    const pages = await Page.find({ business: businessId, _id: { $in: existingPageIds } })
      .session(session);
    for (const page of pages) {
      pagesById.set(String(page._id), page);
    }
  }

  // Verify all expected pages exist and belong to business
  for (const [pageId, expectedVersion] of expectedVersions) {
    const page = pagesById.get(pageId);
    if (!page) {
      throw new HttpError(404, "A target page does not exist or does not belong to this business.", "page_not_found");
    }
    if (page.status === "published") {
      throw new HttpError(409, "Published pages cannot be modified by proposal application.", "page_not_replaceable");
    }
    if (page.version !== expectedVersion) {
      throw new HttpError(409, "A target page version is stale. Reload and retry.", "version_conflict");
    }
  }

  // Validate all sections in actions
  const allSections: Section[] = [];
  for (const action of actions) {
    if (action.kind === "create-page") {
      allSections.push(...action.sections);
    } else if (action.kind === "update-section") {
      allSections.push(action.section);
    } else if (action.kind === "add-section") {
      allSections.push(action.section);
    }
    // remove/reorder don't add new sections
  }
  if (allSections.length > 0) {
    // Revalidate against the section schema PER ACTION: section ids only have
    // to be unique within one page, so two new pages may both have a "hero".
    for (const action of actions) {
      const sections =
        action.kind === "create-page"
          ? action.sections
          : action.kind === "update-section" || action.kind === "add-section"
            ? [action.section]
            : [];
      if (sections.length > 0 && !sectionsArraySchema.safeParse(sections).success) {
        throw new HttpError(422, "Invalid sections in proposal.", "validation_error");
      }
    }
    // Media ownership check
    await assertSectionMediaOwned(String(businessId), allSections);
  }

  // Check for slug conflicts across all pages that will be affected/created
  const allPagesForSlugCheck = await Page.find({ business: businessId }).select("_id slug").session(session).lean();
  const slugToPageId = new Map<string, string>();
  for (const p of allPagesForSlugCheck) {
    slugToPageId.set(p.slug, String(p._id));
  }

  // Simulate to detect conflicts (create-page will add new slugs)
  for (const action of actions) {
    if (action.kind === "create-page") {
      const existingOwner = slugToPageId.get(action.slug);
      if (existingOwner) {
        throw new HttpError(409, `The slug "${action.slug}" is already in use by this business.`, "page_slug_conflict");
      }
      // Will be created with temp id, but we need to check - just ensure no conflict now
    }
  }

  const applied: ApplyApprovedProposalResult["pages"] = [];

  // The first page of a store without pages (AI, manual or planner proposal)
  // keeps the live homepage as its Home page.
  const createdSlugs = actions.flatMap((action) => (action.kind === "create-page" ? [action.slug] : []));
  if (createdSlugs.length > 0) {
    await assertCanAddPages(String(businessId), createdSlugs.length, session);
    const { ensureHomeMirror } = await import("@/lib/page-generation");
    await ensureHomeMirror(String(businessId), session, createdSlugs);
  }

  // Apply actions in order - but we need to track state as we go
  // For each create-page action, we need to create it
  for (const action of actions) {
    if (action.kind === "create-page") {
      // Ensure slug still free (recheck)
      const existing = await Page.findOne({ business: businessId, slug: action.slug }).session(session);
      if (existing) {
        throw new HttpError(409, `The slug "${action.slug}" is already in use by this business.`, "page_slug_conflict");
      }
      const [created] = await Page.create(
        [
          {
            business: businessId,
            title: action.title,
            slug: action.slug,
            sections: action.sections,
            status: "draft", // Must remain draft only
            isHome: false,
            version: 0,
            // AI-written pages are identified, and (like template pages) cannot
            // be published while [[placeholders]] remain.
            ...(generatedBy === "ai" && (!aiPageSlugs || aiPageSlugs.includes(action.slug)) ? { generated: { key: `ai:${action.slug}`, source: "ai", preset: "ai", needsReview: false, createdAt: new Date() } } : {}),
          },
        ],
        { session },
      );
      applied.push({
        id: String(created._id),
        title: created.title,
        slug: created.slug,
        created: true,
      });
      continue;
    }

    // For existing pages, re-fetch with version check in update
    const page = pagesById.get(action.pageId);
    if (!page) {
      throw new HttpError(404, "Page not found.", "page_not_found");
    }
    if (page.status === "published") {
      throw new HttpError(409, "Published pages cannot be modified.", "page_not_replaceable");
    }

    if (action.kind === "update-section") {
      // Find section and update only its settings (respecting constraints from engine)
      const sectionIndex = page.sections.findIndex((s: any) => s.id === action.section.id);
      if (sectionIndex < 0) {
        throw new HttpError(404, "Section not found.", "section_not_found");
      }
      const currentSection = page.sections[sectionIndex];
      // Ensure we don't change protected fields
      if (
        currentSection.type !== action.section.type ||
        currentSection.order !== action.section.order ||
        currentSection.visible !== action.section.visible ||
        JSON.stringify(currentSection.style ?? null) !== JSON.stringify(action.section.style ?? null)
      ) {
        throw new HttpError(422, "Only section settings can be updated.", "validation_error");
      }
      page.sections[sectionIndex] = {
        ...currentSection,
        settings: action.section.settings,
      };
    } else if (action.kind === "add-section") {
      if (page.sections.length >= 50) {
        throw new HttpError(422, "Page cannot contain more than 50 sections.", "validation_error");
      }
      if (page.sections.some((s: any) => s.id === action.section.id)) {
        throw new HttpError(409, "Section id already exists.", "conflict");
      }
      const sections = [...page.sections].sort((a: any, b: any) => a.order - b.order);
      if (action.index > sections.length) {
        throw new HttpError(422, "Invalid insertion index.", "validation_error");
      }
      sections.splice(action.index, 0, action.section);
      // renumber
      page.sections = sections.map((s: any, idx: number) => ({ ...s, order: idx }));
    } else if (action.kind === "remove-section") {
      const sections = [...page.sections].sort((a: any, b: any) => a.order - b.order);
      const idx = sections.findIndex((s: any) => s.id === action.sectionId);
      if (idx < 0) {
        throw new HttpError(404, "Section not found.", "section_not_found");
      }
      sections.splice(idx, 1);
      page.sections = sections.map((s: any, order: number) => ({ ...s, order }));
    } else if (action.kind === "reorder-sections") {
      const sections = [...page.sections].sort((a: any, b: any) => a.order - b.order);
      const fromIdx = sections.findIndex((s: any) => s.id === action.sectionId);
      if (fromIdx < 0) {
        throw new HttpError(404, "Section not found.", "section_not_found");
      }
      if (action.toIndex >= sections.length || action.toIndex === fromIdx) {
        throw new HttpError(422, "Invalid reorder.", "validation_error");
      }
      const [moved] = sections.splice(fromIdx, 1);
      sections.splice(action.toIndex, 0, moved);
      page.sections = sections.map((s: any, order: number) => ({ ...s, order }));
    }

    // Atomic conditional update with version check. Several actions may target
    // the same page: each one is conditioned on the version THIS transaction
    // last wrote (the first on the proposal's expected version), so a second
    // action on a page no longer fails against its own earlier write.
    const result = await Page.updateOne(
      { _id: page._id, business: businessId, status: "draft", version: page.version },
      { $set: { sections: page.sections }, $inc: { version: 1 } },
      { session },
    );
    if (result.matchedCount === 0) {
      throw new HttpError(409, "Page was modified by another save. Reload and retry.", "version_conflict");
    }
    page.version += 1;

    if (!applied.some((entry) => entry.id === String(page._id))) {
      applied.push({
        id: String(page._id),
        title: page.title,
        slug: page.slug,
        created: false,
      });
    }
  }

  return applied;
}
