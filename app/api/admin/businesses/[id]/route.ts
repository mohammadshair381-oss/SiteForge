import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getAdminBusinessDetail } from "@/lib/admin/control-center";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET /api/admin/businesses/[id]` (super admin only, read-only): status,
 * subscription and plan, usage against limits, members, order and product
 * counts, payment-account status (never secrets) and the business's audit
 * history. Recent orders carry no shopper names or emails.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    await requireSuperAdmin();
    const { id } = await context.params;
    return ok(await getAdminBusinessDetail(id), { headers: { "Cache-Control": "no-store" } });
  });
}
