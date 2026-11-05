import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getProposal } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string; proposalId: string }>;
}

/** `GET` — one proposal of this business with its diff, preview, staleness and history. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, proposalId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    return ok({ proposal: await getProposal(id, proposalId, String(user._id)) }, { headers: { "Cache-Control": "no-store" } });
  });
}
