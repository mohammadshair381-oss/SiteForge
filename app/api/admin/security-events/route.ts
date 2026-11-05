import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getSecuritySummary, listSecurityEvents, securityQuerySchema } from "@/lib/admin/security";

/**
 * `GET /api/admin/security-events?type=&reason=&user=&from=&to=&page=`
 * (super admin only, read-only): a summary plus a page of events. Events hold
 * no passwords, raw emails of unknown accounts or raw client addresses.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const [summary, list] = await Promise.all([getSecuritySummary(), listSecurityEvents(securityQuerySchema.parse(params))]);
    return ok({ summary, ...list }, { headers: { "Cache-Control": "no-store" } });
  });
}
