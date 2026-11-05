import { handle, ok, HttpError } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { isValidObjectId } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";
import { resendInvitation, revokeInvitation } from "@/lib/team-invitations";

interface RouteContext {
  params: Promise<{ id: string; invitationId: string }>;
}

/** `POST` — sends a new link and retires the old one. */
export async function POST(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, invitationId } = await context.params;
    const verified = await requireVerifiedEmail();
    const { membership, user } = await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(invitationId)) throw new HttpError(404, "Invitation not found", "not_found");
    await enforceRateLimit({ key: `members:invite:${String(verified._id)}`, windowMs: 60 * 60 * 1000, limit: 30 });
    return ok({ invitation: await resendInvitation({ businessId: id, invitationId, inviter: user, inviterRole: membership.role }) });
  });
}

/** `DELETE` — revokes it, so its link stops working. */
export async function DELETE(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, invitationId } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(invitationId)) throw new HttpError(404, "Invitation not found", "not_found");
    await revokeInvitation({ businessId: id, invitationId, inviterRole: membership.role });
    return ok({ revoked: true });
  });
}
