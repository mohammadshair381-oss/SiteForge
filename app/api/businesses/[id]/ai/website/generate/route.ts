import { handle, ok, HttpError } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { getEntitlements } from "@/lib/billing";
import { conversationView, loadActiveConversation } from "@/lib/ai-website/conversation";
import { generationStep, generationUnitsLeft } from "@/lib/ai-website/generation";
import { proposalView } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const maxDuration = 90;

/**
 * `POST {}`: does the next step of generating this conversation's website: the plan and homepage first,
 * then one page at a time, and finally the proposal. The client asks again until `done`. Closing the page
 * loses nothing: everything finished is stored, and a step that failed costs nothing. A step needs the
 * owner to have asked for it. Nothing here changes the website: the result waits for approval.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    // Every step of one website counts as a request, so the burst limit allows for a whole website.
    const { user } = await guardAiRequest(request, id, "website", { burstLimit: 40 });
    const { doc, expired } = await loadActiveConversation(id, String(user._id));
    if (!doc) {
      throw expired
        ? new HttpError(410, "This conversation ran out. Start a new one: nothing on your website has changed.", "conversation_expired")
        : new HttpError(404, "Tell the assistant about your website first.", "conversation_not_found");
    }
    const result = await generationStep({ businessId: id, actorId: String(user._id), doc });
    const { doc: latest } = await loadActiveConversation(id, String(user._id));
    const current = latest ?? doc;
    return ok({
      done: Boolean(result.proposal),
      proposal: result.proposal ? proposalView(result.proposal) : null,
      conversation: await conversationView(current),
      unitsLeft: generationUnitsLeft(current),
      usage: await getAiUsageSummary(id, (await getEntitlements(id)).aiRequestsPerMonth),
    });
  });
}
