import { handle, ok, HttpError } from "@/lib/api";
import { isValidObjectId } from "@/lib/ids";
import { resolveCommerceBusiness } from "@/lib/tenant";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceOrderPayRateLimit } from "@/lib/storefront-rate-limit";
import { orderProofMatchesAny, readOrderProofCandidates } from "@/lib/orders/ownership";
import { startOrderPayment } from "@/lib/payments/order-payments";
import { Order } from "@/models/Order";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

function orderNotFound(): HttpError {
  return new HttpError(404, "Order not found", "not_found");
}

/**
 * `POST /api/storefront/orders/[orderId]/pay` — returns the Razorpay-hosted
 * payment page URL for a pending online order. The business comes only from
 * the Host; the shopper proves ownership with the order proof (header or the
 * HttpOnly order-access cookie), exactly like the order status endpoint.
 * Starting a payment never changes the order's status.
 */
export async function POST(request: Request, context: RouteContext) {
  const response = await handle(async () => {
    assertSameOriginJsonRequest(request);
    const host = request.headers.get("host");
    const business = await resolveCommerceBusiness(host);
    if (!business || !host) throw orderNotFound();
    const businessId = String(business._id);
    await enforceOrderPayRateLimit(request, businessId);

    const { orderId } = await context.params;
    if (!isValidObjectId(orderId)) throw orderNotFound();
    const proofs = readOrderProofCandidates(request);
    if (proofs.length === 0) throw orderNotFound();
    const order = await Order.findOne({ _id: orderId, business: business._id }).select("+orderProofHash").lean();
    if (!order || !orderProofMatchesAny(proofs, order.orderProofHash)) throw orderNotFound();

    const { url } = await startOrderPayment({ businessId, orderId, host });
    return ok({ url });
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
