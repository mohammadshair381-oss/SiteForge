import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { releaseExpiredOrdersOnDemand } from "@/lib/orders/lifecycle";
import {
  CUSTOMER_PAGE_SIZE_DEFAULT,
  CUSTOMER_PAGE_SIZE_MAX,
  CUSTOMER_SEARCH_MAX,
  listBusinessCustomers,
} from "@/lib/customers";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Control characters (e.g. NUL) are never part of a name or email. */
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/;

const querySchema = z.object({
  q: z
    .string()
    .trim()
    .max(CUSTOMER_SEARCH_MAX)
    .regex(NO_CONTROL_CHARS, "Search text contains invalid characters")
    .optional(),
  page: z.coerce.number().int().min(1).max(1000).prefault(1),
  limit: z.coerce.number().int().min(1).max(CUSTOMER_PAGE_SIZE_MAX).prefault(CUSTOMER_PAGE_SIZE_DEFAULT),
});

/**
 * `GET /api/businesses/[id]/manage/customers?q=&page=&limit=`
 *
 * Customers derived from this business's orders (see lib/customers.ts for the
 * identity and totals rules). Same access policy as order management: owners
 * and managers only; staff are excluded because this is customer PII. The
 * tenant comes from the membership check on the route id and every query is
 * scoped to it.
 */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);

    const params = new URL(request.url).searchParams;
    const query = querySchema.parse({
      q: params.get("q") ?? undefined,
      page: params.get("page") ?? undefined,
      limit: params.get("limit") ?? undefined,
    });

    await dbConnect();
    // Same as the Orders list: release expired reservations first so
    // "awaiting payment" totals do not include orders that already lapsed.
    await releaseExpiredOrdersOnDemand(id);
    const result = await listBusinessCustomers(id, {
      page: query.page,
      limit: query.limit,
      search: query.q,
    });

    return ok(result, { headers: { "Cache-Control": "no-store" } });
  });
}
