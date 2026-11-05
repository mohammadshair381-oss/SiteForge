import { dbConnect } from "@/lib/db";
import { handle, ok, created, readJson } from "@/lib/api";
import { requireVerifiedEmail, requireBusinessRole } from "@/lib/auth/guards";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createInvitation } from "@/lib/team-invitations";
import { membershipInviteSchema } from "@/lib/validation";
import { Membership } from "@/models/Membership";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();
    const members = await Membership.find({ business: id })
      .populate("user", "name email")
      .sort({ createdAt: 1 })
      .lean();
    return ok({ members });
  });
}

/**
 * `POST { email, role }` invites someone (lib/team-invitations.ts). The answer is
 * the same whether or not the address has an account, and nobody joins until they
 * accept. Owners may invite to any role; managers only to staff, and only if the
 * owner allows it.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const verified = await requireVerifiedEmail();
    const { membership, user } = await requireBusinessRole(id, ["owner", "manager"]);
    await enforceRateLimit({ key: `members:invite:${String(verified._id)}`, windowMs: 60 * 60 * 1000, limit: 30 });
    const body = membershipInviteSchema.parse(await readJson(request));
    const invitation = await createInvitation({ businessId: id, inviter: user, inviterRole: membership.role, email: body.email, role: body.role });
    return created({ invitation });
  });
}
