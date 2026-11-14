import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { WebsiteRevision, type RevisionReason, type RevisionTarget } from "@/models/WebsiteRevision";

/**
 * Saved versions of pages, the homepage, the design and the menus (server-only).
 * Callers authorise with `requireBusinessRole` first; every query is scoped to
 * the business. Recording is best effort: a failed history write must never stop
 * an owner from saving or publishing their work.
 */
const KEEP_PER_TARGET = 20;
/** How often a draft save keeps a copy of what it replaces. */
const CHECKPOINT_EVERY_MS = 30 * 60 * 1000;

export interface RevisionSummary {
  id: string;
  target: RevisionTarget;
  targetId: string;
  reason: RevisionReason;
  label: string;
  createdAt: string;
}

export async function recordRevision(input: {
  businessId: string;
  target: RevisionTarget;
  targetId?: string;
  reason: RevisionReason;
  label?: string;
  snapshot: unknown;
  createdBy?: unknown;
}): Promise<void> {
  try {
    await dbConnect();
    const business = new mongoose.Types.ObjectId(input.businessId);
    const targetId = input.targetId ?? "";
    await WebsiteRevision.create({
      business,
      target: input.target,
      targetId,
      reason: input.reason,
      label: (input.label ?? "").slice(0, 200),
      snapshot: input.snapshot,
      createdBy: input.createdBy ?? null,
    });
    // A deleted page's copy is its only way back, so it is not pruned with the rest.
    const old = await WebsiteRevision.find({ business, target: input.target, targetId, reason: { $ne: "deleted" } })
      .sort({ createdAt: -1, _id: -1 })
      .skip(KEEP_PER_TARGET)
      .select("_id")
      .lean();
    if (old.length > 0) await WebsiteRevision.deleteMany({ _id: { $in: old.map((row) => row._id) }, business });
  } catch (error) {
    console.error(JSON.stringify({ event: "website_revision_failed", target: input.target, category: error instanceof Error ? error.name : "unknown" }));
  }
}

/**
 * Keeps the version visitors see now when there is no history yet, so the first
 * publish does not lose the only copy of an older live version.
 */
export async function recordLiveCopyIfNoHistory(input: {
  businessId: string;
  target: RevisionTarget;
  targetId?: string;
  label?: string;
  snapshot: unknown;
  createdBy?: unknown;
}): Promise<void> {
  try {
    await dbConnect();
    const existing = await WebsiteRevision.findOne({ business: input.businessId, target: input.target, targetId: input.targetId ?? "", reason: { $ne: "deleted" } })
      .select("_id")
      .lean();
    if (existing) return;
  } catch {
    return;
  }
  await recordRevision({ ...input, reason: "published" });
}

/** Keeps what a draft save is about to replace, at most once per half hour. */
export async function recordCheckpointIfDue(input: {
  businessId: string;
  target: RevisionTarget;
  targetId?: string;
  label?: string;
  snapshot: unknown;
  createdBy?: unknown;
  now?: Date;
}): Promise<void> {
  try {
    await dbConnect();
    const latest = await WebsiteRevision.findOne({ business: input.businessId, target: input.target, targetId: input.targetId ?? "" })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();
    const now = (input.now ?? new Date()).getTime();
    if (latest && now - new Date(latest.createdAt).getTime() < CHECKPOINT_EVERY_MS) return;
  } catch {
    return;
  }
  await recordRevision({ ...input, reason: "checkpoint" });
}

export async function listRevisions(businessId: string, filter: { target?: RevisionTarget; targetId?: string; reason?: RevisionReason }): Promise<RevisionSummary[]> {
  await dbConnect();
  const rows = await WebsiteRevision.find({
    business: businessId,
    ...(filter.target ? { target: filter.target } : {}),
    ...(filter.targetId !== undefined ? { targetId: filter.targetId } : {}),
    ...(filter.reason ? { reason: filter.reason } : {}),
  })
    .select("target targetId reason label createdAt")
    .sort({ createdAt: -1, _id: -1 })
    .limit(40)
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    target: row.target,
    targetId: row.targetId,
    reason: row.reason,
    label: row.label,
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

export async function getRevision(businessId: string, revisionId: string) {
  if (!mongoose.isValidObjectId(revisionId)) return null;
  await dbConnect();
  return WebsiteRevision.findOne({ _id: revisionId, business: businessId }).lean();
}

export async function deleteRevision(businessId: string, revisionId: string): Promise<void> {
  await WebsiteRevision.deleteOne({ _id: revisionId, business: businessId });
}
