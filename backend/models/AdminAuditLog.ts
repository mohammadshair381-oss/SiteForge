import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * Append-only record of sensitive platform-admin actions.
 *
 * - Written only by the `/api/admin/*` routes, inside the same transaction as
 *   the action it records, so a record exists exactly when the action succeeded.
 * - No API exposes create/update/delete; the read API requires `super_admin`.
 * - Mongoose update/delete operations are refused below as defense in depth.
 * - `before` / `after` hold only the changed, non-sensitive fields (business
 *   status, plan settings). Never request bodies, tokens, passwords or emails.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "business.suspend",
  "business.reactivate",
  "plan.create",
  "plan.update",
  "plan.activate",
  "plan.deactivate",
  "plan.provider_mapping",
  "billing.reconcile",
  "user.deactivate",
  "user.reactivate",
  "user.grant_super_admin",
  "user.revoke_super_admin",
  "user.force_signout",
  "dispute.note",
  "business.plan_assign",
  "platform.settings",
  /** An AI provider's API key set or removed: only the last four characters are recorded. */
  "platform.ai_credentials",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export const ADMIN_AUDIT_TARGET_TYPES = ["business", "plan", "user", "dispute", "platform"] as const;
export type AdminAuditTargetType = (typeof ADMIN_AUDIT_TARGET_TYPES)[number];

export interface AdminAuditLogDoc {
  _id: Types.ObjectId;
  actor: Types.ObjectId;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  /** Business id, plan key, user id or dispute id. */
  targetId: string;
  /** Human-readable label at the time of the action (business/plan/user name, dispute reference). */
  targetLabel: string;
  reason: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
}

const adminAuditLogSchema = new Schema<AdminAuditLogDoc>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    action: { type: String, enum: ADMIN_AUDIT_ACTIONS, required: true, immutable: true },
    targetType: { type: String, enum: ADMIN_AUDIT_TARGET_TYPES, required: true, immutable: true },
    targetId: { type: String, required: true, maxlength: 80, immutable: true },
    targetLabel: { type: String, default: "", maxlength: 160, immutable: true },
    reason: { type: String, default: "", maxlength: 500, immutable: true },
    before: { type: Schema.Types.Mixed, default: null, immutable: true },
    after: { type: Schema.Types.Mixed, default: null, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

// No secondary indexes: the log is read newest-first by `_id` (ObjectIds are
// time-ordered and `_id` is always indexed), so this model creates no new
// indexes. Add one later only through an approved index change.

// Append-only: refuse every Mongoose-level update or delete.
function refuseMutation(): never {
  throw new Error("Admin audit records are append-only");
}
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "replaceOne",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  adminAuditLogSchema.pre(op, refuseMutation);
}
// Document-level variants: re-saving, updating or deleting a loaded record.
adminAuditLogSchema.pre("save", function () {
  if (!this.isNew) refuseMutation();
});
adminAuditLogSchema.pre("updateOne", { document: true, query: false }, refuseMutation);
adminAuditLogSchema.pre("deleteOne", { document: true, query: false }, refuseMutation);
// Not covered (no app code path uses them): raw driver access via
// `AdminAuditLog.collection.*` and `bulkWrite`. Database-level protection
// (e.g. a write-restricted DB user) would be needed for a hard guarantee.

export const AdminAuditLog: Model<AdminAuditLogDoc> =
  (models.AdminAuditLog as Model<AdminAuditLogDoc>) ||
  model<AdminAuditLogDoc>("AdminAuditLog", adminAuditLogSchema);
