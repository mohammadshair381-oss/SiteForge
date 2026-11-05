import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { Order } from "@/models/Order";

/**
 * A signed-in customer's own orders at ONE store (server-only).
 *
 * Always scoped by BOTH the business and the customer: the caller passes the
 * business and customer from `requireCustomer`, never from the client. Guest
 * and historical orders (no `customer`) never appear. The view is allowlisted:
 * guest secrets (owner token, proof digest, idempotency key) never leave.
 */
export interface CustomerOrderView {
  orderId: string;
  orderNumber: string;
  status: "pending" | "paid" | "cancelled" | "refunded";
  paymentMethod: "cod" | "online" | null;
  total: number;
  currency: string;
  createdAt: string;
  /** Unpaid, still holding its stock and not on its way: the customer may cancel it. */
  canCancel: boolean;
  fulfillmentStatus: "unfulfilled" | "processing" | "shipped" | "delivered";
  refundedTotal: number;
  items: Array<{ productName: string; variantLabel: string; quantity: number; unitPrice: number; imageUrl: string }>;
}

/** One order in full: still allowlisted, still only the customer's own. */
export interface CustomerOrderDetail extends CustomerOrderView {
  subtotal: number;
  discountTotal: number;
  discountCode: string;
  shippingTotal: number;
  taxTotal: number;
  taxLabel: string;
  taxInclusive: boolean;
  trackingCarrier: string;
  trackingNumber: string;
  /** Only an http(s) address, so it is safe to use as a link. */
  trackingUrl: string;
  paidAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  shippingAddress: { name: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string; phone: string } | null;
}

export const CUSTOMER_ORDER_HISTORY_LIMIT = 50;

const iso = (value: unknown): string | null => (value ? new Date(value as string | Date).toISOString() : null);

/**
 * One order of THIS customer at THIS store, or null. A malformed id, another
 * customer's order, another store's order and a missing order are all null, so
 * callers answer them with the same 404.
 */
export async function getCustomerOrder(businessId: unknown, customerId: string, orderId: string): Promise<CustomerOrderDetail | null> {
  if (!/^[a-f0-9]{24}$/i.test(orderId) || !mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(String(businessId))) return null;
  await dbConnect();
  const order = await Order.findOne({
    _id: new mongoose.Types.ObjectId(orderId),
    business: new mongoose.Types.ObjectId(String(businessId)),
    customer: new mongoose.Types.ObjectId(customerId),
  })
    .select(
      "orderNumber status paymentMethod subtotal total currency createdAt items inventoryState discount discountTotal taxTotal taxLabel taxInclusive refundedTotal shippingTotal shippingAddress fulfillmentStatus trackingCarrier trackingNumber trackingUrl paidAt shippedAt deliveredAt cancelledAt refundedAt",
    )
    .lean();
  if (!order) return null;
  const address = order.shippingAddress as CustomerOrderDetail["shippingAddress"] | null | undefined;
  const trackingUrl = String(order.trackingUrl ?? "");
  return {
    ...toOrderView(order),
    subtotal: Number(order.subtotal ?? 0),
    discountTotal: Number(order.discountTotal ?? 0),
    discountCode: String(order.discount?.code ?? ""),
    shippingTotal: Number(order.shippingTotal ?? 0),
    taxTotal: Number(order.taxTotal ?? 0),
    taxLabel: String(order.taxLabel ?? ""),
    taxInclusive: Boolean(order.taxInclusive),
    trackingCarrier: String(order.trackingCarrier ?? ""),
    trackingNumber: String(order.trackingNumber ?? ""),
    trackingUrl: /^https?:\/\//i.test(trackingUrl) ? trackingUrl : "",
    paidAt: iso(order.paidAt),
    shippedAt: iso(order.shippedAt),
    deliveredAt: iso(order.deliveredAt),
    cancelledAt: iso(order.cancelledAt),
    refundedAt: iso(order.refundedAt),
    shippingAddress: address
      ? {
          name: String(address.name ?? ""),
          line1: String(address.line1 ?? ""),
          line2: String(address.line2 ?? ""),
          city: String(address.city ?? ""),
          region: String(address.region ?? ""),
          postalCode: String(address.postalCode ?? ""),
          country: String(address.country ?? ""),
          phone: String(address.phone ?? ""),
        }
      : null,
  };
}

/** How many orders this customer has placed at this store. */
export async function countCustomerOrders(businessId: unknown, customerId: string): Promise<number> {
  if (!mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(String(businessId))) return 0;
  await dbConnect();
  return Order.countDocuments({
    business: new mongoose.Types.ObjectId(String(businessId)),
    customer: new mongoose.Types.ObjectId(customerId),
  });
}

function toOrderView(order: {
  _id: unknown;
  orderNumber?: string;
  status: CustomerOrderView["status"];
  paymentMethod?: string | null;
  total?: number;
  currency?: string;
  createdAt: Date;
  inventoryState?: string | null;
  fulfillmentStatus?: CustomerOrderView["fulfillmentStatus"] | null;
  refundedTotal?: number;
  items?: Array<{ productName?: string; variantLabel?: string; quantity?: number; unitPrice?: number; currency?: string; imageUrl?: string }>;
}): CustomerOrderView {
  return {
    orderId: String(order._id),
    orderNumber: String(order.orderNumber ?? ""),
    status: order.status,
    paymentMethod: order.paymentMethod === "cod" || order.paymentMethod === "online" ? order.paymentMethod : null,
    total: Number(order.total ?? 0),
    currency: String(order.currency ?? order.items?.[0]?.currency ?? "USD"),
    createdAt: new Date(order.createdAt).toISOString(),
    canCancel: order.status === "pending" && order.inventoryState === "reserved" && order.fulfillmentStatus !== "shipped" && order.fulfillmentStatus !== "delivered",
    fulfillmentStatus: order.fulfillmentStatus ?? "unfulfilled",
    refundedTotal: order.status === "refunded" ? Number(order.total ?? 0) : Number(order.refundedTotal ?? 0),
    items: (order.items ?? []).map((item) => ({
      productName: String(item.productName ?? ""),
      variantLabel: String(item.variantLabel ?? ""),
      quantity: Number(item.quantity ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      imageUrl: String(item.imageUrl ?? ""),
    })),
  };
}

export const CUSTOMER_ORDER_PAGE_SIZE = 20;

/** One page of this customer's orders, newest first, and whether there are more. */
export async function listCustomerOrdersPage(businessId: unknown, customerId: string, page: number): Promise<{ orders: CustomerOrderView[]; hasMore: boolean }> {
  if (!mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(String(businessId))) return { orders: [], hasMore: false };
  await dbConnect();
  const orders = await Order.find({
    business: new mongoose.Types.ObjectId(String(businessId)),
    customer: new mongoose.Types.ObjectId(customerId),
  })
    .select("orderNumber status paymentMethod total currency createdAt items inventoryState fulfillmentStatus refundedTotal")
    .sort({ createdAt: -1, _id: -1 })
    .skip((Math.max(page, 1) - 1) * CUSTOMER_ORDER_PAGE_SIZE)
    .limit(CUSTOMER_ORDER_PAGE_SIZE + 1)
    .lean();
  return { orders: orders.slice(0, CUSTOMER_ORDER_PAGE_SIZE).map(toOrderView), hasMore: orders.length > CUSTOMER_ORDER_PAGE_SIZE };
}

export async function listCustomerOrders(businessId: unknown, customerId: string): Promise<CustomerOrderView[]> {
  if (!mongoose.isValidObjectId(customerId) || !mongoose.isValidObjectId(String(businessId))) return [];
  await dbConnect();
  const orders = await Order.find({
    business: new mongoose.Types.ObjectId(String(businessId)),
    customer: new mongoose.Types.ObjectId(customerId),
  })
    .select("orderNumber status paymentMethod total currency createdAt items inventoryState fulfillmentStatus refundedTotal")
    .sort({ createdAt: -1, _id: -1 })
    .limit(CUSTOMER_ORDER_HISTORY_LIMIT)
    .lean();
  return orders.map(toOrderView);
}
