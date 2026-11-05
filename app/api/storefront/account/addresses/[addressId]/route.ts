import { HttpError, ok, readJson } from "@/lib/api";
import { assertSameOriginJsonRequest, enforceCustomerIpRateLimit, handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { customerAddressInputSchema, deleteCustomerAddress, setDefaultCustomerAddress, updateCustomerAddress } from "@/lib/customer-addresses";

interface RouteContext {
  params: Promise<{ addressId: string }>;
}

async function addressIdOf(context: RouteContext): Promise<string> {
  const { addressId } = await context.params;
  if (!/^[a-f0-9]{24}$/i.test(addressId)) throw new HttpError(404, "That address was not found", "not_found");
  return addressId;
}

/** `PATCH`: `{ action: "set_default" }`, or the full address to replace it. Only the customer's own. */
export async function PATCH(request: Request, context: RouteContext) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    await enforceCustomerIpRateLimit(request, String(business._id), "profileUpdate");
    const addressId = await addressIdOf(context);
    const raw = (await readJson(request)) as { action?: unknown };
    if (raw?.action === "set_default") {
      return ok({ addresses: await setDefaultCustomerAddress(business._id, customer.id, addressId), message: "Default address updated." });
    }
    return ok({ addresses: await updateCustomerAddress(business._id, customer.id, addressId, customerAddressInputSchema.parse(raw)), message: "Address saved." });
  });
}

/** `DELETE`: removes it. Past orders keep their own copy of the address. */
export async function DELETE(request: Request, context: RouteContext) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    await enforceCustomerIpRateLimit(request, String(business._id), "profileUpdate");
    const addressId = await addressIdOf(context);
    return ok({ addresses: await deleteCustomerAddress(business._id, customer.id, addressId), message: "Address deleted." });
  });
}
