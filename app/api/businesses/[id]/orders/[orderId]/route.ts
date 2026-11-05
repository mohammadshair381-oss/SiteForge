import { handle, ok, HttpError } from "@/lib/api";
import { isValidObjectId } from "@/lib/ids";
import { resolveBusinessByHost } from "@/lib/tenant";
import { enforceOrderReadRateLimit } from "@/lib/storefront-rate-limit";
import {
  orderProofMatchesAny,
  readOrderProofCandidates,
} from "@/lib/orders/ownership";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

function orderNotFound(): HttpError {
  // Deliberately identical for missing orders, bad proofs, malformed ids and
  // orders owned by another tenant. The caller must not learn which case hit.
  return new HttpError(404, "Order not found", "not_found");
}

/**
 * Read-only guest order status.
 *
 * Tenant identity comes exclusively from the trusted Host header, never from
 * the URL [id]. A request must prove guest ownership with x-order-proof or the
 * HttpOnly order-access cookie; the order number, order id, cart-token and
 * query parameters are never accepted as authority. This handler never runs an
 * expiry sweep and never mutates inventory.
 */
export async function GET(request: Request, context: RouteContext) {
  const response = await handle(async () => {
    // The [id] route parameter is intentionally ignored for tenant identity.
    const { orderId } = await context.params;

    const business = await resolveBusinessByHost(request.headers.get("host"));
    if (!business) {
      throw orderNotFound();
    }
    const businessId = business._id.toString();

    // Throttle before the order lookup. The bucket is scoped to the
    // host-resolved business and the trusted client IP.
    await enforceOrderReadRateLimit(request, businessId);

    if (!isValidObjectId(orderId)) {
      throw orderNotFound();
    }

    const proofs = readOrderProofCandidates(request);
    if (proofs.length === 0) {
      throw orderNotFound();
    }

    const order = await Order.findOne({
      _id: orderId,
      business: businessId,
    })
      .select("+orderProofHash")
      .lean();

    if (!order || !orderProofMatchesAny(proofs, order.orderProofHash)) {
      throw orderNotFound();
    }

    // No cancellation endpoint exists in this phase. This flag mirrors the
    // lifecycle service's safe precondition without performing any mutation.
    // Mirrors the lifecycle precondition (a shipped order cannot be cancelled
    // by the shopper).
    const canCancel =
      order.status === "pending" &&
      order.inventoryState === "reserved" &&
      order.fulfillmentStatus !== "shipped" &&
      order.fulfillmentStatus !== "delivered";

    return ok(
      {
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        status: order.status,
        currency: order.currency ?? order.items?.[0]?.currency ?? "USD",
        items: (order.items ?? []).map((item) => ({
          product: item.product,
          productName: item.productName,
          variantLabel: item.variantLabel ?? "",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          currency: item.currency,
          ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
        })),
        subtotal: order.subtotal,
        total: order.total,
        customerName: order.customerName,
        createdAt: order.createdAt,
        paidAt: order.paidAt ?? null,
        cancelledAt: order.cancelledAt ?? null,
        refundedAt: order.refundedAt ?? null,
        cancelReason: order.cancelReason ?? null,
        reservationExpiresAt: order.reservationExpiresAt ?? null,
        paymentMethod: order.paymentMethod === "cod" || order.paymentMethod === "online" ? order.paymentMethod : null,
        canCancel,
        // Who it is for, so a confirmation reads naturally. The address stays off this page.
        placedAsGuest: !order.customer,
        // Price breakdown (server-computed at checkout).
        discountCode: order.discount?.code ?? null,
        discountTotal: Number(order.discountTotal ?? 0),
        shippingTotal: typeof order.shippingTotal === "number" ? order.shippingTotal : null,
        taxTotal: Number(order.taxTotal ?? 0),
        taxLabel: order.taxLabel ?? "",
        taxInclusive: Boolean(order.taxInclusive),
        refundedTotal: order.status === "refunded" ? order.total : Number(order.refundedTotal ?? 0),
        // A declined attempt, so the shopper knows to try again. Never paid status.
        paymentAttemptFailed:
          order.status === "pending" && order.paymentMethod === "online"
            ? Boolean(await OrderPayment.exists({ business: businessId, order: order._id, status: "created", lastFailureAt: { $ne: null } }))
            : false,
        // Fulfilment and the business's own tracking reference (no carrier
        // integration). The delivery address is not echoed back.
        fulfillmentStatus: order.fulfillmentStatus ?? "unfulfilled",
        tracking: order.trackingNumber || order.trackingUrl
          ? { carrier: order.trackingCarrier ?? "", number: order.trackingNumber ?? "", url: order.trackingUrl ?? "" }
          : null,
        shippedAt: order.shippedAt ?? null,
        deliveredAt: order.deliveredAt ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });

  // `handle` may return rate-limit or validation errors; make every response
  // non-cacheable, including failures.
  response.headers.set("Cache-Control", "no-store");
  return response;
}
