import { HttpError, ok } from "@/lib/api";
import { handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { getCustomerOrder } from "@/lib/orders/customer-orders";

type RouteContext = { params: Promise<{ orderId: string }> };

/**
 * `GET /api/storefront/account/orders/[orderId]`: one of the signed-in
 * customer's orders at this store. Business from the Host and customer from the
 * session only; another customer's or another store's order is the same 404 as
 * a missing one.
 */
export async function GET(request: Request, context: RouteContext) {
  return handleCustomerAuthRoute(async () => {
    const { business, customer } = await requireCustomer(request);
    const { orderId } = await context.params;
    const order = await getCustomerOrder(business._id, customer.id, orderId);
    if (!order) throw new HttpError(404, "Order not found", "not_found");
    return ok({ order });
  });
}
