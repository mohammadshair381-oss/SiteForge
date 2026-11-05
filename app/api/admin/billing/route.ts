import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { billingQuerySchema, getAdminBillingDetail, listAdminBilling } from "@/lib/billing-admin";
import { isValidObjectId } from "@/lib/ids";

/**
 * `GET /api/admin/billing?filter=&page=`, or `?business=<id>` for one store's payments,
 * refunds, disputes and events. Super admin only and read-only: billing state changes
 * only from what Razorpay reports.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = new URL(request.url).searchParams;
    const business = params.get("business");
    const headers = { "Cache-Control": "no-store" };
    if (business && isValidObjectId(business)) return ok(await getAdminBillingDetail(business), { headers });
    return ok(await listAdminBilling(billingQuerySchema.parse(Object.fromEntries(params))), { headers });
  });
}
