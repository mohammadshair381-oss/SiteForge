import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { OrderPayment } from "@/models/OrderPayment";
import { MANAGED_ORDER_STATUSES } from "@/lib/orders/management";

/**
 * Turns the Orders page's filters into one query, always scoped to the business from
 * the route (server-only). Shared by the list and the CSV export, so what is exported
 * is exactly what is on screen. Search input is regex-escaped, never used as a pattern.
 */
const PAYMENT_FILTERS = ["awaiting", "failed", "paid", "refunded", "cod", "online"] as const;
const FULFILLMENT_FILTERS = ["unfulfilled", "processing", "shipped", "delivered"] as const;
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function managedOrderFilter(businessId: string, params: URLSearchParams): Promise<Record<string, unknown>> {
  const status = params.get("status");
  if (status && !(MANAGED_ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new HttpError(400, "Unknown order status filter", "invalid_status");
  }
  // Optional single-order filter (deep link from the customer view). Order
  // numbers are generated hex strings; anything else is rejected.
  const orderNumber = params.get("order");
  if (orderNumber !== null && !/^[0-9a-z]{1,40}$/i.test(orderNumber)) {
    throw new HttpError(400, "Invalid order number", "invalid_order_number");
  }
  const payment = params.get("payment");
  if (payment && !(PAYMENT_FILTERS as readonly string[]).includes(payment)) {
    throw new HttpError(400, "Unknown payment filter", "invalid_payment_filter");
  }
  const fulfillment = params.get("fulfillment");
  if (fulfillment && !(FULFILLMENT_FILTERS as readonly string[]).includes(fulfillment)) {
    throw new HttpError(400, "Unknown fulfilment filter", "invalid_fulfillment_filter");
  }
  const placedBy = params.get("placedBy");
  if (placedBy && placedBy !== "guest" && placedBy !== "registered") {
    throw new HttpError(400, "Unknown customer filter", "invalid_placed_by_filter");
  }
  const dateOf = (name: string, endOfDay: boolean) => {
    const value = params.get(name);
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new HttpError(400, "Choose a valid date", "invalid_date_filter");
    return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  };
  const from = dateOf("from", false);
  const to = dateOf("to", true);
  const search = (params.get("q") ?? "").trim().slice(0, 100);
  const business = new mongoose.Types.ObjectId(businessId);

  const clauses: Record<string, unknown>[] = [{ business }];
  if (status) clauses.push({ status });
  if (orderNumber) clauses.push({ orderNumber });
  if (payment === "awaiting") clauses.push({ status: "pending" });
  if (payment === "paid") clauses.push({ status: "paid" });
  if (payment === "cod") clauses.push({ paymentMethod: "cod" });
  if (payment === "online") clauses.push({ paymentMethod: "online" });
  if (payment === "refunded") clauses.push({ $or: [{ status: "refunded" }, { refundedTotal: { $gt: 0 } }, { refundHoldTotal: { $gt: 0 } }] });
  if (payment === "failed") {
    // Declined attempts and links that ran out, on orders that are not paid.
    const failed = await OrderPayment.distinct("order", { business, $or: [{ status: "failed" }, { lastFailureAt: { $ne: null } }] });
    clauses.push({ _id: { $in: failed }, status: { $in: ["pending", "cancelled"] } });
  }
  if (fulfillment) {
    clauses.push(fulfillment === "unfulfilled" ? { fulfillmentStatus: { $in: [null, "unfulfilled"] }, status: "paid" } : { fulfillmentStatus: fulfillment });
  }
  if (placedBy === "guest") clauses.push({ customer: { $in: [null] } });
  if (placedBy === "registered") clauses.push({ customer: { $type: "objectId" } });
  if (from || to) clauses.push({ createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    clauses.push({ $or: [{ orderNumber: pattern }, { customerName: pattern }, { customerEmail: pattern }, { "items.productName": pattern }, { "items.variantLabel": pattern }, { "items.sku": pattern }, { trackingNumber: pattern }, { "shippingAddress.phone": pattern }, { "shippingAddress.postalCode": pattern }] });
  }
  return { $and: clauses };
}

/** One value for a spreadsheet: quoted, and never read as a formula. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
