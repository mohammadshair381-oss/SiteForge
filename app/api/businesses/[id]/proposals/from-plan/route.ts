import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole, requireVerifiedEmail } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { assessPlanProvenance } from "@/lib/ai-planning/plan-provenance";
import { validateWebsitePlanReferences } from "@/lib/ai-planning/validate-plan-references";
import {
  createProposal,
  planToEditingActions,
  proposalFromPlanSchema,
} from "@/lib/ai-planning/proposal-service";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `POST { plan, summary? }` — turns a plan into a pending proposal (new draft
 * pages only). The plan comes from the browser and may have been edited, so the
 * complete plan is checked again here, right before it is saved: the schema, its
 * business-scoped references, and (lib/ai-planning/plan-provenance.ts) which pages
 * came from AI, with edits to those held to the same claims check. Nothing is
 * applied, and no AI is used, so this costs no allowance.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await requireVerifiedEmail();
    await enforceRateLimit({ key: `proposals:create:${id}`, limit: 30, windowMs: 60 * 60 * 1000 });
    const input = proposalFromPlanSchema.parse(await readJson(request));
    const { plan, actions } = planToEditingActions(input.plan);
    await validateWebsitePlanReferences(id, plan);
    const provenance = await assessPlanProvenance(id, plan);
    const fromAi = provenance.aiPageSlugs.length > 0;
    const summary = input.summary ?? `Add ${actions.length} draft page${actions.length === 1 ? "" : "s"} from the website planner`;
    const proposal = await createProposal({
      businessId: id,
      actorId: String(user._id),
      source: fromAi ? "ai" : "planner",
      summary,
      actions,
      ...(fromAi ? { aiPageSlugs: provenance.aiPageSlugs, request: provenance.request } : {}),
    });
    return ok({ proposal, provenance: { aiPages: provenance.aiPageSlugs.length, ownerPages: plan.pages.length - provenance.aiPageSlugs.length } }, { status: 201 });
  });
}
