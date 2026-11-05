import { HttpError, ok, readJson } from "@/lib/api";
import {
  assertSameOriginJsonRequest,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  requireCustomerAuthBusiness,
  verifyCustomerEmail,
} from "@/lib/auth/customer-accounts";
import { customerVerifyEmailSchema } from "@/lib/validation";
import { recordSecurityEvent } from "@/lib/security-events";

/**
 * Confirms a customer email with a single-use link token AND the account
 * password (pre-hijacking defence). Does not sign the customer in.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    await enforceCustomerIpRateLimit(request, String(business._id), "tokenSubmit");
    const body = customerVerifyEmailSchema.parse(await readJson(request));

    const result = await verifyCustomerEmail(business, body.token, body.password);
    if (result !== "verified") {
      // Never the token or the password: only that a verification was refused, for which store.
      await recordSecurityEvent({
        type: "email_verification_failed",
        reason: result === "invalid_password" ? "wrong_password" : "invalid_token",
        scope: "storefront",
        businessId: business._id,
        request,
      });
    }
    if (result === "invalid_password") {
      throw new HttpError(
        400,
        "That password does not match this account. If you did not choose it, reset your password instead.",
        "invalid_password",
      );
    }
    if (result !== "verified") {
      throw new HttpError(400, "This link is invalid or has expired. Request a new one.", "invalid_token");
    }
    return ok({ message: "Your email address is confirmed. You can now sign in." });
  });
}
