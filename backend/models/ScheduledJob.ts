import { Schema, model, models, type Model } from "mongoose";

/**
 * One document per scheduled job, holding its lock and recent results (lib/scheduled-jobs.ts).
 * The job's name is the `_id`, whose unique index MongoDB always provides, so this needs
 * no index of its own to stop two runs overlapping. Counts and short codes only.
 */
export type ScheduledRunOutcome = "completed" | "partial" | "failed";

export interface ScheduledRunRecord {
  startedAt: Date;
  finishedAt: Date;
  outcome: ScheduledRunOutcome;
  checked: number;
  changed: number;
  failed: number;
  skipped: number;
  stoppedEarly: boolean;
}

export interface ScheduledJobDoc {
  _id: string;
  lockToken: string | null;
  lockedUntil: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastOutcome: ScheduledRunOutcome | null;
  /** Calls refused because a run was already going. */
  overlapsSkipped: number;
  lastOverlapAt: Date | null;
  recent: ScheduledRunRecord[];
}

const scheduledRunSchema = new Schema<ScheduledRunRecord>(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    outcome: { type: String, required: true },
    checked: { type: Number, default: 0 },
    changed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    stoppedEarly: { type: Boolean, default: false },
  },
  { _id: false },
);

const scheduledJobSchema = new Schema<ScheduledJobDoc>(
  {
    _id: { type: String, required: true },
    lockToken: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastOutcome: { type: String, default: null },
    overlapsSkipped: { type: Number, default: 0 },
    lastOverlapAt: { type: Date, default: null },
    recent: { type: [scheduledRunSchema], default: [] },
  },
  { versionKey: false, autoIndex: false, autoCreate: false },
);

export const ScheduledJob: Model<ScheduledJobDoc> =
  (models.ScheduledJob as Model<ScheduledJobDoc>) || model<ScheduledJobDoc>("ScheduledJob", scheduledJobSchema);
