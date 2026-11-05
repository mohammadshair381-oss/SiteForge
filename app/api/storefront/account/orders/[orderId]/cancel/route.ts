import mongoose from "mongoose";
import { HttpError, ok } from "@/lib/api";
import { assertSameOriginJsonRequest, handleCustomerAuthRoute } from "@/lib/auth/customer-accounts";
import { requireCustomer } from "@/lib/auth/customer-guards";
import { cancelOrder } from "@/lib/orders/lifecycle";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder } from "@/lib/notification-events";
import { closeOpenPaymentLinks } from "@/lib/payments/order-payments";
import { enforceOrderCancelRateLimit } from "@/lib/storefront-rate-limit";
import { Order } from "@/models/Order";

type RouteContext = { params: Promise<{ orderId: string }> };

const notFound = () => new HttpError(404, "Order not found", "not_found");

/**
 * `POST /api/storefront/account/orders/[orderId]/cancel`: a signed-in customer
 * cancels one of THEIR OWN unpaid orders at this store (stock is restored once
 * by the shared lifecycle). The order is looked up by business AND customer, so
 * another customer's or another store's order is the same 404 as a missing
 * one. Same-origin JSON only; rate limited like guest cancellation.
 */
export async function POST(request: Request, context: RouteContext) {
  return handleCustomerAuthRoute(async () => {
    assertSameOriginJsonRequest(request);
    const { business, customer } = await requireCustomer(request);
    const businessId = String(business._id);
    await enforceOrderCancelRateLimit(request, businessId);

    const { orderId } = await context.params;
    if (!mongoose.isValidObjectId(orderId)) throw notFound();
    const owned = await Order.exists({
      _id: new mongoose.Types.ObjectId(orderId),
      business: business._id,
      customer: new mongoose.Types.ObjectId(customer.id),
    });
    if (!owned) throw notFound();

    const result = await cancelOrder({ orderId, businessId, reason: "customer" });
    if (result.applied || result.reason === "already_cancelled") {
      if (result.applied) {
        await closeOpenPaymentLinks(businessId, orderId);
        queueOrderEmail("cancelled", businessId, orderId);
        notifyOrder("cancelled", businessId, orderId);
      }
      return ok({ orderId, status: "cancelled" });
    }
    if (result.reason === "not_found") throw notFound();
    throw new HttpError(409, "This order can no longer be cancelled", "not_cancellable");
  });
}
