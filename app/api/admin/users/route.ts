import { handle, ok } from "@/lib/api";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { listAdminUsers, userQuerySchema } from "@/lib/admin/control-center";

/**
 * `GET /api/admin/users?q=&role=user|super_admin&state=active|inactive|unverified&page=`
 * (super admin only, read-only). Returns an allowlisted view: never password
 * hashes, token versions or sessions.
 */
export async function GET(request: Request) {
  return handle(async () => {
    await requireSuperAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return ok(await listAdminUsers(userQuerySchema.parse(params)), { headers: { "Cache-Control": "no-store" } });
  });
}
