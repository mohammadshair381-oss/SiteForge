import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { releaseExpiredOrdersOnDemand } from "@/lib/orders/lifecycle";
import { toManagedOrderView } from "@/lib/orders/management";
import { managedOrderFilter } from "@/lib/orders/management-query";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { PaymentDispute } from "@/models/PaymentDispute";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const LIST_LIMIT = 100;

/**
 * `GET /api/businesses/[id]/manage/orders[?status=&payment=&fulfillment=&q=&page=&limit=]`
 *
 * Owner/manager order list for one business, newest first. The tenant comes
 * from the membership check on the route id (never from the order data), and
 * every query is scoped to it. Expired reservations are released first so the
 * list and stock reflect reality without a scheduler.
 */
export async function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();

    const searchParams = new URL(request.url).searchParams;
    const filter = await managedOrderFilter(id, searchParams);
    const page = Math.max(1, Math.trunc(Number(searchParams.get("page")) || 1));
    const limit = Math.min(LIST_LIMIT, Math.max(1, Math.trunc(Number(searchParams.get("limit")) || LIST_LIMIT)));

    await releaseExpiredOrdersOnDemand(id);

    const found = await Order.find(filter)
      .select("-ownerToken -idempotencyKey -orderProofHash")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit + 1)
      .lean();
    const hasMore = found.length > limit;
    const orders = found.slice(0, limit);

    // Payment attempts on these orders (scoped to this business; only derived
    // flags leave the server).
    const hasOnline = orders.some((order) => order.paymentMethod === "online");
    const payments = hasOnline
      ? await OrderPayment.find({ business: id, order: { $in: orders.map((order) => order._id) } })
          .select("order status mode orderOutcome lastFailureAt")
          .lean()
      : [];
    const paymentsByOrder = new Map<string, typeof payments>();
    for (const payment of payments) {
      const key = String(payment.order);
      paymentsByOrder.set(key, [...(paymentsByOrder.get(key) ?? []), payment]);
    }
    // Provider-reported disputes on these orders (this business only).
    const disputes = hasOnline
      ? await PaymentDispute.find({ business: id, order: { $in: orders.map((order) => order._id) } })
          .sort({ createdAt: -1 })
          .select("order status respondBy")
          .lean()
      : [];
    const disputeByOrder = new Map<string, { status: string; respondBy: Date | null }>();
    for (const d of disputes) {
      if (!disputeByOrder.has(String(d.order))) disputeByOrder.set(String(d.order), { status: d.status, respondBy: d.respondBy ?? null });
    }

    return ok({
      orders: orders.map((order) =>
        toManagedOrderView(order, {
          paymentNeedsReview: (paymentsByOrder.get(String(order._id)) ?? []).some((p) => p.orderOutcome === "needs_review"),
          dispute: disputeByOrder.get(String(order._id)) ?? null,
          payments: paymentsByOrder.get(String(order._id)) ?? [],
        }),
      ),
      page,
      hasMore,
    });
  });
}
