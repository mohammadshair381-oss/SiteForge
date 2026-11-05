import { ok, readJson } from "@/lib/api";
import {
  CUSTOMER_AUTH_GENERIC_MESSAGE,
  assertSameOriginJsonRequest,
  enforceCustomerEmailIpRateLimit,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  requestCustomerPasswordReset,
  requireCustomerAuthBusiness,
} from "@/lib/auth/customer-accounts";
import { customerEmailOnlySchema } from "@/lib/validation";
import { recordSecurityEvent } from "@/lib/security-events";

/** Sends a password reset link (after the response). Always the same 202. */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "emailRequest");
    const body = customerEmailOnlySchema.parse(await readJson(request));
    await enforceCustomerEmailIpRateLimit(request, businessId, "forgot", body.email);

    // Recorded for every request alike (email digest only, no account lookup).
    await recordSecurityEvent({
      type: "password_reset_requested",
      scope: "storefront",
      businessId: business._id,
      email: body.email,
      request,
    });
    requestCustomerPasswordReset(business, body.email);
    return ok({ message: CUSTOMER_AUTH_GENERIC_MESSAGE }, { status: 202 });
  });
}
