import { handle, ok, created, HttpError, readJson } from "@/lib/api";
import { isValidObjectId } from "@/lib/ids";
import { resolveCommerceBusiness } from "@/lib/tenant";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceOrderReadRateLimit, enforceReviewSubmitRateLimit } from "@/lib/storefront-rate-limit";
import { orderProofMatchesAny, readOrderProofCandidates } from "@/lib/orders/ownership";
import { reviewableItems, submitReview } from "@/lib/reviews";
import { Order } from "@/models/Order";

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

function notFound(): HttpError {
  // Same response for unknown orders, bad proofs and other tenants' orders.
  return new HttpError(404, "Order not found", "not_found");
}

/**
 * The shopper's order, proven with the order proof (header or HttpOnly
 * order-access cookie) and scoped to the Host-resolved business.
 */
async function ownedOrder(request: Request, orderId: string, limit: "read" | "submit") {
  const business = await resolveCommerceBusiness(request.headers.get("host"));
  if (!business) throw notFound();
  const businessId = String(business._id);
  if (limit === "read") await enforceOrderReadRateLimit(request, businessId);
  else await enforceReviewSubmitRateLimit(request, businessId);
  if (!isValidObjectId(orderId)) throw notFound();
  const proofs = readOrderProofCandidates(request);
  if (proofs.length === 0) throw notFound();
  const order = await Order.findOne({ _id: orderId, business: business._id })
    .select("+orderProofHash business status customerName items")
    .lean();
  if (!order || !orderProofMatchesAny(proofs, order.orderProofHash)) throw notFound();
  return order;
}

/** `GET` — products of this paid order the shopper may review (and their review state). */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { orderId } = await context.params;
    const order = await ownedOrder(request, orderId, "read");
    return ok({ items: await reviewableItems(order as never) }, { headers: { "Cache-Control": "no-store" } });
  });
}

/** `POST { productId, rating, title?, body? }` — verified-purchase review (pending moderation). */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { orderId } = await context.params;
    const order = await ownedOrder(request, orderId, "submit");
    return created({ review: await submitReview(order as never, await readJson(request)) });
  });
}
