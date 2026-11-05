import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { getPlatformOverview, parseDateRange } from "@/lib/admin/control-center";

/**
 * `GET /api/admin/overview?from=YYYY-MM-DD&to=YYYY-MM-DD` (super admin only,
 * read-only). Platform totals, per-currency payment summaries split by how
 * they were verified, daily series and operational alerts.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = new URL(request.url).searchParams;
    const overview = await getPlatformOverview(parseDateRange(params.get("from"), params.get("to")));
    return ok(overview, { headers: { "Cache-Control": "no-store" } });
  });
}
