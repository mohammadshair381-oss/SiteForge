import { handle, ok } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { proposalView } from "@/lib/ai-planning/proposal-service";
import { refreshWebsiteProposal } from "@/lib/ai-website/proposal";

interface RouteContext {
  params: Promise<{ id: string; proposalId: string }>;
}

/**
 * `POST {}`: brings a stale whole-website proposal up to date with the drafts as they are now. No provider
 * is asked and no allowance is used. Newer edits always stay: if they overlap with the proposal, nothing
 * changes and the answer names the overlap. The result is a new proposal, to review like any other.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, proposalId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    await enforceRateLimit({ key: `proposals:create:${id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    const result = await refreshWebsiteProposal({ businessId: id, proposalId, actorId: String(user._id) });
    return ok({ proposal: result.proposal ? proposalView(result.proposal) : null, conflicts: result.conflicts, unchanged: result.unchanged });
  });
}
