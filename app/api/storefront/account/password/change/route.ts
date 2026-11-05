import { HttpError, ok, readJson } from "@/lib/api";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  CUSTOMER_RATE_LIMITS,
  assertSameOriginJsonRequest,
  changeCustomerPassword,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
} from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { appendCustomerDeviceCookie, newCustomerDeviceId, signCustomerDevice } from "@/lib/auth/customer-device";
import { appendCustomerSessionCookie, signCustomerSession } from "@/lib/auth/customer-session";
import { recordSecurityEvent } from "@/lib/security-events";
import { customerChangePasswordSchema } from "@/lib/validation";

/**
 * `POST /api/storefront/account/password/change`: a signed-in customer changes
 * their password by proving the current one. Every existing session and
 * known-device marker of the account stops working; this browser alone is
 * signed in again with a new session bound to the new password.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "passwordChange");
    await enforceRateLimit({
      key: `customer-auth:passwordChange:account:${businessId}:${customer.id}`,
      ...CUSTOMER_RATE_LIMITS.passwordChange.perAccount,
    });
    const body = customerChangePasswordSchema.parse(await readJson(request));

    const result = await changeCustomerPassword(business, customer.id, body.currentPassword, body.newPassword);
    if (!result.ok) {
      if (result.reason === "same_password") {
        throw new HttpError(400, "Choose a password you are not already using.", "same_password");
      }
      await recordSecurityEvent({
        type: "password_change_failed",
        reason: "wrong_password",
        scope: "storefront",
        businessId: business._id,
        customerId: customer.id,
        request,
      });
      throw new HttpError(400, "Your current password is not correct.", "invalid_password");
    }

    const token = await signCustomerSession({ customerId: customer.id, businessId, tokenVersion: result.tokenVersion });
    const deviceToken = await signCustomerDevice({
      deviceId: newCustomerDeviceId(),
      businessId,
      email: result.email,
      credential: result.credential,
    });
    const response = ok({ message: "Your password has been changed. Other devices have been signed out." });
    appendCustomerDeviceCookie(response, deviceToken);
    return appendCustomerSessionCookie(response, token);
  });
}
