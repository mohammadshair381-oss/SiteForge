import { ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest, enforceCustomerIpRateLimit, handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { addCustomerAddress, customerAddressInputSchema, listCustomerAddresses } from "@/lib/customer-addresses";

/** `GET /api/storefront/account/addresses`: the signed-in customer's own saved addresses. */
export async function GET(request: Request) {
  return handleCustomerAuthRoute(async () => {
    const { business, customer } = await requireCustomer(request);
    return ok({ addresses: await listCustomerAddresses(business._id, customer.id) }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** `POST /api/storefront/account/addresses`: adds one. Same-origin JSON only. */
export async function POST(request: Request) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    await enforceCustomerIpRateLimit(request, String(business._id), "profileUpdate");
    const body = customerAddressInputSchema.parse(await readJson(request));
    return ok({ addresses: await addCustomerAddress(business._id, customer.id, body), message: "Address saved." });
  });
}
