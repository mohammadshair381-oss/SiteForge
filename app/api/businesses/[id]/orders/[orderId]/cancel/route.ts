import { isProduction } from "@/lib/env";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { isValidObjectId } from "@/lib/ids";
import { resolveBusinessByHost } from "@/lib/tenant";
import { enforceOrderCancelRateLimit } from "@/lib/storefront-rate-limit";
import {
  orderProofMatchesAny,
  readOrderProofCandidates,
  readOrderAccessCookie,
} from "@/lib/orders/ownership";
import { cancelOrder } from "@/lib/orders/lifecycle";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder } from "@/lib/notification-events";
import { closeOpenPaymentLinks } from "@/lib/payments/order-payments";
import type { OrderCancelReason } from "@/models/Order";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

interface CancelRequestBody {
  reason?: unknown;
}

/**
 * Guest cancellations are always recorded as "customer". The `admin` and
 * `payment_failed` reasons are reserved for trusted server-side callers, so a
 * client-supplied `reason` is ignored rather than trusted (it previously let a
 * guest forge the audit field).
 */
function normalizeCancelReason(_value: unknown): "customer" {
  return "customer";
}

/**
 * Verifies that a cookie-authenticated state-changing request originates from
 * the same host that set the cookie. The order-access cookie is host-only
 * (no Domain attribute) and SameSite=Lax, so a cross-site POST from a
 * different origin must not be honored. We check the Origin header (preferred)
 * or the Referer header against the trusted Host.
 */
function assertSameOrigin(request: Request, trustedHost: string | null): void {
  if (!trustedHost) {
    throw new HttpError(403, "Request origin verification failed", "csrf_failed");
  }
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  // Plain-http origins are accepted only outside production (local dev serves
  // storefronts over http); production requires https.
  const allowedOrigins = isProduction()
    ? [`https://${trustedHost}`]
    : [`https://${trustedHost}`, `http://${trustedHost}`];

  if (origin) {
    if (!allowedOrigins.includes(origin)) {
      throw new HttpError(403, "Request origin verification failed", "csrf_failed");
    }
    return;
  }
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (!allowedOrigins.includes(refererUrl.origin)) {
        throw new HttpError(403, "Request origin verification failed", "csrf_failed");
      }
      return;
    } catch {
      throw new HttpError(403, "Request origin verification failed", "csrf_failed");
    }
  }
  // No Origin or Referer — treat as suspicious for a state-changing request.
  throw new HttpError(403, "Request origin verification failed", "csrf_failed");
}

function orderNotFound(): HttpError {
  // Deliberately identical for missing orders, bad proofs, malformed ids and
  // orders owned by another tenant. The caller must not learn which case hit.
  return new HttpError(404, "Order not found", "not_found");
}

/**
 * Guest order cancellation.
 *
 * Tenant identity comes exclusively from the trusted Host header, never from
 * the URL [id]. A request must prove guest ownership with x-order-proof or the
 * HttpOnly order-access cookie; the order number, order id, cart-token and
 * query parameters are never accepted as authority.
 *
 * Cookie-authenticated requests are additionally protected by a same-origin
 * check (Origin/Referer vs. Host) because the order-access cookie is
 * SameSite=Lax and host-only.
 *
 * Only pending orders with inventoryState "reserved" may be cancelled. The
 * actual transition and stock restoration are performed atomically by the
 * cancelOrder lifecycle service. Repeated cancellations are safe: the
 * conditional update ensures stock is restored exactly once.
 */
export async function POST(request: Request, context: RouteContext) {
  const response = await handle(async () => {
    // The [id] route parameter is intentionally ignored for tenant identity.
    const { orderId } = await context.params;

    const hostHeader = request.headers.get("host");
    const business = await resolveBusinessByHost(hostHeader);
    if (!business) {
      throw orderNotFound();
    }
    const businessId = business._id.toString();

    // Throttle before any order lookup or mutation. The bucket is scoped to
    // the host-resolved business and the trusted client IP.
    await enforceOrderCancelRateLimit(request, businessId);

    if (!isValidObjectId(orderId)) {
      throw orderNotFound();
    }

    // Read and validate the request body (cancellation reason).
    let body: CancelRequestBody;
    try {
      body = (await readJson(request)) as CancelRequestBody;
    } catch {
      throw new HttpError(400, "Invalid request payload", "invalid_payload");
    }
    const reason = normalizeCancelReason(body?.reason);

    // Proof is required via x-order-proof header or order-access cookie.
    const proofs = readOrderProofCandidates(request);
    if (proofs.length === 0) {
      throw orderNotFound();
    }

    // If the request carries the order-access cookie, enforce same-origin
    // protection for this state-changing operation. The order-access cookie
    // is host-only and SameSite=Lax, but an attacker could still trigger a
    // cross-site POST from a form submission; the Origin/Referer check
    // closes that gap.
    const cookieProof = readOrderAccessCookie(request);
    if (cookieProof) {
      assertSameOrigin(request, hostHeader);
    }

    // Verify proof and fetch the order.
    const order = await Order.findOne({
      _id: orderId,
      business: businessId,
    })
      .select("+orderProofHash")
      .lean();

    if (!order || !orderProofMatchesAny(proofs, order.orderProofHash)) {
      throw orderNotFound();
    }

    // Delegate to the lifecycle service. It performs the conditional
    // transition and inventory restoration in a single transaction.
    const result = await cancelOrder({
      orderId,
      businessId,
      reason,
    });

    // The lifecycle service returns a structured result; map it to an HTTP
    // response without leaking internal state or reasons beyond what the
    // guest needs to know.
    if (result.applied) {
      await closeOpenPaymentLinks(businessId, orderId);
      queueOrderEmail("cancelled", businessId, orderId);
      notifyOrder("cancelled", businessId, orderId);
      return ok({
        orderId: String(result.order!._id),
        orderNumber: result.order!.orderNumber,
        status: "cancelled",
        cancelReason: reason,
        cancelledAt: result.order!.cancelledAt,
      });
    }

    // Map lifecycle reasons to generic guest-facing errors.
    switch (result.reason) {
      case "not_found":
        throw orderNotFound();
      case "already_cancelled":
        // Idempotent: returning the current cancelled state is safe and
        // does not reveal whether another guest's order existed.
        return ok({
          orderId: String(result.order!._id),
          orderNumber: result.order!.orderNumber,
          status: "cancelled",
          cancelReason: result.order!.cancelReason,
          cancelledAt: result.order!.cancelledAt,
        });
      case "not_pending":
      case "legacy_order":
      case "expired":
      case "already_paid":
      case "already_refunded":
      case "not_paid":
      default:
        // Guest cannot distinguish these from a missing order.
        throw orderNotFound();
    }
  });

  // Ensure all responses are non-cacheable.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// Import Order model here to avoid circular dependency with lifecycle.ts
import { Order } from "@/models/Order";