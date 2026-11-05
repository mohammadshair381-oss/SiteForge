import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { auditFilter } from "@/lib/admin/control-center";
import { AdminAuditLog, ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGET_TYPES } from "@/models/AdminAuditLog";
import { User } from "@/models/User";

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).prefault(1),
  limit: z.coerce.number().int().min(1).max(100).prefault(25),
  // Optional filters (strict: an unknown value is a 422, not ignored).
  action: z.enum(ADMIN_AUDIT_ACTIONS).optional(),
  targetType: z.enum(ADMIN_AUDIT_TARGET_TYPES).optional(),
  targetId: z.string().trim().min(1).max(80).optional(),
  actor: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * `GET /api/admin/audit-logs?page=1&limit=25[&action=&targetType=&targetId=&actor=&from=YYYY-MM-DD&to=YYYY-MM-DD]`
 * (super admin only, read-only).
 *
 * Newest first (by `_id`, which is time-ordered and always indexed). There is
 * deliberately no POST/PATCH/DELETE: records are written only by the admin
 * action routes, inside the action's own transaction.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = new URL(request.url).searchParams;
    const query = querySchema.parse({
      page: params.get("page") ?? undefined,
      limit: params.get("limit") ?? undefined,
      action: params.get("action") || undefined,
      targetType: params.get("targetType") || undefined,
      targetId: params.get("targetId") || undefined,
      actor: params.get("actor") || undefined,
      from: params.get("from") || undefined,
      to: params.get("to") || undefined,
    });
    const { page, limit } = query;
    const filter = auditFilter(query);
    await dbConnect();

    const [entries, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({ path: "actor", select: "name", model: User })
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);

    return ok({
      page,
      limit,
      total,
      entries: entries.map((entry) => {
        const actor = entry.actor as unknown as { _id?: unknown; name?: string } | null;
        return {
          id: String(entry._id),
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          targetLabel: entry.targetLabel,
          reason: entry.reason,
          before: entry.before,
          after: entry.after,
          createdAt: entry.createdAt,
          actor: actor && actor._id
            ? { id: String(actor._id), name: actor.name ?? "" }
            : { id: String(entry.actor), name: "" },
        };
      }),
    });
  });
}
