import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getBusinessCustomer } from "@/lib/customers";
import { releaseExpiredOrdersOnDemand } from "@/lib/orders/lifecycle";

interface RouteContext {
  params: Promise<{ id: string; customerId: string }>;
}

/**
 * `GET /api/businesses/[id]/manage/customers/[customerId]`
 *
 * One customer and their order history in THIS business. Owners and managers
 * only. Malformed ids, unknown ids, orders without a usable email and ids that
 * belong to another business all return the same 404, so nothing reveals
 * whether another tenant's customer or order exists.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, customerId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    await releaseExpiredOrdersOnDemand(id);

    const result = await getBusinessCustomer(id, customerId);
    if (!result) throw new HttpError(404, "Customer not found", "not_found");

    return ok(result, { headers: { "Cache-Control": "no-store" } });
  });
}
