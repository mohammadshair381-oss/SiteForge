import { handle, ok, readJson } from "@/lib/api";
import { assignPlanToBusiness, planAssignmentSchema } from "@/lib/admin/plan-assignment";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { assertObjectId } from "@/lib/ids";

/** `POST { planKey, reason }`: see lib/admin/plan-assignment.ts for what this refuses. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { id } = await context.params;
    const businessId = assertObjectId(id, "business id");
    const { planKey, reason } = planAssignmentSchema.parse(await readJson(request));
    return ok(await assignPlanToBusiness({ businessId, adminId: String(admin._id), planKey, reason }));
  });
}
