import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listAdminPayments, paymentQuerySchema } from "@/lib/admin/control-center";

/**
 * `GET /api/admin/payments?domain=subscription|order&status=&review=1&business=&page=`
 * (super admin only, READ-ONLY). There is deliberately no write method: payment
 * state changes only through provider-verified flows, never by an admin.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return ok(await listAdminPayments(paymentQuerySchema.parse(params)), { headers: { "Cache-Control": "no-store" } });
  });
}
