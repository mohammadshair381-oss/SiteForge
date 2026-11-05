import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { getEntitlements } from "@/lib/billing";
import { activeOrNewConversation, conversationView } from "@/lib/ai-website/conversation";
import { revisionTurn } from "@/lib/ai-website/generation";
import { proposalView } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const maxDuration = 90;

const bodySchema = z.object({ message: z.string().trim().min(3, "Describe the change you want.").max(1000, "Keep your message under 1000 characters.") }).strict();

/**
 * `POST { message }`: a change to the website in the owner's words. It becomes a proposal holding only
 * that change, reviewed and approved like every other. Nothing on the website changes here.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await guardAiRequest(request, id, "revision");
    const { message } = bodySchema.parse(await readJson(request));
    const doc = await activeOrNewConversation(id, String(user._id));
    const result = await revisionTurn({ businessId: id, actorId: String(user._id), doc, message });
    return ok({
      proposal: result.proposal ? proposalView(result.proposal) : null,
      message: result.message,
      notes: result.notes,
      conversation: await conversationView(result.doc),
      usage: await getAiUsageSummary(id, (await getEntitlements(id)).aiRequestsPerMonth),
    });
  });
}
