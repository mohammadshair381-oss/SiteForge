import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { groupableExpr, normalizedEmailExpr } from "@/lib/customers";
import { parseDateRange, toIsoDay, type DateRange } from "@/lib/date-range";
import { getBusinessUsage, usageLine } from "@/lib/usage-limits";
import { Business } from "@/models/Business";
import { Order } from "@/models/Order";
import { OrderRefund } from "@/models/OrderRefund";
import { PaymentDispute, OPEN_DISPUTE_STATUSES } from "@/models/PaymentDispute";
import { Product } from "@/models/Product";

/**
 * Business-owner insights (server-only). Callers must authorize first with
 * `requireBusinessRole(id, ["owner", "manager"])` (same audience as orders).
 *
 * Every figure is MEASURED from this business's own records; nothing is
 * estimated, projected or AI-generated. Definitions (kept consistent with the
 * Orders and Customers pages):
 * - Orders placed: orders created in the range, by status.
 * - Sales: orders with status "paid" whose `paidAt` is in the range, per
 *   currency (online = Razorpay-verified, COD = marked paid by the business).
 *   Refunded orders are reported separately and are not part of sales.
 * - Gross, refunds and net: orders that were paid in the range, whatever has
 *   happened to them since. Gross is what they totalled, refunds what has gone back,
 *   and net the difference, so net equals sales. Unpaid and cancelled orders never count.
 * - Refunds by refund date: money that went back during the range, whenever the order was
 *   paid. So this differs from the refunds above whenever a refund falls in another period.
 *   Older fully refunded orders with no refund record use the order's `refundedAt`.
 * - Unpaid and cancelled: orders placed in the range that are pending or cancelled now.
 *   Listed only so owners can see them; they are never revenue.
 * - Payment methods and coupons: orders placed in the range, except cancelled ones.
 * - Repeat customers: customers with an order in the range and two or more in all.
 * - Customers: the Customers page identity (normalised `customerEmail`).
 * - Stock: the product's current `stock`, which already excludes units
 *   reserved by pending orders.
 * - Low stock: at or below each product's own level (lib/inventory-rules.ts).
 * - Plan usage: lib/usage-limits.ts, the same counts the limits are enforced with.
 */

export const LOW_STOCK_THRESHOLD = 5;
const DAY = 24 * 60 * 60 * 1000;

export { parseDateRange };

export interface Money {
  currency: string;
  amount: number;
  orders: number;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function moneyRows(rows: Array<{ _id: unknown; amount: number; orders: number }>): Money[] {
  return rows
    .map((r) => ({ currency: String(r._id || "—"), amount: round2(r.amount), orders: r.orders }))
    .sort((a, b) => b.amount - a.amount);
}

const currencyExpr = { $toUpper: { $ifNull: ["$currency", "—"] } };
/** What a paid order has kept: partial refunds leave it `paid`, so they come off here. */
const keptExpr = { $subtract: ["$total", { $ifNull: ["$refundedTotal", 0] }] };
/** Older refunded orders have no `refundedTotal`: the whole order went back. */
const refundedExpr = { $cond: [{ $gt: [{ $ifNull: ["$refundedTotal", 0] }, 0] }, "$refundedTotal", "$total"] };

export async function getBusinessInsights(businessId: string, range: DateRange) {
  await dbConnect();
  const business = new mongoose.Types.ObjectId(businessId);
  const placed = { business, createdAt: { $gte: range.from, $lt: range.to } };
  const span = range.to.getTime() - range.from.getTime();
  const previous = { from: new Date(range.from.getTime() - span), to: range.from };
  const paidIn = (from: Date, to: Date) => ({ business, status: "paid", paidAt: { $gte: from, $lt: to } });

  const businessDoc = await Business.findById(business).select("currency").lean();
  const primaryCurrency = (businessDoc?.currency || "USD").toUpperCase();

  const [
    statusRows, prevOrders, sales, prevSales, refunds, salesSeries, orderSeries,
    topProducts, soldProductIds, activeProducts, lowStock, outOfStock, customers, usage, openDisputes,
    revenue, unitsSold, methodRows, couponRows, refundsByDate, olderRefundsByDate, unpaidRows, cancelledRows,
  ] = await Promise.all([
    Order.aggregate<{ _id: string; count: number }>([{ $match: placed }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.countDocuments({ business, createdAt: { $gte: previous.from, $lt: previous.to } }),
    Order.aggregate<{ _id: { currency: string; method: unknown }; amount: number; orders: number }>([
      { $match: paidIn(range.from, range.to) },
      { $group: { _id: { currency: currencyExpr, method: "$paymentMethod" }, amount: { $sum: keptExpr }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; amount: number; orders: number }>([
      { $match: paidIn(previous.from, previous.to) },
      { $group: { _id: currencyExpr, amount: { $sum: keptExpr }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; amount: number; orders: number }>([
      // Fully refunded in the period, plus partial refunds on orders paid in it.
      { $match: { business, $or: [{ status: "refunded", refundedAt: { $gte: range.from, $lt: range.to } }, { status: "paid", refundedTotal: { $gt: 0 }, paidAt: { $gte: range.from, $lt: range.to } }] } },
      { $group: { _id: currencyExpr, amount: { $sum: refundedExpr }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; amount: number }>([
      { $match: { ...paidIn(range.from, range.to), $expr: { $eq: [currencyExpr, { $literal: primaryCurrency }] } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$paidAt", timezone: "UTC" } }, amount: { $sum: keptExpr } } },
    ]),
    Order.aggregate<{ _id: string; count: number }>([
      { $match: placed },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: { product: string; currency: string }; name: string; units: number; revenue: number; orders: number }>([
      { $match: paidIn(range.from, range.to) },
      { $unwind: "$items" },
      {
        $group: {
          _id: { product: "$items.product", currency: { $toUpper: { $ifNull: ["$items.currency", "$currency"] } } },
          name: { $last: "$items.productName" },
          units: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.quantity", "$items.unitPrice"] } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { units: -1, revenue: -1 } },
      { $limit: 10 },
    ]),
    Order.distinct("items.product", paidIn(range.from, range.to)),
    Product.find({ business, status: "active" }).select("_id name").lean(),
    Product.find({ business, status: "active", stock: { $gt: 0 }, $expr: { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", LOW_STOCK_THRESHOLD] }] } }).sort({ stock: 1, name: 1 }).limit(20).select("name stock").lean(),
    Product.find({ business, status: "active", stock: { $lte: 0 } }).sort({ name: 1 }).limit(20).select("name stock").lean(),
    // Customer identity exactly as on the Customers page.
    Order.aggregate<{ _id: string; firstOrder: Date; inRange: number; total: number }>([
      { $match: { business, createdAt: { $lt: range.to } } },
      { $project: { email: normalizedEmailExpr, createdAt: 1 } },
      { $addFields: { groupable: groupableExpr } },
      { $match: { groupable: true } },
      {
        $group: {
          _id: "$email",
          firstOrder: { $min: "$createdAt" },
          total: { $sum: 1 },
          inRange: { $sum: { $cond: [{ $gte: ["$createdAt", { $literal: range.from }] }, 1, 0] } },
        },
      },
      { $match: { inRange: { $gt: 0 } } },
    ]),
    getBusinessUsage(businessId),
    PaymentDispute.countDocuments({ business, status: { $in: OPEN_DISPUTE_STATUSES } }),
    Order.aggregate<{ _id: string; gross: number; refunds: number; orders: number }>([
      { $match: { business, status: { $in: ["paid", "refunded"] }, paidAt: { $gte: range.from, $lt: range.to } } },
      {
        $group: {
          _id: currencyExpr,
          gross: { $sum: "$total" },
          refunds: { $sum: { $cond: [{ $eq: ["$status", "refunded"] }, refundedExpr, { $ifNull: ["$refundedTotal", 0] }] } },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate<{ _id: null; units: number }>([
      { $match: paidIn(range.from, range.to) },
      { $unwind: "$items" },
      { $group: { _id: null, units: { $sum: "$items.quantity" } } },
    ]),
    Order.aggregate<{ _id: unknown; count: number }>([
      { $match: { ...placed, status: { $ne: "cancelled" } } },
      { $group: { _id: "$paymentMethod", count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: { code: string; currency: string }; orders: number; discount: number }>([
      { $match: { ...placed, status: { $ne: "cancelled" }, "discount.code": { $gt: "" } } },
      { $group: { _id: { code: "$discount.code", currency: currencyExpr }, orders: { $sum: 1 }, discount: { $sum: { $ifNull: ["$discountTotal", "$discount.amount"] } } } },
      { $sort: { orders: -1, discount: -1 } },
      { $limit: 10 },
    ]),
    OrderRefund.aggregate<{ _id: string; amount: number; orders: number }>([
      { $match: { business, status: "processed", processedAt: { $gte: range.from, $lt: range.to } } },
      { $group: { _id: { $toUpper: "$currency" }, amount: { $sum: "$amount" }, orders: { $sum: 1 } } },
    ]),
    OrderRefund.distinct("order", { business, status: "processed" }).then((recorded) =>
      Order.aggregate<{ _id: string; amount: number; orders: number }>([
        { $match: { business, status: "refunded", refundedAt: { $gte: range.from, $lt: range.to }, _id: { $nin: recorded } } },
        { $group: { _id: currencyExpr, amount: { $sum: refundedExpr }, orders: { $sum: 1 } } },
      ]),
    ),
    Order.aggregate<{ _id: string; amount: number; orders: number }>([
      { $match: { ...placed, status: "pending" } },
      { $group: { _id: currencyExpr, amount: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; amount: number; orders: number }>([
      { $match: { ...placed, status: "cancelled" } },
      { $group: { _id: currencyExpr, amount: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = Object.fromEntries(["pending", "paid", "cancelled", "refunded"].map((s) => [s, 0])) as Record<string, number>;
  for (const row of statusRows) byStatus[row._id] = (byStatus[row._id] ?? 0) + row.count;
  const ordersPlaced = Object.values(byStatus).reduce((n, v) => n + v, 0);

  const salesTotals = new Map<string, Money & { online: number; cod: number; other: number }>();
  for (const row of sales) {
    const key = String(row._id.currency || "—");
    const entry = salesTotals.get(key) ?? { currency: key, amount: 0, orders: 0, online: 0, cod: 0, other: 0 };
    entry.amount += row.amount;
    entry.orders += row.orders;
    if (row._id.method === "online") entry.online += row.amount;
    else if (row._id.method === "cod") entry.cod += row.amount;
    else entry.other += row.amount;
    salesTotals.set(key, entry);
  }
  const salesByCurrency = [...salesTotals.values()]
    .map((s) => ({ ...s, amount: round2(s.amount), online: round2(s.online), cod: round2(s.cod), other: round2(s.other), averageOrder: s.orders ? round2(s.amount / s.orders) : 0 }))
    .sort((a, b) => b.amount - a.amount);
  const prevByCurrency = new Map(moneyRows(prevSales).map((m) => [m.currency, m]));

  const days = Array.from({ length: range.days }, (_, i) => toIsoDay(new Date(range.from.getTime() + i * DAY)));
  const salesMap = new Map(salesSeries.map((r) => [r._id, round2(r.amount)]));
  const ordersMap = new Map(orderSeries.map((r) => [r._id, r.count]));

  const sold = new Set((soldProductIds as unknown[]).map(String));
  const firstOrders = customers.filter((c) => c.firstOrder >= range.from);
  const newCustomers = firstOrders.length;
  const newByDay = new Map<string, number>();
  for (const customer of firstOrders) {
    const day = toIsoDay(new Date(customer.firstOrder));
    newByDay.set(day, (newByDay.get(day) ?? 0) + 1);
  }
  const refundDateTotals = new Map<string, { _id: string; amount: number; orders: number }>();
  for (const row of [...refundsByDate, ...olderRefundsByDate]) {
    const entry = refundDateTotals.get(row._id) ?? { _id: row._id, amount: 0, orders: 0 };
    entry.amount += row.amount;
    entry.orders += row.orders;
    refundDateTotals.set(row._id, entry);
  }
  const methodCount = (method: string) => methodRows.filter((row) => row._id === method).reduce((sum, row) => sum + row.count, 0);
  const products = usageLine(usage, "products");
  const team = usageLine(usage, "teamMembers");

  return {
    range: { from: toIsoDay(range.from), to: toIsoDay(new Date(range.to.getTime() - DAY)), days: range.days },
    primaryCurrency,
    orders: { placed: ordersPlaced, byStatus, previousPeriod: prevOrders },
    sales: salesByCurrency.map((s) => ({ ...s, previousPeriod: prevByCurrency.get(s.currency)?.amount ?? 0 })),
    refunds: moneyRows(refunds),
    revenue: revenue
      .map((row) => ({
        currency: String(row._id || "—"),
        gross: round2(row.gross),
        refunds: round2(row.refunds),
        net: round2(row.gross - row.refunds),
        orders: row.orders,
        averageOrder: row.orders ? round2(row.gross / row.orders) : 0,
      }))
      .sort((a, b) => b.gross - a.gross),
    /** Money that went back during this period. `orders` here counts refunds. */
    refundsByRefundDate: moneyRows([...refundDateTotals.values()]),
    notRevenue: { unpaid: moneyRows(unpaidRows), cancelled: moneyRows(cancelledRows) },
    unitsSold: unitsSold[0]?.units ?? 0,
    paymentMethods: { online: methodCount("online"), cod: methodCount("cod"), unknown: methodRows.filter((row) => row._id !== "online" && row._id !== "cod").reduce((sum, row) => sum + row.count, 0) },
    coupons: couponRows.map((row) => ({ code: row._id.code, currency: row._id.currency, orders: row.orders, discount: round2(row.discount) })),
    series: {
      orders: days.map((day) => ({ day, count: ordersMap.get(day) ?? 0 })),
      sales: days.map((day) => ({ day, count: salesMap.get(day) ?? 0 })),
    },
    topProducts: topProducts.map((p) => ({
      productId: String(p._id.product),
      name: p.name,
      currency: p._id.currency,
      units: p.units,
      revenue: round2(p.revenue),
      orders: p.orders,
    })),
    unsoldActiveProducts: activeProducts.filter((p) => !sold.has(String(p._id))).length,
    activeProducts: activeProducts.length,
    lowStock: lowStock.map((p) => ({ id: String(p._id), name: p.name, stock: p.stock })),
    outOfStock: outOfStock.map((p) => ({ id: String(p._id), name: p.name })),
    customers: {
      inRange: customers.length,
      new: newCustomers,
      returning: customers.length - newCustomers,
      repeat: customers.filter((c) => c.total >= 2).length,
      newSeries: days.map((day) => ({ day, count: newByDay.get(day) ?? 0 })),
    },
    plan: {
      name: usage.entitlements.planName,
      status: usage.entitlements.status,
      active: usage.entitlements.active,
      expired: usage.entitlements.expired,
      products: { used: products.used, limit: products.limit as number },
      staff: { used: team.used, limit: team.limit as number },
      usage: usage.lines,
    },
    openDisputes,
  };
}

export type BusinessInsights = Awaited<ReturnType<typeof getBusinessInsights>>;
