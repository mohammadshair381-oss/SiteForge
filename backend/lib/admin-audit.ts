import mongoose, { type ClientSession } from "mongoose";
import { HttpError } from "./api";
import {
  AdminAuditLog,
  type AdminAuditAction,
  type AdminAuditTargetType,
} from "@/models/AdminAuditLog";

/**
 * Server-only helpers for sensitive platform-admin actions.
 *
 * `runAuditedAdminAction` performs the action and writes its audit record in
 * ONE transaction: if the action throws or the audit insert fails, both roll
 * back, so a record exists exactly when the action succeeded. Requires a
 * replica set, like the other transactional routes (see AGENTS.md).
 */

export interface AdminAuditEntry {
  actorId: string;
  action: AdminAuditAction;
  targetType: AdminAuditTargetType;
  targetId: string;
  targetLabel?: string;
  reason?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/** Minimum/maximum length of the reason required for sensitive actions. */
export const ADMIN_REASON_MIN = 5;
export const ADMIN_REASON_MAX = 500;

function isTransactionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const labels = (error as { errorLabels?: unknown }).errorLabels;
  if (Array.isArray(labels) && labels.includes("TransientTransactionError")) return true;
  return (error as { code?: unknown }).code === 112; // WriteConflict
}

export async function runAuditedAdminAction<T>(
  work: (session: ClientSession) => Promise<{ result: T; audit: AdminAuditEntry }>,
  options: {
    /** Return true to skip the audit record (e.g. a no-op update). */
    skipAuditWhen?: (result: T) => boolean;
  } = {},
): Promise<T> {
  const session = await mongoose.connection.startSession();
  try {
    let output: T | undefined;
    try {
      await session.withTransaction(async () => {
        const { result, audit } = await work(session);
        output = result;
        if (options.skipAuditWhen?.(result)) return;
        await AdminAuditLog.create(
          [
            {
              actor: audit.actorId,
              action: audit.action,
              targetType: audit.targetType,
              targetId: audit.targetId,
              targetLabel: (audit.targetLabel ?? "").slice(0, 160),
              reason: (audit.reason ?? "").slice(0, ADMIN_REASON_MAX),
              before: audit.before ?? null,
              after: audit.after ?? null,
            },
          ],
          { session },
        );
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (isTransactionalConflict(error)) {
        throw new HttpError(409, "The change conflicted with another update. Reload and retry.", "conflict");
      }
      throw error;
    }
    return output as T;
  } finally {
    await session.endSession();
  }
}

/** Shallow diff of two plain objects: only keys whose values differ. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}
