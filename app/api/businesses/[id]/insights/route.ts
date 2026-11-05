import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getBusinessInsights, parseDateRange } from "@/lib/business-insights";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET /api/businesses/[id]/insights?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * Owners and managers only (same audience as orders). Measured values from
 * this business's own records; see lib/business-insights.ts for definitions.
 */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    const params = new URL(request.url).searchParams;
    const insights = await getBusinessInsights(id, parseDateRange(params.get("from"), params.get("to")));
    return ok(insights, { headers: { "Cache-Control": "no-store" } });
  });
}
