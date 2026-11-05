import { ok, readJson } from "@/lib/api";
import {
  CUSTOMER_AUTH_GENERIC_MESSAGE,
  assertSameOriginJsonRequest,
  enforceCustomerEmailIpRateLimit,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  registerCustomer,
  requireCustomerAuthBusiness,
} from "@/lib/auth/customer-accounts";
import { customerRegisterSchema } from "@/lib/validation";

/**
 * Storefront customer registration. Always 202 with the same message, whether
 * or not the email already has an account at this store; account-dependent
 * work happens after the response.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "register");
    const body = customerRegisterSchema.parse(await readJson(request));
    await enforceCustomerEmailIpRateLimit(request, businessId, "register", body.email);

    await registerCustomer(business, body);
    return ok({ message: CUSTOMER_AUTH_GENERIC_MESSAGE }, { status: 202 });
  });
}
