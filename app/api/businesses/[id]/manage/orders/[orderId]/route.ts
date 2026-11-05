import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { isValidObjectId } from "@/lib/ids";
import { cancelOrder, confirmCodPayment } from "@/lib/orders/lifecycle";
import {
  ORDER_MANAGEMENT_ACTIONS,
  toManagedOrderView,
  transitionRefusalMessage,
} from "@/lib/orders/management";
import { loadManagedOrderDetail } from "@/lib/orders/management-detail";
import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder } from "@/lib/notification-events";
import { closeOpenPaymentLinks } from "@/lib/payments/order-payments";
import { createOrderRefund } from "@/lib/payments/order-refunds";
import { Order } from "@/models/Order";

interface RouteContext {
  params: Promise<{ id: string; orderId: string }>;
}

const actionSchema = z.object({ action: z.enum(ORDER_MANAGEMENT_ACTIONS) });

/** `GET` — one order with its payment history and refunds. Owners and managers. */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, orderId } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    if (!isValidObjectId(orderId)) throw new HttpError(404, "Order not found", "not_found");
    return ok(await loadManagedOrderDetail(id, orderId), { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * `PATCH /api/businesses/[id]/manage/orders/[orderId]` `{ action }`
 *
 * Owner/manager order transitions, delegated to the audited lifecycle helpers
 * (each a conditional, transactional update scoped to this business):
 * - `mark_paid`: confirm a CASH-ON-DELIVERY payment (`confirmCodPayment`).
 *   Allowed only for orders with `paymentMethod: "cod"`; online orders (paid
 *   only via server-side provider verification) and legacy orders without a
 *   payment method are refused with 409 `manual_payment_not_allowed` and are
 *   left unchanged. Also requires a live (or non-expiring COD) reservation.
 * - `cancel`: cancel an unpaid order and restore its stock (reason `admin`).
 * - `refund`: records that everything not yet refunded was returned another way.
 *   No money moves and stock is not restored. It goes through the refund service,
 *   so it leaves a record and the same rules apply as for every other refund.
 */
export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id, orderId } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    // Same 404 for malformed ids and orders of other tenants.
    if (!isValidObjectId(orderId)) {
      throw new HttpError(404, "Order not found", "not_found");
    }
    const { action } = actionSchema.parse(await readJson(request));

    const scope = { orderId, businessId: id };
    if (action === "refund") {
      // The refund service sends the shopper's email when it settles.
      await createOrderRefund({ ...scope, method: "manual", actorId: user._id });
    } else {
      const result =
        action === "mark_paid"
          ? // COD only. Online orders are never marked paid by a business user.
            await confirmCodPayment(scope)
          : await cancelOrder({ ...scope, reason: "admin" });

      if (!result.applied) {
        if (result.reason === "not_found") {
          throw new HttpError(404, "Order not found", "not_found");
        }
        throw new HttpError(409, transitionRefusalMessage(result.reason), result.reason ?? "conflict");
      }

      if (action === "cancel") await closeOpenPaymentLinks(id, orderId);
      queueOrderEmail(action === "mark_paid" ? "paid" : "cancelled", id, orderId);
      notifyOrder(action === "mark_paid" ? "paid" : "cancelled", id, orderId);
    }

    const order = await Order.findOne({ _id: orderId, business: id })
      .select("-ownerToken -idempotencyKey -orderProofHash")
      .lean();
    if (!order) throw new HttpError(404, "Order not found", "not_found");
    return ok({ order: toManagedOrderView(order) });
  });
}
