import { z } from "zod";
import {
  editingActionsSchema,
  editingContextSchema,
  MAX_EDITING_CONTEXT_PAGES,
  type EditingAction,
} from "./actions";
import {
  applyEditingActions,
  editingDiffSchema,
} from "./editing-engine";

const proposalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i);

const proposalSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => !/<\/?[a-z][^>]*>/i.test(value), {
    message: "HTML markup is not supported in proposal summaries.",
  });

const pageVersionSchema = z
  .object({
    pageId: z.string().min(1).max(80),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

const reviewRecordSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reviewerId: z.string().regex(/^[a-f0-9]{24}$/i),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const editingProposalSchema = z
  .object({
    proposalId: proposalIdSchema,
    summary: proposalSummarySchema,
    actions: editingActionsSchema,
    pageVersions: z
      .array(pageVersionSchema)
      .max(MAX_EDITING_CONTEXT_PAGES)
      .refine(
        (versions) =>
          new Set(versions.map((entry) => entry.pageId)).size === versions.length,
        { message: "Page version bindings must be unique." },
      ),
    diff: editingDiffSchema,
    preview: editingContextSchema,
    status: z.enum(["pending_review", "approved", "rejected"]),
    review: reviewRecordSchema.nullable(),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const reviewMatchesStatus =
      proposal.status === "pending_review"
        ? proposal.review === null
        : proposal.review?.decision === proposal.status;
    if (!reviewMatchesStatus) {
      ctx.addIssue({
        code: "custom",
        message: "Proposal status and review record must agree.",
        path: ["review"],
      });
    }

    const expectedVersions = new Map<string, number>();
    for (const action of proposal.actions) {
      if (action.kind !== "create-page") {
        const previousVersion = expectedVersions.get(action.pageId);
        if (
          previousVersion !== undefined &&
          previousVersion !== action.expectedVersion
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Actions for one page must use a consistent expected version.",
            path: ["actions"],
          });
        }
        expectedVersions.set(action.pageId, action.expectedVersion);
      }
    }
    if (
      proposal.pageVersions.length !== expectedVersions.size ||
      proposal.pageVersions.some(
        ({ pageId, expectedVersion }) =>
          expectedVersions.get(pageId) !== expectedVersion,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Page version bindings must match the proposal actions.",
        path: ["pageVersions"],
      });
    }
    const previewPages = new Map(
      proposal.preview.pages.map((page) => [page.id, page]),
    );
    for (const [pageId, expectedVersion] of expectedVersions) {
      const page = previewPages.get(pageId);
      if (
        !page ||
        page.status !== "draft" ||
        page.version !== expectedVersion
      ) {
        ctx.addIssue({
          code: "custom",
          message: "A bound page must remain a draft at its prepared version.",
          path: ["preview", "pages"],
        });
      }
    }
  });

export type EditingProposal = z.infer<typeof editingProposalSchema>;
export type EditingProposalReview = z.infer<typeof reviewRecordSchema>;
export type EditingProposalStatus = EditingProposal["status"];
export type EditingProposalDiff = z.infer<typeof editingDiffSchema>;

const proposalInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    summary: proposalSummarySchema,
    actions: editingActionsSchema,
  })
  .strict();

/**
 * Prepares a review-only proposal from validated context and candidate actions.
 * The ID is supplied by the caller so this pure function remains deterministic.
 * No persistence, authorization, or publishing is performed here.
 */
export function prepareEditingProposal(
  contextInput: unknown,
  candidateInput: unknown,
): EditingProposal {
  const context = editingContextSchema.parse(contextInput);
  const candidate = proposalInputSchema.parse(candidateInput);
  const result = applyEditingActions(context, candidate.actions);
  const pageVersions = collectPageVersions(candidate.actions);
  const diff = editingDiffSchema.parse({
    changes: result.changes,
    summary: result.summary,
  });

  return editingProposalSchema.parse({
    proposalId: candidate.proposalId,
    summary: candidate.summary,
    actions: candidate.actions,
    pageVersions,
    diff,
    preview: result.draft,
    status: "pending_review",
    review: null,
  });
}

/**
 * Records an explicit review decision. Reviewer identity must be supplied by a
 * trusted server caller after authorization; this pure transition is not proof
 * of identity and does not apply or publish the proposal.
 */
export function transitionEditingProposalReview(
  proposalInput: unknown,
  reviewInput: unknown,
): EditingProposal {
  const proposal = editingProposalSchema.parse(proposalInput);
  const review = reviewRecordSchema.parse(reviewInput);

  if (proposal.status !== "pending_review") {
    throw new EditingProposalTransitionError(
      "Only a proposal pending review may be approved or rejected.",
    );
  }

  return editingProposalSchema.parse({
    ...proposal,
    status: review.decision,
    review,
  });
}

export class EditingProposalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditingProposalTransitionError";
  }
}

function collectPageVersions(actions: readonly EditingAction[]) {
  const versions = new Map<string, number>();
  for (const action of actions) {
    if (action.kind === "create-page") continue;
    versions.set(action.pageId, action.expectedVersion);
  }
  return [...versions].map(([pageId, expectedVersion]) => ({
    pageId,
    expectedVersion,
  }));
}
