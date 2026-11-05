import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { listInvitations } from "@/lib/team-invitations";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** `GET` — invitations waiting to be accepted. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    return ok({ invitations: await listInvitations(id) }, { headers: { "Cache-Control": "no-store" } });
  });
}
