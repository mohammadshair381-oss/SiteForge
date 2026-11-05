import { HttpError, ok, readJson } from "@/lib/api";
import {
  CUSTOMER_LOGIN_FAILED_MESSAGE,
  assertSameOriginJsonRequest,
  authenticateCustomer,
  currentCustomerCredential,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  requireCustomerAuthBusiness,
  reserveCustomerLoginAttempt,
} from "@/lib/auth/customer-accounts";
import {
  appendCustomerDeviceCookie,
  newCustomerDeviceId,
  readCustomerDeviceCookie,
  signCustomerDevice,
  verifyCustomerDevice,
} from "@/lib/auth/customer-device";
import { appendCustomerSessionCookie, signCustomerSession } from "@/lib/auth/customer-session";
import { customerLoginSchema } from "@/lib/validation";
import { recordSecurityEvent } from "@/lib/security-events";

/**
 * Storefront customer login. Issues ONLY customer cookies (session + known
 * device marker); it never creates, reads or accepts a platform session. Only
 * failed attempts count against the failure budgets; a known device of this
 * account uses its own budget (see reserveCustomerLoginAttempt). A marker
 * counts only while it matches the account's current password, and it never
 * replaces the password check below.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const business = await requireCustomerAuthBusiness(request);
    const businessId = String(business._id);
    await enforceCustomerIpRateLimit(request, businessId, "login");
    const body = customerLoginSchema.parse(await readJson(request));
    const device = await verifyCustomerDevice(readCustomerDeviceCookie(request), {
      businessId,
      email: body.email,
      currentCredential: () => currentCustomerCredential(business, body.email),
    });
    const attempt = await reserveCustomerLoginAttempt(request, businessId, body.email, device?.deviceId);

    const result = await authenticateCustomer(business, body);
    if (!result.ok) {
      if (result.reason === "unverified") {
        // The password was correct: not a failed guess.
        await attempt.release();
        throw new HttpError(
          403,
          "Please confirm your email address first. We can send you a new link.",
          "customer_email_unverified",
        );
      }
      // Recorded for every failed guess alike (no account lookup is added, so
      // the response timing still does not depend on whether the account
      // exists). Volume is bounded by the failure budgets reserved above.
      await recordSecurityEvent({
        type: "customer_login_failed",
        scope: "storefront",
        businessId: business._id,
        email: body.email,
        request,
      });
      throw new HttpError(401, CUSTOMER_LOGIN_FAILED_MESSAGE, "invalid_credentials");
    }
    await attempt.release();

    const token = await signCustomerSession({
      customerId: result.customer.id,
      businessId,
      tokenVersion: result.customer.tokenVersion,
    });
    // Refresh (or create) this browser's known-device marker for this account,
    // bound to the password that was just verified.
    const deviceToken = await signCustomerDevice({
      deviceId: device?.deviceId ?? newCustomerDeviceId(),
      businessId,
      email: body.email,
      credential: result.customer.credential,
    });
    const response = ok({ customer: { name: result.customer.name, emailVerified: true } });
    appendCustomerDeviceCookie(response, deviceToken);
    return appendCustomerSessionCookie(response, token);
  });
}
