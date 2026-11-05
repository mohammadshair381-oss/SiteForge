import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * A reviewable website change proposal (AI builder M1). Proposals are DATA:
 * validated editing actions (`lib/ai-planning/actions.ts`) against draft
 * pages of ONE business, plus the server-computed diff and preview. They are
 * created from the planner, from structured actions or from an AI suggestion
 * (`source` says which), and always reviewed before they change anything.
 *
 * Lifecycle (every transition is a conditional update; `history` is
 * append-only):
 *   pending -> approved -> applied
 *   pending -> rejected
 *   approved -> failed      (apply refused: stale page, slug taken, …)
 *   pending/approved -> failed (expired)
 * Applying only writes DRAFTS: pages through `applyApprovedEditingProposal`,
 * or (target "storefront") the draft store homepage and the store's brand
 * colours/font through `applyApprovedStorefrontProposal`
 * (lib/ai-builder/storefront-proposals.ts). Publishing stays the separate,
 * existing publish action.
 *
 * Index policy: `autoIndex` / `autoCreate` OFF; `{ business: 1, createdAt: -1 }`
 * is an approved operation (docs/ai-website-builder-plan.md).
 */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
export const PROPOSAL_SOURCES = ["manual", "planner", "ai"] as const;
/** What a proposal changes: draft pages, the draft store homepage (+ brand), or a whole website's drafts. */
export const PROPOSAL_TARGETS = ["pages", "storefront", "website"] as const;
export type ProposalTarget = (typeof PROPOSAL_TARGETS)[number];
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export const PROPOSAL_HISTORY_ACTIONS = ["created", "approved", "rejected", "applied", "apply_failed", "expired"] as const;
/** Pending or approved proposals older than this can no longer be applied. */
export const PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface ProposalHistoryEntry {
  at: Date;
  action: (typeof PROPOSAL_HISTORY_ACTIONS)[number];
  actor: Types.ObjectId | null;
  /** Error code for failures; short reviewer note otherwise. Never content. */
  note: string | null;
}

export interface WebsiteProposalDoc {
  _id: Types.ObjectId;
  business: Types.ObjectId;
  createdBy: Types.ObjectId;
  source: ProposalSource;
  target: ProposalTarget;
  summary: string;
  /**
   * What the author typed for a single AI suggestion, scrubbed, and shown only to its author. Never the full
   * provider prompt, and always empty on a whole-website proposal: a conversation is private to the person having it.
   */
  request: string;
  /**
   * Store homepage proposals only: the validated change set and the state it
   * was prepared against (`baseHash` of the draft homepage + brand, so any
   * later edit makes the proposal stale).
   */
  storefront?: { baseHash: string; changes: unknown[]; notes: string[] };
  /** Whole-website proposals only (lib/ai-website/blueprint.ts `WebsiteProposalData`). */
  website?: unknown;
  /** Of the pages an AI proposal creates, which came from AI. Absent: all of them. */
  aiPageSlugs?: string[];
  /** Validated EditingAction[] (re-validated on every use). */
  actions: unknown[];
  pageVersions: Array<{ pageId: string; expectedVersion: number }>;
  /** Server-computed diff and post-change preview (editing context of the affected pages). */
  diff: unknown;
  preview: unknown;
  status: ProposalStatus;
  failureCode: string | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  appliedAt: Date | null;
  appliedPages: Array<{ id: string; title: string; slug: string; created: boolean }>;
  expiresAt: Date;
  history: ProposalHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const historySchema = new Schema<ProposalHistoryEntry>(
  {
    at: { type: Date, required: true },
    action: { type: String, enum: PROPOSAL_HISTORY_ACTIONS, required: true },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: null, maxlength: 280 },
  },
  { _id: false },
);

const websiteProposalSchema = new Schema<WebsiteProposalDoc>(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    source: { type: String, enum: PROPOSAL_SOURCES, required: true, immutable: true },
    target: { type: String, enum: PROPOSAL_TARGETS, default: "pages", immutable: true },
    summary: { type: String, required: true, maxlength: 280, immutable: true },
    request: { type: String, default: "", maxlength: 500, immutable: true },
    storefront: { type: Schema.Types.Mixed, default: undefined, immutable: true },
    website: { type: Schema.Types.Mixed, default: undefined, immutable: true },
    aiPageSlugs: { type: [String], default: undefined, immutable: true },
    actions: { type: [Schema.Types.Mixed], required: true, immutable: true },
    pageVersions: {
      type: [{ pageId: { type: String, required: true }, expectedVersion: { type: Number, required: true }, _id: false }],
      default: [],
      immutable: true,
    },
    diff: { type: Schema.Types.Mixed, required: true, immutable: true },
    preview: { type: Schema.Types.Mixed, required: true, immutable: true },
    status: { type: String, enum: PROPOSAL_STATUSES, default: "pending" },
    failureCode: { type: String, default: null, maxlength: 60 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    appliedPages: {
      type: [{ id: String, title: String, slug: String, created: Boolean, _id: false }],
      default: [],
    },
    expiresAt: { type: Date, required: true, immutable: true },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, versionKey: false, autoIndex: false, autoCreate: false, minimize: false },
);

websiteProposalSchema.index({ business: 1, createdAt: -1 });

export const WebsiteProposal: Model<WebsiteProposalDoc> =
  (models.WebsiteProposal as Model<WebsiteProposalDoc>) ||
  model<WebsiteProposalDoc>("WebsiteProposal", websiteProposalSchema);
