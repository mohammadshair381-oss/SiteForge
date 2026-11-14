import mongoose from "mongoose";
import { runAfterResponse } from "@/lib/after-response";
import { dbConnect } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { renderOrderEmail, type OrderEmailKind } from "@/lib/email-templates";
import { Business } from "@/models/Business";
import { Order, type OrderDoc } from "@/models/Order";
import { User } from "@/models/User";

/**
 * Order emails to shoppers and store owners (server-only). Sent after the response
 * and best-effort: a mail failure never changes an order or an API answer, and only
 * the operation and error category are logged, never an address or order content.
 * Not a durable queue: see lib/after-response.ts.
 */
function logFailure(error: unknown): void {
  console.error(JSON.stringify({ event: "order_email_failed", category: error instanceof Error ? error.name : "unknown" }));
}

async function send(kind: OrderEmailKind, businessId: string, orderId: string): Promise<void> {
  await dbConnect();
  const business = await Business.findById(businessId).select("name contactEmail owner").lean<{ name: string; contactEmail?: string; owner?: unknown }>();
  const order = await Order.findOne({ _id: new mongoose.Types.ObjectId(orderId), business: new mongoose.Types.ObjectId(businessId) }).lean<OrderDoc>();
  if (!business || !order) return;

  const items = (order.items ?? []).map((item) => ({ name: item.productName, variant: item.variantLabel ?? "", quantity: item.quantity, lineTotal: item.unitPrice * item.quantity }));
  const details = {
    storeName: business.name,
    orderNumber: order.orderNumber,
    // A guest's name and address are both unverified, so that text could be aimed at anyone.
    customerName: kind === "owner_new_order" || order.customer ? order.customerName : "",
    currency: order.currency ?? "USD",
    items,
    subtotal: order.subtotal,
    discount: Number(order.discountTotal ?? 0),
    shipping: typeof order.shippingTotal === "number" ? order.shippingTotal : null,
    tax: Number(order.taxTotal ?? 0),
    taxLabel: order.taxLabel ?? "Tax",
    taxInclusive: Boolean(order.taxInclusive),
    total: order.total,
    paymentMethod: order.paymentMethod ?? null,
    trackingCarrier: order.trackingCarrier ?? "",
    trackingNumber: order.trackingNumber ?? "",
    trackingUrl: order.trackingUrl ?? "",
    refundedTotal: Number(order.refundedTotal ?? 0),
  };

  if (kind === "owner_new_order") {
    const owner = business.contactEmail ? null : await User.findById(business.owner).select("email").lean<{ email?: string }>();
    const to = business.contactEmail || owner?.email;
    if (to) await sendEmail({ to, ...renderOrderEmail(kind, details) });
    return;
  }
  await sendEmail({ to: order.customerEmail, ...renderOrderEmail(kind, details) });
}

/** Queues one order email. Never throws, and never delays or changes the response. */
export function queueOrderEmail(kind: OrderEmailKind, businessId: string, orderId: string): void {
  try {
    runAfterResponse(() => send(kind, businessId, orderId), { operation: "order_email", onError: logFailure });
  } catch (error) {
    logFailure(error);
  }
}
