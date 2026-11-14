import crypto from "node:crypto";
import { dbConnect } from "@/lib/db";
import { ScheduledJob, type ScheduledRunRecord } from "@/models/ScheduledJob";

/**
 * Work started by an external scheduler (server-only). SiteForge does not run or set up a
 * scheduler: anything that can send an authenticated POST can call the endpoints
 * (docs/scheduled-jobs.md). This stops two runs of a job overlapping, and records how each
 * one went. The lock is a lease, so a run that dies cannot block the job for ever.
 */
export type ScheduledJobKey = "billing-reconcile" | "domain-health" | "cart-cleanup" | "media-cleanup" | "conversation-cleanup" | "order-expiry";

export const SCHEDULED_JOB_LABELS: Record<ScheduledJobKey, string> = {
  "billing-reconcile": "Billing reconciliation",
  "domain-health": "Custom domain checks",
  "cart-cleanup": "Expired cart cleanup",
  "media-cleanup": "Media storage cleanup",
  "conversation-cleanup": "Expired AI conversation cleanup",
  "order-expiry": "Expired order reservation release",
};

/** The most any run handles, whatever is configured. */
export const SCHEDULED_BATCH_MAX = 50;

export interface ScheduledRunCounts {
  checked: number;
  changed: number;
  failed: number;
  skipped: number;
  stoppedEarly: boolean;
}

export type ScheduledJobResult = { status: "overlap" } | { status: "ran"; run: ScheduledRunRecord };

const RECENT_RUNS_KEPT = 20;
const LEASE_MARGIN_MS = 5 * 60 * 1000;

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);

/** Takes the lock if nothing holds it, or if the holder's lease ran out. */
async function acquire(key: ScheduledJobKey, leaseMs: number, now: Date): Promise<string | null> {
  const token = crypto.randomUUID();
  try {
    await ScheduledJob.findOneAndUpdate(
      { _id: key, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockToken: token, lockedUntil: new Date(now.getTime() + leaseMs), lastStartedAt: now } },
      { upsert: true },
    );
    return token;
  } catch (error) {
    // Held: the filter did not match, so the upsert ran into the existing `_id`.
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

/** Runs `work` unless a run of this job is already going. A failed run is recorded, not thrown. */
export async function runScheduledJob(key: ScheduledJobKey, options: { timeBudgetMs: number }, work: () => Promise<ScheduledRunCounts>): Promise<ScheduledJobResult> {
  await dbConnect();
  const startedAt = new Date();
  const token = await acquire(key, options.timeBudgetMs + LEASE_MARGIN_MS, startedAt);
  if (!token) {
    await ScheduledJob.updateOne({ _id: key }, { $set: { lastOverlapAt: startedAt }, $inc: { overlapsSkipped: 1 } }).catch(() => undefined);
    return { status: "overlap" };
  }

  let run: ScheduledRunRecord;
  try {
    const counts = await work();
    run = { ...counts, startedAt, finishedAt: new Date(), outcome: counts.failed > 0 ? "partial" : "completed" };
  } catch {
    // Never the error itself: it could carry a provider's answer.
    console.error("[scheduled-job] a run could not finish", { job: key });
    run = { startedAt, finishedAt: new Date(), outcome: "failed", checked: 0, changed: 0, failed: 0, skipped: 0, stoppedEarly: false };
  }

  try {
    await ScheduledJob.updateOne(
      { _id: key },
      { $set: { lastFinishedAt: run.finishedAt, lastOutcome: run.outcome }, $push: { recent: { $each: [run], $position: 0, $slice: RECENT_RUNS_KEPT } } },
    );
  } catch {
    console.error("[scheduled-job] a result could not be recorded", { job: key });
  }
  // Only this run's own lock: a run that outlived its lease must not free its successor's.
  await ScheduledJob.updateOne({ _id: key, lockToken: token }, { $set: { lockToken: null, lockedUntil: null } }).catch(() => {
    console.error("[scheduled-job] a lock could not be released; its lease will end it", { job: key });
  });
  return { status: "ran", run };
}

export interface ScheduledJobStatus {
  key: ScheduledJobKey;
  label: string;
  running: boolean;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOutcome: string | null;
  overlapsSkipped: number;
  lastOverlapAt: Date | null;
  recent: ScheduledRunRecord[];
}

/** For the Super Admin. Never the lock token. */
export async function getScheduledJobStatus(key: ScheduledJobKey): Promise<ScheduledJobStatus> {
  await dbConnect();
  const job = await ScheduledJob.findById(key).select("-lockToken").lean();
  return {
    key,
    label: SCHEDULED_JOB_LABELS[key],
    running: Boolean(job?.lockedUntil && new Date(job.lockedUntil).getTime() > Date.now()),
    lastStartedAt: job?.lastStartedAt ?? null,
    lastFinishedAt: job?.lastFinishedAt ?? null,
    lastOutcome: job?.lastOutcome ?? null,
    overlapsSkipped: job?.overlapsSkipped ?? 0,
    lastOverlapAt: job?.lastOverlapAt ?? null,
    recent: job?.recent ?? [],
  };
}

const intSetting = (name: string, fallback: number, min: number, max: number) => {
  const parsed = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};

const HOUR_MS = 60 * 60 * 1000;

function settings(prefix: string, gapHours: number) {
  return {
    limit: intSetting(`${prefix}_BATCH_SIZE`, SCHEDULED_BATCH_MAX, 1, SCHEDULED_BATCH_MAX),
    minGapMs: intSetting(`${prefix}_MIN_GAP_HOURS`, gapHours, 1, 168) * HOUR_MS,
    timeBudgetMs: intSetting(`${prefix}_TIME_BUDGET_SECONDS`, 240, 30, 840) * 1000,
  };
}

export const billingReconcileSettings = () => settings("BILLING_RECONCILE", 6);
export const domainHealthSettings = () => settings("DOMAIN_HEALTH", 24);
export const cartCleanupSettings = () => ({ timeBudgetMs: settings("CART_CLEANUP", 24).timeBudgetMs });
export const conversationCleanupSettings = () => ({ timeBudgetMs: settings("CONVERSATION_CLEANUP", 24).timeBudgetMs });
export const orderExpirySettings = () => {
  const { limit, timeBudgetMs } = settings("ORDER_EXPIRY", 24);
  return { limit, timeBudgetMs };
};
export const mediaCleanupSettings = () => {
  const { limit, timeBudgetMs } = settings("MEDIA_CLEANUP", 24);
  return { limit, timeBudgetMs };
};
