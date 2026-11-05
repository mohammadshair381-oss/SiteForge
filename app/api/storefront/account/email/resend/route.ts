import { ok, readJson } from "@/lib/api";
import {
  CUSTOMER_AUTH_GENERIC_MESSAGE,
  assertSameOriginJsonRequest,
  enforceCustomerEmailIpRateLimit,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  requireCustomerAuthBusiness,
  resendCustomerVerification,
} from "@/lib/auth/customer-accounts";
import { customerEmailOnlySchema } from "@/lib/validation";

/** Resends a verification link (after the response). Always the same 202. */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "emailRequest");
    const body = customerEmailOnlySchema.parse(await readJson(request));
    await enforceCustomerEmailIpRateLimit(request, businessId, "resend", body.email);

    resendCustomerVerification(business, body.email);
    return ok({ message: CUSTOMER_AUTH_GENERIC_MESSAGE }, { status: 202 });
  });
}
