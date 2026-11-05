import { handle } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { dbConnect } from "@/lib/db";
import { csvCell, managedOrderFilter } from "@/lib/orders/management-query";
import { derivePaymentStatus } from "@/lib/orders/management";
import { enforceRateLimit } from "@/lib/rate-limit";
import { Order, type OrderDoc } from "@/models/Order";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const EXPORT_LIMIT = 5000;
const HEADERS = ["Order", "Placed", "Status", "Payment", "Payment method", "Fulfilment", "Customer", "Email", "Items", "Subtotal", "Discount", "Discount code", "Shipping", "Tax", "Total", "Refunded", "Currency", "Carrier", "Tracking number", "City", "Region", "Postal code", "Country"];

/** `GET ?<same filters as the list>` — the matching orders as CSV. Owners and managers. */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await enforceRateLimit({ key: `orders:export:${id}`, windowMs: 60 * 60 * 1000, limit: 30 });
    await dbConnect();
    const filter = await managedOrderFilter(id, new URL(request.url).searchParams);
    const orders = await Order.find(filter).select("-ownerToken -idempotencyKey -orderProofHash -internalNote").sort({ createdAt: -1 }).limit(EXPORT_LIMIT).lean<OrderDoc[]>();
    const rows = orders.map((order) =>
      [
        order.orderNumber,
        new Date(order.createdAt).toISOString(),
        order.status,
        derivePaymentStatus(order),
        order.paymentMethod ?? "",
        order.fulfillmentStatus ?? "unfulfilled",
        order.customerName,
        order.customerEmail,
        (order.items ?? []).map((item) => `${item.quantity} x ${item.productName}${item.variantLabel ? ` (${item.variantLabel})` : ""}`).join("; "),
        order.subtotal,
        order.discountTotal ?? 0,
        order.discount?.code ?? "",
        order.shippingTotal ?? 0,
        order.taxTotal ?? 0,
        order.total,
        order.status === "refunded" ? order.total : order.refundedTotal ?? 0,
        order.currency ?? "",
        order.trackingCarrier ?? "",
        order.trackingNumber ?? "",
        order.shippingAddress?.city ?? "",
        order.shippingAddress?.region ?? "",
        order.shippingAddress?.postalCode ?? "",
        order.shippingAddress?.country ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
    return new Response([HEADERS.map(csvCell).join(","), ...rows].join("\r\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="orders.csv"',
        "Cache-Control": "no-store",
      },
    });
  });
}
