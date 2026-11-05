import { HttpError, ok, readJson } from "@/lib/api";
import {
  assertSameOriginJsonRequest,
  enforceCustomerIpRateLimit,
  handleCustomerAuthRoute,
  readCustomerProfile,
  updateCustomerProfile,
} from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { customerProfileSchema } from "@/lib/validation";

const signedOut = () => new HttpError(401, "Please sign in to continue", "customer_unauthenticated");

/** `GET /api/storefront/account/profile`: the signed-in customer's own details. */
export async function GET(request: Request) {
  return handleCustomerAuthRoute(async () => {
    const { business, customer } = await requireCustomer(request);
    const profile = await readCustomerProfile(business._id, customer.id);
    if (!profile) throw signedOut();
    return ok({ profile });
  });
}

/**
 * `PATCH /api/storefront/account/profile`: updates the signed-in customer's
 * name and phone. Same-origin JSON only; the email and verification state are
 * never read from the request.
 */
export async function PATCH(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    await enforceCustomerIpRateLimit(request, String(business._id), "profileUpdate");
    const body = customerProfileSchema.parse(await readJson(request));
    const profile = await updateCustomerProfile(business._id, customer.id, body);
    if (!profile) throw signedOut();
    return ok({ profile, message: "Your details have been saved." });
  });
}
