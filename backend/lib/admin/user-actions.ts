import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import type { AdminAuditAction } from "@/models/AdminAuditLog";
import { User } from "@/models/User";

/**
 * Super-admin actions on PLATFORM user accounts (server-only).
 *
 * - Business membership roles (owner / manager / staff) are never read or
 *   changed here: platform role and business roles stay separate.
 * - Every action increments `tokenVersion`, which `requireUser()` checks on
 *   every request, so all of the user's existing sessions stop working
 *   immediately (deactivation, role changes and forced sign-out alike).
 *   All but reactivation also increment `deviceTrustVersion`, so known
 *   devices must confirm an emailed sign-in code again.
 * - Each change is a conditional update recorded in the append-only admin
 *   audit log in the same transaction (`runAuditedAdminAction`).
 * - Lock-out protection: an admin cannot act on their own account, and the
 *   platform always keeps at least one active super admin. Concurrent
 *   requests are serialised by writing every active super-admin document in
 *   the same transaction (write conflict -> retry with fresh data), so two
 *   admins demoting each other at once cannot both succeed.
 */

export const USER_ADMIN_ACTIONS = [
  "deactivate",
  "reactivate",
  "grant_super_admin",
  "revoke_super_admin",
  "force_signout",
] as const;
export type UserAdminAction = (typeof USER_ADMIN_ACTIONS)[number];

/** Role changes need the acting admin's current password (step-up check). */
export const ROLE_ACTIONS: readonly UserAdminAction[] = ["grant_super_admin", "revoke_super_admin"];

export const userActionSchema = z
  .object({
    action: z.enum(USER_ADMIN_ACTIONS),
    reason: z
      .string()
      .trim()
      .min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`)
      .max(ADMIN_REASON_MAX),
    /** Only for role changes; never stored or logged. */
    currentPassword: z.string().min(1).max(200).optional(),
  })
  .strict();

const AUDIT_ACTION: Record<UserAdminAction, AdminAuditAction> = {
  deactivate: "user.deactivate",
  reactivate: "user.reactivate",
  grant_super_admin: "user.grant_super_admin",
  revoke_super_admin: "user.revoke_super_admin",
  force_signout: "user.force_signout",
};

/** Precondition (beyond the id) for each action's conditional update. */
const FILTER: Record<UserAdminAction, Record<string, unknown>> = {
  deactivate: { active: { $ne: false } },
  reactivate: { active: false },
  grant_super_admin: { platformRole: "user", active: { $ne: false } },
  revoke_super_admin: { platformRole: "super_admin" },
  force_signout: { active: { $ne: false } },
};

// `deviceTrustVersion` (see User): these four are security responses, so every known-device marker
// and pending new-device sign-in of the account stops working too, and each browser must enter an
// emailed code again. Reactivation needs no bump: the deactivation before it already raised it.
const UPDATE: Record<UserAdminAction, Record<string, unknown>> = {
  deactivate: { $set: { active: false }, $inc: { tokenVersion: 1, deviceTrustVersion: 1 } },
  reactivate: { $set: { active: true }, $inc: { tokenVersion: 1 } },
  grant_super_admin: { $set: { platformRole: "super_admin" }, $inc: { tokenVersion: 1, deviceTrustVersion: 1 } },
  revoke_super_admin: { $set: { platformRole: "user" }, $inc: { tokenVersion: 1, deviceTrustVersion: 1 } },
  force_signout: { $inc: { tokenVersion: 1, deviceTrustVersion: 1 } },
};

const REFUSAL: Record<UserAdminAction, { message: string; code: string }> = {
  deactivate: { message: "This account is already deactivated.", code: "already_inactive" },
  reactivate: { message: "This account is already active.", code: "already_active" },
  grant_super_admin: { message: "Only an active account without platform admin rights can be promoted.", code: "not_promotable" },
  revoke_super_admin: { message: "This account is not a super admin.", code: "not_super_admin" },
  force_signout: { message: "A deactivated account has no sessions to end.", code: "already_inactive" },
};

export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  platformRole: string;
  active: boolean;
}

function view(user: { _id: unknown; name?: string; email?: string; platformRole?: string; active?: boolean }): AdminUserView {
  return {
    id: String(user._id),
    name: user.name ?? "",
    email: user.email ?? "",
    platformRole: user.platformRole ?? "user",
    active: user.active !== false,
  };
}

/**
 * Serialise every change that could reduce the set of active super admins and
 * verify at least one remains, inside the caller's transaction.
 */
async function assertAdminRemains(session: ClientSession): Promise<void> {
  await User.updateMany(
    { platformRole: "super_admin" },
    { $currentDate: { updatedAt: true } },
    { session, timestamps: false },
  );
  const remaining = await User.countDocuments({ platformRole: "super_admin", active: { $ne: false } }).session(session);
  if (remaining < 1) {
    throw new HttpError(409, "The platform must keep at least one active super admin.", "last_super_admin");
  }
}

export async function applyUserAdminAction(input: {
  actorId: string;
  targetId: string;
  action: UserAdminAction;
  reason: string;
}): Promise<AdminUserView> {
  if (!mongoose.isValidObjectId(input.targetId)) throw new HttpError(404, "User not found", "not_found");
  const targetId = new mongoose.Types.ObjectId(input.targetId);
  if (String(targetId) === input.actorId) {
    throw new HttpError(409, "You cannot change your own account here. Ask another super admin.", "self_action");
  }

  return runAuditedAdminAction(async (session) => {
    const previous = await User.findOneAndUpdate(
      { _id: targetId, ...FILTER[input.action] },
      UPDATE[input.action],
      { new: false, session },
    )
      .select("name email platformRole active")
      .lean();

    if (!previous) {
      const exists = await User.exists({ _id: targetId }).session(session);
      if (!exists) throw new HttpError(404, "User not found", "not_found");
      const refusal = REFUSAL[input.action];
      throw new HttpError(409, refusal.message, refusal.code);
    }

    const removesAdmin =
      input.action === "revoke_super_admin" ||
      (input.action === "deactivate" && previous.platformRole === "super_admin");
    if (removesAdmin) await assertAdminRemains(session);

    const after = {
      platformRole: input.action === "grant_super_admin" ? "super_admin" : input.action === "revoke_super_admin" ? "user" : previous.platformRole,
      active: input.action === "deactivate" ? false : input.action === "reactivate" ? true : previous.active !== false,
    };
    return {
      result: view({ ...previous, ...after }),
      audit: {
        actorId: input.actorId,
        action: AUDIT_ACTION[input.action],
        targetType: "user",
        targetId: String(targetId),
        // Name only: emails are not copied into the append-only log.
        targetLabel: previous.name ?? "",
        reason: input.reason,
        before: { platformRole: previous.platformRole, active: previous.active !== false },
        after: { ...after, sessionsRevoked: true, ...(input.action === "reactivate" ? {} : { trustedDevicesRevoked: true }) },
      },
    };
  });
}
