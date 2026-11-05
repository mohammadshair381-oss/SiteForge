import { z } from "zod";
import { handle, ok, readJson } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { getEntitlements } from "@/lib/billing";
import { activeOrNewConversation, closeConversation, conversationView, loadActiveConversation, startConversation } from "@/lib/ai-website/conversation";
import { aiDiscoverySchema } from "@/lib/ai-website/answers";
import { addOwnerBrief, confirmFlaggedClaims, discoveryTurn, generationUnitsLeft } from "@/lib/ai-website/generation";
import { enforceRateLimit } from "@/lib/rate-limit";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const maxDuration = 90;

const bodySchema = z.object({ message: z.string().trim().min(1, "Write a message first.").max(1000, "Keep your message under 1000 characters.") }).strict();

/**
 * `GET`: this person's open website conversation for this store, so an interrupted one carries on.
 * Works with AI off: reading what is already stored sends nothing anywhere.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    const { doc, expired } = await loadActiveConversation(id, String(user._id));
    const usage = await getAiUsageSummary(id, (await getEntitlements(id)).aiRequestsPerMonth);
    return ok(
      { conversation: doc ? await conversationView(doc) : null, expired, unitsLeft: doc ? generationUnitsLeft(doc) : null, usage },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

/**
 * `POST { message }`: one message of the discovery conversation. It changes nothing on the website:
 * the owner starts generating separately. Same guards as every AI request (lib/ai-builder/guard.ts).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await guardAiRequest(request, id, "discovery");
    const { message } = bodySchema.parse(await readJson(request));
    const doc = await activeOrNewConversation(id, String(user._id));
    const result = await discoveryTurn({ businessId: id, doc, message });
    return ok({ conversation: await conversationView(result.doc), unitsLeft: generationUnitsLeft(result.doc) });
  });
}

const putSchema = z.union([
  z.object({ confirmClaims: z.literal(true) }).strict(),
  z.object({ brief: aiDiscoverySchema.shape.brief, message: z.string().trim().min(1).max(2000) }).strict(),
]);

/**
 * `PUT { confirmClaims: true }`: the owner says wording the claims check refused is true for their business.
 * `PUT { brief, message }`: a brief the owner wrote in the website planner, taken into the conversation.
 * Both only record what the owner said: no provider is asked, and no allowance is used.
 */
export async function PUT(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    await enforceRateLimit({ key: `ai:website:notes:${id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    const body = putSchema.parse(await readJson(request));
    const doc = await activeOrNewConversation(id, String(user._id));
    const updated = "confirmClaims" in body ? await confirmFlaggedClaims(doc) : await addOwnerBrief(doc, body.brief, body.message);
    return ok({ conversation: await conversationView(updated), unitsLeft: generationUnitsLeft(updated) });
  });
}

/** `DELETE`: removes the conversation and starts a fresh one. Its proposals stay, with their own state. */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await closeConversation(id, String(user._id));
    const doc = await startConversation(id, String(user._id));
    return ok({ conversation: await conversationView(doc), unitsLeft: generationUnitsLeft(doc) });
  });
}
