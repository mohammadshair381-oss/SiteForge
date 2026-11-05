import { ok } from "@/lib/api";
import { assertSameOriginJsonRequest, handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { getCustomer, revokeCustomerSessions } from "@/lib/auth/customer-guards";
import { clearCustomerSessionCookie } from "@/lib/auth/customer-session";

/**
 * Storefront customer logout. A valid session is revoked server-side (token
 * version bump, so a copied cookie stops working too); the cookie is always
 * cleared. Never touches the platform session.
 */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const context = await getCustomer(request);
    if (context) await revokeCustomerSessions(context.customer.businessId, context.customer.id);
    return clearCustomerSessionCookie(ok({ ok: true }));
  });
}
