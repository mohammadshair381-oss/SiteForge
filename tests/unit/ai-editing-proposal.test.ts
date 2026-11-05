import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSection } from "@/lib/sections";
import {
  editingContextSchema,
  type EditingContext,
} from "@/lib/ai-planning/actions";
import {
  EditingProposalTransitionError,
  editingProposalSchema,
  prepareEditingProposal,
  transitionEditingProposalReview,
} from "@/lib/ai-planning/proposal";

const pageId = "0123456789abcdef01234567";
const reviewerId = "1123456789abcdef01234567";

function makeContext(): EditingContext {
  return editingContextSchema.parse({
    pages: [
      {
        id: pageId,
        title: "Home",
        slug: "home",
        status: "draft",
        version: 7,
        sections: [
          {
            ...createDefaultSection("hero", 0),
            id: "hero-main",
            settings: { headline: "Welcome", subheadline: "Original copy" },
          },
        ],
      },
    ],
    allowedMediaUrls: [],
  });
}

function makeActions() {
  return [
    {
      actionId: "update-hero",
      kind: "update-section",
      pageId,
      expectedVersion: 7,
      section: {
        ...createDefaultSection("hero", 0),
        id: "hero-main",
        settings: { headline: "A better welcome", subheadline: "New copy" },
      },
    },
    {
      actionId: "create-about",
      kind: "create-page",
      title: "About us",
      slug: "about-us",
      sections: [createDefaultSection("about", 0)],
    },
  ];
}

function makeProposal() {
  return prepareEditingProposal(makeContext(), {
    proposalId: "proposal-123",
    summary: "Refresh the home hero and add an About page.",
    actions: makeActions(),
  });
}

function makeReview(decision: "approved" | "rejected") {
  return {
    decision,
    reviewerId,
    reviewedAt: "2026-10-26T10:00:00.000Z",
  };
}

test("proposal preparation validates actions, binds page versions, and creates a draft preview", () => {
  const proposal = makeProposal();

  assert.equal(proposal.status, "pending_review");
  assert.equal(proposal.review, null);
  assert.deepEqual(proposal.pageVersions, [{ pageId, expectedVersion: 7 }]);
  assert.equal(proposal.diff.summary.actionsApplied, 2);
  assert.equal(proposal.diff.summary.pagesCreated, 1);
  assert.deepEqual(
    proposal.diff.changes.map((change) => change.kind),
    ["update-section", "create-page"],
  );
  assert.equal(proposal.preview.pages[0].sections[0].type, "hero");
  assert.equal(proposal.preview.pages[1].status, "draft");
});

test("proposal preparation rejects invalid actions and unknown candidate fields atomically", () => {
  const context = makeContext();
  assert.throws(() =>
    prepareEditingProposal(context, {
      proposalId: "proposal-invalid",
      summary: "Attempt an invalid edit.",
      actions: [
        ...makeActions(),
        {
          actionId: "missing-target",
          kind: "remove-section",
          pageId,
          expectedVersion: 7,
          sectionId: "not-present",
        },
      ],
    }),
  );
  assert.throws(() =>
    prepareEditingProposal(context, {
      proposalId: "proposal-invalid",
      summary: "Attempt an invalid edit.",
      actions: [{ ...makeActions()[0], unsupported: true }],
    }),
  );
  assert.throws(() =>
    prepareEditingProposal(context, {
      proposalId: "proposal-invalid",
      summary: "Attempt an invalid edit.",
      actions: [{ actionId: "unknown", kind: "publish-page" }],
    }),
  );
  assert.throws(() =>
    prepareEditingProposal(context, {
      proposalId: "proposal-invalid",
      summary: "Attempt an invalid edit.",
      actions: makeActions(),
      arbitrary: "not allowed",
    }),
  );
});

test("proposal diff is deterministic and page version bindings cannot be changed", () => {
  const first = makeProposal();
  const second = makeProposal();
  assert.deepEqual(first.diff, second.diff);
  assert.deepEqual(first.pageVersions, second.pageVersions);

  assert.equal(
    editingProposalSchema.safeParse({
      ...first,
      pageVersions: [{ pageId, expectedVersion: 6 }],
    }).success,
    false,
  );
  assert.equal(
    editingProposalSchema.safeParse({
      ...first,
      pageVersions: [],
    }).success,
    false,
  );
  assert.equal(
    editingProposalSchema.safeParse({
      ...first,
      preview: {
        ...first.preview,
        pages: first.preview.pages.map((page) =>
          page.id === pageId ? { ...page, version: 8 } : page,
        ),
      },
    }).success,
    false,
  );
});

test("proposal preparation and review transitions do not mutate inputs", () => {
  const context = makeContext();
  const actions = makeActions();
  const beforeContext = structuredClone(context);
  const beforeActions = structuredClone(actions);
  const candidate = {
    proposalId: "proposal-immutable",
    summary: "Keep input data unchanged.",
    actions,
  };
  const beforeCandidate = structuredClone(candidate);

  const proposal = prepareEditingProposal(context, candidate);
  const beforeProposal = structuredClone(proposal);
  const review = makeReview("approved");
  const beforeReview = structuredClone(review);
  transitionEditingProposalReview(proposal, review);

  assert.deepEqual(context, beforeContext);
  assert.deepEqual(actions, beforeActions);
  assert.deepEqual(candidate, beforeCandidate);
  assert.deepEqual(proposal, beforeProposal);
  assert.deepEqual(review, beforeReview);
});

test("proposal schema rejects unknown fields and invalid review statuses", () => {
  const proposal = makeProposal();
  assert.equal(
    editingProposalSchema.safeParse({
      ...proposal,
      extra: "not allowed",
    }).success,
    false,
  );
  assert.equal(
    editingProposalSchema.safeParse({
      ...proposal,
      status: "applied",
    }).success,
    false,
  );
  assert.equal(
    editingProposalSchema.safeParse({
      ...proposal,
      status: "approved",
    }).success,
    false,
  );
  assert.equal(
    editingProposalSchema.safeParse({
      ...proposal,
      review: { decision: "approved", reviewerId, reviewedAt: "invalid" },
    }).success,
    false,
  );
});

test("only pending proposals transition once to approved or rejected", () => {
  const pending = makeProposal();
  const approved = transitionEditingProposalReview(pending, makeReview("approved"));
  const rejected = transitionEditingProposalReview(pending, makeReview("rejected"));

  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.review, makeReview("approved"));
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(rejected.review, makeReview("rejected"));

  assert.throws(
    () => transitionEditingProposalReview(approved, makeReview("approved")),
    EditingProposalTransitionError,
  );
  assert.throws(
    () => transitionEditingProposalReview(approved, makeReview("rejected")),
    EditingProposalTransitionError,
  );
  assert.throws(
    () => transitionEditingProposalReview(rejected, makeReview("approved")),
    EditingProposalTransitionError,
  );
  assert.throws(
    () => transitionEditingProposalReview(rejected, makeReview("rejected")),
    EditingProposalTransitionError,
  );
});

test("approval records a decision only; it does not publish or persist a proposal", () => {
  const pending = makeProposal();
  const approved = transitionEditingProposalReview(pending, makeReview("approved"));

  assert.equal("applied" in approved, false);
  assert.equal("published" in approved, false);
  assert.deepEqual(approved.preview, pending.preview);
  assert.deepEqual(approved.diff, pending.diff);
  assert.equal(approved.preview.pages.every((page) => page.status === "draft"), true);
});
