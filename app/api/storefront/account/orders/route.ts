import { ok } from "@/lib/api";
import { handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { listCustomerOrders } from "@/lib/orders/customer-orders";

/**
 * `GET /api/storefront/account/orders`: the signed-in customer's orders at this
 * store (newest first, at most 50). Business from the Host and customer from
 * the session only (`requireCustomer`); 404 while customer accounts are off,
 * 401 when signed out. Guest orders are not listed: they stay reachable through
 * their own order-access proof.
 */
export async function GET(request: Request) {
  return handleCustomerAuthRoute(async () => {
    const { business, customer } = await requireCustomer(request);
    return ok({ orders: await listCustomerOrders(business._id, customer.id) });
  });
}
