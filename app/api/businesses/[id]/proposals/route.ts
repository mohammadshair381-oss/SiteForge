import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createProposal, createProposalSchema, listProposals } from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET [?target=pages|storefront]` — this business's proposals (newest 50).
 * Owners and managers only.
 */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    const target = new URL(request.url).searchParams.get("target");
    const filter = target === "storefront" || target === "pages" ? { target: target as "storefront" | "pages" } : {};
    return ok({ proposals: await listProposals(id, filter, String(user._id)) }, { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * `POST { summary, actions }` — prepares a proposal from structured editing
 * actions against this business's DRAFT pages. Nothing is applied here.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    await enforceRateLimit({ key: `proposals:create:${id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    const input = createProposalSchema.parse(await readJson(request));
    const proposal = await createProposal({ businessId: id, actorId: String(user._id), source: "manual", ...input });
    return ok({ proposal }, { status: 201 });
  });
}
