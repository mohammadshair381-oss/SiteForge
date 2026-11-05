import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { isValidObjectId } from "@/lib/ids";
import { updateFulfillment } from "@/lib/orders/fulfillment";
import { toManagedOrderView } from "@/lib/orders/management";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

/**
 * `POST { status, trackingCarrier?, trackingNumber?, trackingUrl? }` —
 * owner/manager fulfilment update (forward only; see lib/orders/fulfillment.ts).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id, orderId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    const order = await updateFulfillment({ orderId, businessId: id, body: await readJson(request) });
    return ok({ order: toManagedOrderView(order) });
  });
}
