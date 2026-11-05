import { handle, ok } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { applyProposal } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string; proposalId: string }>;
}

/**
 * `POST {}` — applies an APPROVED proposal to draft pages (never publishes).
 * Publishing stays the existing, separate publish action.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, proposalId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    await enforceRateLimit({ key: `proposals:apply:${id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    const proposal = await applyProposal({ businessId: id, proposalId, actorId: String(user._id) });
    return ok({
      proposal,
      published: false,
      message: "Applied to draft pages. Nothing was published; publish from Pages when you are ready.",
    });
  });
}
