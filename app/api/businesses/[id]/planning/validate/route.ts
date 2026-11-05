import { dbConnect } from "@/lib/db";
import { handle, ok, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { websitePlanSchema } from "@/lib/ai-planning/plan";
import { aiPlatformStatus } from "@/lib/ai-builder/provider";
import { assessPlanProvenance } from "@/lib/ai-planning/plan-provenance";
import { validateWebsitePlanReferences } from "@/lib/ai-planning/validate-plan-references";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    const plan = websitePlanSchema.parse(await readJson(request));
    await validateWebsitePlanReferences(id, plan);

    const provenance = await assessPlanProvenance(id, plan);
    const available = (await aiPlatformStatus()).tasks.planning;
    return ok({
      plan,
      ai: {
        available,
        reason: available ? null : "provider_not_configured",
      },
      review: {
        validated: true,
        saved: false,
        applied: false,
        aiPages: provenance.aiPageSlugs.length,
        message: "This plan is validated for review only. No website content was changed.",
      },
    });
  });
}
