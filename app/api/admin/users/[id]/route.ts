import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { verifyPassword } from "@/lib/auth/password";
import { enforceRateLimit } from "@/lib/rate-limit";
import { ROLE_ACTIONS, applyUserAdminAction, userActionSchema } from "@/lib/admin/user-actions";
import { User } from "@/models/User";
import { recordSecurityEvent } from "@/lib/security-events";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const ACTION_WINDOW_MS = 10 * 60 * 1000;
const ACTION_LIMIT = 30;

/**
 * `PATCH /api/admin/users/[id]` `{ action, reason, currentPassword? }` (super admin only).
 *
 * Actions: deactivate, reactivate, grant_super_admin, revoke_super_admin,
 * force_signout. All end the target's existing sessions. Role changes also
 * require the acting admin's current password. Platform role only: business
 * memberships are never changed here. See lib/admin/user-actions.ts.
 */
export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    await enforceRateLimit({ key: `admin:user-action:${admin._id}`, limit: ACTION_LIMIT, windowMs: ACTION_WINDOW_MS });
    const { id } = await context.params;
    const input = userActionSchema.parse(await readJson(request));
    await dbConnect();

    if (ROLE_ACTIONS.includes(input.action)) {
      if (!input.currentPassword) {
        throw new HttpError(400, "Enter your password to change platform roles.", "reauthentication_required");
      }
      const self = await User.findById(admin._id).select("+passwordHash");
      if (!self || !(await verifyPassword(input.currentPassword, self.passwordHash))) {
        await recordSecurityEvent({ type: "admin_reauth_failed", userId: admin._id, request });
        throw new HttpError(403, "Your password is incorrect.", "reauthentication_failed");
      }
    }

    const user = await applyUserAdminAction({
      actorId: String(admin._id),
      targetId: id,
      action: input.action,
      reason: input.reason,
    });
    return ok({ user });
  });
}
