import { ok } from "@/lib/api";
import { handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { getCustomer } from "@/lib/auth/customer-guards";

/** The signed-in customer of THIS storefront (safe fields only), or null. */
export async function GET(request: Request) {
  return handleCustomerAuthRoute(async () => {
    const context = await getCustomer(request);
    const customer = context
      ? { name: context.customer.name, email: context.customer.email, emailVerified: context.customer.emailVerified }
      : null;
    return ok({ customer });
  });
}
