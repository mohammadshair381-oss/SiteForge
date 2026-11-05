import { queueOrderEmail } from "@/lib/orders/notifications";
import { notifyOrder } from "@/lib/notification-events";
import { z } from "zod";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { assertObjectId } from "@/lib/ids";
import { Order, ORDER_FULFILLMENT_STATUSES, type OrderFulfillmentStatus } from "@/models/Order";

/**
 * Order fulfilment (separate from payment). Owners/managers move an order
 * forward only: unfulfilled -> processing -> shipped -> delivered, and may
 * correct tracking details at the current step. Allowed for PAID orders and
 * for open cash-on-delivery orders (COD is paid on delivery). Tracking is the
 * business's own carrier reference; SiteForge has no carrier integration.
 */

const RANK: Record<OrderFulfillmentStatus, number> = { unfulfilled: 0, processing: 1, shipped: 2, delivered: 3 };

const plain = (max: number) => z.string().trim().max(max).refine((v) => !/[<>\u0000-\u001f]/.test(v), "Use plain text");

export const fulfillmentSchema = z.object({
  status: z.enum(ORDER_FULFILLMENT_STATUSES),
  // Left out = keep what is saved; an empty value clears it.
  trackingCarrier: plain(80).optional(),
  trackingNumber: plain(120).optional(),
  trackingUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => {
      if (!v) return true;
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    }, "Use an https tracking link")
    .optional(),
});

export async function updateFulfillment(input: { orderId: string; businessId: string; body: unknown; now?: Date }) {
  const data = fulfillmentSchema.parse(input.body);
  const now = input.now ?? new Date();
  await dbConnect();
  const scope = { _id: assertObjectId(input.orderId, "order id"), business: input.businessId };
  const order = await Order.findOne(scope).select("status paymentMethod inventoryState fulfillmentStatus trackingCarrier trackingNumber reservationExpiresAt").lean();
  if (!order) throw new HttpError(404, "Order not found", "not_found");

  const eligible = order.status === "paid" || (order.status === "pending" && order.paymentMethod === "cod" && order.inventoryState === "reserved");
  if (!eligible) {
    throw new HttpError(409, "Only paid orders (or open cash-on-delivery orders) can be fulfilled", "not_fulfillable");
  }
  const current: OrderFulfillmentStatus = order.fulfillmentStatus ?? "unfulfilled";
  if (RANK[data.status] < RANK[current]) {
    throw new HttpError(409, "Fulfilment can only move forward", "fulfillment_backwards");
  }

  const set: Record<string, unknown> = {
    fulfillmentStatus: data.status,
    ...(data.trackingCarrier !== undefined ? { trackingCarrier: data.trackingCarrier } : {}),
    ...(data.trackingNumber !== undefined ? { trackingNumber: data.trackingNumber } : {}),
    ...(data.trackingUrl !== undefined ? { trackingUrl: data.trackingUrl } : {}),
  };
  if (RANK[data.status] >= RANK.shipped && current !== "shipped" && current !== "delivered") set.shippedAt = now;
  if (data.status === "delivered" && current !== "delivered") set.deliveredAt = now;
  // Starting work confirms a cash-on-delivery order: its stock is no longer on a timer.
  if (order.status === "pending" && order.reservationExpiresAt && RANK[data.status] >= RANK.processing) set.reservationExpiresAt = null;

  // Recorded as it happens, for the order's history. Correcting nothing records nothing.
  const carrier = data.trackingCarrier ?? order.trackingCarrier ?? "";
  const number = data.trackingNumber ?? order.trackingNumber ?? "";
  const changed = data.status !== current || carrier !== (order.trackingCarrier ?? "") || number !== (order.trackingNumber ?? "");

  // Compare-and-set on the state we validated (a concurrent cancellation or
  // another update makes this a 409 instead of a silent overwrite).
  const updated = await Order.findOneAndUpdate(
    {
      ...scope,
      status: order.status,
      ...(current === "unfulfilled" ? { fulfillmentStatus: { $in: [null, "unfulfilled"] } } : { fulfillmentStatus: current }),
    },
    { $set: set, ...(changed ? { $push: { fulfillmentEvents: { status: data.status, at: now, carrier, number } } } : {}) },
    { new: true },
  )
    .select("-ownerToken -idempotencyKey -orderProofHash")
    .lean();
  if (!updated) throw new HttpError(409, "The order changed meanwhile. Reload and try again.", "order_changed");
  if (data.status !== current && (data.status === "shipped" || data.status === "delivered")) {
    queueOrderEmail(data.status, input.businessId, input.orderId);
    notifyOrder(data.status, input.businessId, input.orderId);
  }
  return updated;
}
