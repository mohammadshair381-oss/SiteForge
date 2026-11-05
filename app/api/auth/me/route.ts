import { handle, ok } from "@/lib/api";
import { requireUser, getMembershipsForUser } from "@/lib/auth/guards";

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    const memberships = await getMembershipsForUser(user._id.toString());
    return ok({
      user: user.toJSON(),
      memberships: memberships.map((membership) => ({
        id: String(membership._id),
        role: membership.role,
        business: membership.business,
      })),
    });
  });
}
