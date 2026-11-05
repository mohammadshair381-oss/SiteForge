import { HttpError, ok, readJson } from "@/lib/api";
import {
  assertSameOriginJsonRequest,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  requireCustomerAuthBusiness,
  resetCustomerPassword,
} from "@/lib/auth/customer-accounts";
import { appendCustomerDeviceCookie, newCustomerDeviceId, signCustomerDevice } from "@/lib/auth/customer-device";
import { customerResetPasswordSchema } from "@/lib/validation";
import { recordSecurityEvent } from "@/lib/security-events";

/**
 * Sets a new password with a single-use reset token. Every existing session
 * of the account is revoked, and every existing known-device marker becomes
 * outdated (markers are bound to the password); the customer signs in again
 * with the new password. A successful reset proves inbox control, so this
 * browser gets a NEW marker bound to the new password: the owner can sign in
 * from it even while distributed attackers hold the account-wide login lock.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "tokenSubmit");
    const body = customerResetPasswordSchema.parse(await readJson(request));

    const reset = await resetCustomerPassword(business, body.token, body.password);
    if (!reset) {
      // Never the token itself: only that a reset was refused, for which store.
      await recordSecurityEvent({ type: "password_reset_failed", reason: "invalid_token", scope: "storefront", businessId: business._id, request });
      throw new HttpError(400, "This link is invalid or has expired. Request a new one.", "invalid_token");
    }
    await recordSecurityEvent({ type: "password_reset_completed", scope: "storefront", businessId: business._id, customerId: reset.customerId, request });
    const deviceToken = await signCustomerDevice({
      deviceId: newCustomerDeviceId(),
      businessId,
      email: reset.email,
      credential: reset.credential,
    });
    return appendCustomerDeviceCookie(ok({ message: "Your password has been changed. Please sign in." }), deviceToken);
  });
}
