import mongoose, { type PipelineStage, type Types } from "mongoose";
import { Business } from "@/models/Business";
import { Order, type OrderDoc } from "@/models/Order";

/**
 * Business customer management, DERIVED FROM ORDERS.
 *
 * Source of truth: `Order` documents. There is no separate customer record:
 * the existing `models/Customer.ts` stays unused, because writing it at
 * checkout would change the guest checkout flow and need a backfill, creating
 * a second copy of customer data that could drift from the orders.
 *
 * Identity rule: within ONE business, a customer is the set of orders whose
 * `customerEmail`, with ordinary whitespace trimmed and ASCII letters
 * lower-cased, is the same valid address. Nothing else is merged (no Gmail
 * dot/plus folding, no Unicode case folding, no name matching): when identity
 * is uncertain, orders are not combined. Orders with a missing, non-string,
 * over-long or malformed email (including control characters) are not
 * grouped; they are only counted (`unidentifiedOrderCount`). The same rule is
 * implemented in JS (`normalizeCustomerEmail` / `isGroupableCustomerEmail`)
 * and in the aggregation pipeline, so both always agree.
 *
 * Totals rule (per currency; currencies are never summed together):
 * - `paid`:    sum of `total` for orders with status "paid".
 * - `pending`: sum of `total` for orders "pending" (awaiting payment; expired
 *              reservations are released before reading, as on the Orders list).
 * - "cancelled" and "refunded" orders add nothing to either total but are
 *   included in `orderCount`.
 *
 * Customer id: the `_id` of the customer's first order in this business (the
 * smallest ObjectId). Opaque, stable (orders are never deleted), contains no
 * personal data, and every lookup is re-scoped to the business, so another
 * tenant's id resolves to "not found".
 *
 * Server-only. Callers must authorize the business first (owner/manager, see
 * `requireBusinessRole`) and call `dbConnect()`.
 */

/**
 * Valid customer email (JS and MongoDB PCRE compatible): one `@`, a dot in the
 * domain, no whitespace and no control characters.
 */
export const CUSTOMER_EMAIL_PATTERN =
  "^[^\\s@\\x00-\\x1f\\x7f]+@[^\\s@\\x00-\\x1f\\x7f]+\\.[^\\s@\\x00-\\x1f\\x7f]+$";
const CUSTOMER_EMAIL_REGEX = new RegExp(CUSTOMER_EMAIL_PATTERN);
const CUSTOMER_EMAIL_MAX = 254;
/** Only these characters are trimmed (same set in JS and in `$trim`). */
const TRIM_CHARS = " \t\n\r\f\v";
const TRIM_REGEX = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;

export const CUSTOMER_PAGE_SIZE_DEFAULT = 20;
export const CUSTOMER_PAGE_SIZE_MAX = 50;
export const CUSTOMER_SEARCH_MAX = 100;
/** Orders returned on a customer detail view (newest first). */
export const CUSTOMER_ORDER_HISTORY_LIMIT = 100;

/** Trim ordinary whitespace + lower-case ASCII; the only normalisation applied. */
export function normalizeCustomerEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(TRIM_REGEX, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Whether an already-normalised email can identify a customer. */
export function isGroupableCustomerEmail(email: string): boolean {
  return email.length > 0 && email.length <= CUSTOMER_EMAIL_MAX && CUSTOMER_EMAIL_REGEX.test(email);
}

/** Escapes user search text for a literal, case-insensitive regex match. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CustomerTotal {
  currency: string;
  paid: number;
  pending: number;
}

export interface CustomerSummary {
  id: string;
  name: string;
  email: string;
  orderCount: number;
  paidOrderCount: number;
  totals: CustomerTotal[];
  firstOrderAt: Date;
  lastOrderAt: Date;
}

export interface CustomerOrderView {
  id: string;
  orderNumber: string;
  createdAt: Date;
  status: OrderDoc["status"];
  cancelReason: string | null;
  items: Array<{ productName: string; quantity: number }>;
  total: number;
  currency: string;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Normalised email as an aggregation expression. Non-strings become "" (never
 * an error), and the result mirrors `normalizeCustomerEmail`.
 */
export const normalizedEmailExpr = {
  $toLower: {
    $trim: {
      input: {
        $cond: [{ $eq: [{ $type: "$customerEmail" }, "string"] }, "$customerEmail", ""],
      },
      chars: TRIM_CHARS,
    },
  },
};

/** Whether the projected `$email` identifies a customer (mirrors the JS check). */
export const groupableExpr = {
  $and: [
    { $regexMatch: { input: "$email", regex: CUSTOMER_EMAIL_PATTERN } },
    { $lte: [{ $strLenCP: "$email" }, CUSTOMER_EMAIL_MAX] },
  ],
};

const nonEmptyString = (path: string) => ({
  $and: [{ $eq: [{ $type: path }, "string"] }, { $ne: [path, ""] }],
});

/** Order currency, else first item's currency, else the business currency (as a literal). */
function currencyExpr(fallback: string) {
  const firstItemCurrency = { $arrayElemAt: [{ $ifNull: ["$items.currency", []] }, 0] };
  return {
    $let: {
      vars: { itemCurrency: firstItemCurrency },
      in: {
        $cond: [
          nonEmptyString("$currency"),
          "$currency",
          {
            $cond: [nonEmptyString("$$itemCurrency"), "$$itemCurrency", { $literal: fallback }],
          },
        ],
      },
    },
  };
}

/** Projection + validity flag shared by every customer query of ONE business. */
function projectedOrders(businessId: Types.ObjectId, fallbackCurrency: string): PipelineStage[] {
  return [
    { $match: { business: businessId } },
    {
      $project: {
        email: normalizedEmailExpr,
        name: { $cond: [{ $eq: [{ $type: "$customerName" }, "string"] }, "$customerName", ""] },
        status: 1,
        total: { $cond: [{ $isNumber: "$total" }, "$total", 0] },
        refunded: { $cond: [{ $isNumber: "$refundedTotal" }, "$refundedTotal", 0] },
        currency: currencyExpr(fallbackCurrency),
        createdAt: 1,
      },
    },
    { $addFields: { groupable: groupableExpr } },
  ];
}

/** Groups groupable orders into customers. `email` limits it to one customer. */
function groupingStages(
  businessId: Types.ObjectId,
  fallbackCurrency: string,
  email?: string,
): PipelineStage[] {
  return [
    ...projectedOrders(businessId, fallbackCurrency),
    // `email` is matched as a plain value (query $match, not an expression).
    { $match: email === undefined ? { groupable: true } : { groupable: true, email } },
    { $sort: { _id: 1 } },
    // Per (email, currency): counts and totals.
    {
      $group: {
        _id: { email: "$email", currency: "$currency" },
        anchor: { $first: "$_id" },
        lastId: { $last: "$_id" },
        name: { $last: "$name" },
        orderCount: { $sum: 1 },
        paidOrderCount: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
        // A partial refund leaves the order paid; only what was kept counts.
        paid: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, { $subtract: ["$total", "$refunded"] }, 0] } },
        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, "$total", 0] } },
        firstOrderAt: { $min: "$createdAt" },
        lastOrderAt: { $max: "$createdAt" },
      },
    },
    // Per email: the most recent order's name wins.
    { $sort: { lastId: 1 } },
    {
      $group: {
        _id: "$_id.email",
        anchor: { $min: "$anchor" },
        name: { $last: "$name" },
        orderCount: { $sum: "$orderCount" },
        paidOrderCount: { $sum: "$paidOrderCount" },
        totals: { $push: { currency: "$_id.currency", paid: "$paid", pending: "$pending" } },
        firstOrderAt: { $min: "$firstOrderAt" },
        lastOrderAt: { $max: "$lastOrderAt" },
      },
    },
  ];
}

interface GroupedCustomer {
  _id: string;
  anchor: Types.ObjectId;
  name: string;
  orderCount: number;
  paidOrderCount: number;
  totals: CustomerTotal[];
  firstOrderAt: Date;
  lastOrderAt: Date;
}

function toSummary(row: GroupedCustomer): CustomerSummary {
  return {
    id: String(row.anchor),
    name: row.name,
    email: row._id,
    orderCount: row.orderCount,
    paidOrderCount: row.paidOrderCount,
    totals: [...row.totals]
      .map((t) => ({ currency: t.currency || "", paid: t.paid ?? 0, pending: t.pending ?? 0 }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    firstOrderAt: row.firstOrderAt,
    lastOrderAt: row.lastOrderAt,
  };
}

async function businessCurrency(businessId: Types.ObjectId): Promise<string> {
  const business = await Business.findById(businessId).select("currency").lean();
  return business?.currency || "USD";
}

export interface CustomerListResult {
  customers: CustomerSummary[];
  total: number;
  page: number;
  limit: number;
  unidentifiedOrderCount: number;
}

/** Paginated, searchable customer list for ONE business (newest activity first). */
export async function listBusinessCustomers(
  businessId: string,
  options: { page: number; limit: number; search?: string },
): Promise<CustomerListResult> {
  const business = new mongoose.Types.ObjectId(businessId);
  const fallback = await businessCurrency(business);
  const search = (options.search ?? "").trim();
  const searchRegex = escapeRegex(search);

  const pipeline: PipelineStage[] = [
    ...groupingStages(business, fallback),
    ...(search
      ? [
          {
            $match: {
              $or: [
                { _id: { $regex: searchRegex, $options: "i" } },
                { name: { $regex: searchRegex, $options: "i" } },
              ],
            },
          } as PipelineStage,
        ]
      : []),
    { $sort: { lastOrderAt: -1, _id: 1 } },
    {
      $facet: {
        total: [{ $count: "n" }],
        page: [{ $skip: (options.page - 1) * options.limit }, { $limit: options.limit }],
      },
    },
  ];

  const [[facet], unidentified] = await Promise.all([
    Order.aggregate<{ total: Array<{ n: number }>; page: GroupedCustomer[] }>(pipeline),
    Order.aggregate<{ n: number }>([
      ...projectedOrders(business, fallback),
      { $match: { groupable: false } },
      { $count: "n" },
    ]),
  ]);

  return {
    customers: (facet?.page ?? []).map(toSummary),
    total: facet?.total?.[0]?.n ?? 0,
    page: options.page,
    limit: options.limit,
    unidentifiedOrderCount: unidentified[0]?.n ?? 0,
  };
}

export interface CustomerDetailResult {
  customer: CustomerSummary;
  orders: CustomerOrderView[];
  ordersShown: number;
}

/**
 * One customer of ONE business, identified by any of their order ids
 * (normally the customer id from the list). Returns null - never another
 * tenant's data - when the id is not an order of this business or the order
 * has no groupable email.
 */
export async function getBusinessCustomer(
  businessId: string,
  customerId: string,
): Promise<CustomerDetailResult | null> {
  if (!/^[0-9a-f]{24}$/i.test(customerId)) return null;
  const business = new mongoose.Types.ObjectId(businessId);

  const anchor = await Order.findOne({ _id: customerId, business })
    .select("customerEmail")
    .lean<{ customerEmail?: unknown }>();
  if (!anchor) return null;
  const email = normalizeCustomerEmail(anchor.customerEmail);
  if (!isGroupableCustomerEmail(email)) return null;

  const fallback = await businessCurrency(business);

  const [summaryRows, orders] = await Promise.all([
    Order.aggregate<GroupedCustomer>(groupingStages(business, fallback, email)),
    Order.find({
      business,
      // `$literal`: the stored email must never be interpreted as a field path
      // or variable (a value starting with "$" would otherwise be).
      $expr: { $eq: [normalizedEmailExpr, { $literal: email }] },
    })
      // Explicit allowlist: never guest secrets or other customers' data.
      .select("orderNumber createdAt status cancelReason items.productName items.quantity total currency items.currency")
      .sort({ createdAt: -1, _id: -1 })
      .limit(CUSTOMER_ORDER_HISTORY_LIMIT)
      .lean(),
  ]);
  if (summaryRows.length === 0) return null;

  return {
    customer: toSummary(summaryRows[0]),
    ordersShown: orders.length,
    orders: orders.map((order) => {
      const items = Array.isArray(order.items) ? order.items : [];
      return {
        id: String(order._id),
        orderNumber: String(order.orderNumber ?? ""),
        createdAt: order.createdAt as Date,
        status: order.status,
        cancelReason: order.cancelReason ?? null,
        items: items.map((item: { productName?: string; quantity?: number }) => ({
          productName: String(item.productName ?? ""),
          quantity: Number(item.quantity ?? 0),
        })),
        total: Number(order.total ?? 0),
        currency: String(order.currency || items[0]?.currency || fallback),
      };
    }),
  };
}
