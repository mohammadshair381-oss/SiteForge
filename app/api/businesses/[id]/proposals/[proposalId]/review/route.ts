import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { reviewProposal, reviewProposalSchema } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string; proposalId: string }>;
}

/** `POST { decision: "approve" | "reject", note? }` — review a pending proposal. Nothing is applied. */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, proposalId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    const input = reviewProposalSchema.parse(await readJson(request));
    return ok({ proposal: await reviewProposal({ businessId: id, proposalId, actorId: String(user._id), ...input }) });
  });
}
