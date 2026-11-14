import mongoose from "mongoose";
import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { isEntitlingSubscription, isExpiredPaidSubscription, isManualBillingAllowed } from "@/lib/billing";
import { getPublishFacts } from "@/lib/publish-gates";
import { describeStoreAccess, type StoreAccess } from "@/lib/store-access";
import {
  BUSINESS_STATUSES,
  PAYMENT_STATUSES,
  PLATFORM_ROLES,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from "@/lib/constants";
import { AdminAuditLog, ADMIN_AUDIT_ACTIONS, ADMIN_AUDIT_TARGET_TYPES } from "@/models/AdminAuditLog";
import { Business } from "@/models/Business";
import { BusinessPaymentAccount } from "@/models/BusinessPaymentAccount";
import { Customer } from "@/models/Customer";
import { Membership } from "@/models/Membership";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { Payment } from "@/models/Payment";
import { DISPUTE_STATUSES, OPEN_DISPUTE_STATUSES, PaymentDispute } from "@/models/PaymentDispute";
import { Plan } from "@/models/Plan";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import { User } from "@/models/User";
import { getSecuritySummary } from "@/lib/admin/security";
import { MAX_RANGE_DAYS, parseDateRange, toIsoDay, type DateRange } from "@/lib/date-range";

/**
 * Read-only data for the Super Admin control center (server-only).
 *
 * Every function here assumes the caller already passed `requireSuperAdmin()`
 * (API routes) or `resolveSuperAdminPageAccess()` (pages). Nothing here writes;
 * the only admin writes stay in the audited `/api/admin/*` action routes.
 *
 * Data minimisation: results never include password hashes, token versions,
 * session data, payment-provider secrets, order ownership proofs, or shopper
 * names/emails. Money is reported per currency and labelled by how it was
 * verified (see `PaymentSummary`); nothing is converted or estimated.
 *
 * Index note: these are admin-only, paginated or capped queries. They add no
 * schema indexes (which would auto-build on persistent databases); date-range
 * counts may scan, which is acceptable at current platform scale.
 */

const PAGE_SIZE = 25;

/** Escape user input before using it in a MongoDB regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DAY_MS = 24 * 60 * 60 * 1000;
export { MAX_RANGE_DAYS, parseDateRange, toIsoDay, type DateRange };

function countBy(rows: Array<{ _id: unknown; count: number }>, keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const row of rows) {
    const key = row._id == null ? "unknown" : String(row._id);
    out[key] = (out[key] ?? 0) + row.count;
  }
  return out;
}

/** Fill a per-day series so days without records show as zero. */
function dailySeries(rows: Array<{ _id: string; count: number }>, range: DateRange): Array<{ day: string; count: number }> {
  const byDay = new Map(rows.map((r) => [r._id, r.count]));
  return Array.from({ length: range.days }, (_, i) => {
    const day = toIsoDay(new Date(range.from.getTime() + i * DAY_MS));
    return { day, count: byDay.get(day) ?? 0 };
  });
}

function perDay(model: mongoose.Model<never>, match: Record<string, unknown>) {
  return model.aggregate<{ _id: string; count: number }>([
    { $match: match },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } },
  ]);
}

export interface MoneyByCurrency {
  currency: string;
  amount: number;
  count: number;
}

/**
 * Money is never merged across verification levels:
 * - `providerSubscriptions`: subscription payments recorded from a signed
 *   provider webhook with a provider other than "manual".
 * - `manualSubscriptions`: sandbox/manual activations. NOT real revenue.
 * - `onlineOrders`: storefront orders paid online and confirmed with Razorpay.
 *   The money belongs to each business (their own Razorpay account).
 * - `codOrders`: cash-on-delivery orders the business owner marked paid.
 *   Owner-attested; no provider verification. Also the business's money.
 */
export interface PaymentSummary {
  providerSubscriptions: MoneyByCurrency[];
  manualSubscriptions: MoneyByCurrency[];
  onlineOrders: MoneyByCurrency[];
  codOrders: MoneyByCurrency[];
}

function moneyRows(rows: Array<{ _id: unknown; amount: number; count: number }>): MoneyByCurrency[] {
  return rows
    .map((r) => ({ currency: String(r._id ?? "—"), amount: Math.round(r.amount * 100) / 100, count: r.count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export interface PlatformOverview {
  range: { from: string; to: string; days: number };
  totals: {
    businesses: Record<string, number>;
    users: { total: number; superAdmins: number; inactive: number };
    customerAccounts: number;
    products: Record<string, number>;
    orders: Record<string, number>;
    subscriptions: Record<string, number>;
  };
  inRange: {
    newBusinesses: number;
    newUsers: number;
    orders: number;
    payments: PaymentSummary;
  };
  series: {
    businesses: Array<{ day: string; count: number }>;
    orders: Array<{ day: string; count: number }>;
  };
  alerts: Array<{ kind: string; severity: "warning" | "critical"; count: number; message: string; href: string }>;
  recentActivity: Array<{ id: string; action: string; targetType: string; targetId: string; targetLabel: string; actorName: string; createdAt: Date }>;
  recentBusinesses: Array<{ id: string; name: string; subdomain: string; status: string; createdAt: Date }>;
}

export async function getPlatformOverview(range: DateRange): Promise<PlatformOverview> {
  await dbConnect();
  const inRange = { createdAt: { $gte: range.from, $lt: range.to } };
  const group = (field: string) => [{ $group: { _id: `$${field}`, count: { $sum: 1 } } }];
  const money = (match: Record<string, unknown>, amountField: string, currencyField: string) => [
    { $match: match },
    { $group: { _id: { $toUpper: { $ifNull: [`$${currencyField}`, "—"] } }, amount: { $sum: `$${amountField}` }, count: { $sum: 1 } } },
  ];
  const paidInRange = { $gte: range.from, $lt: range.to };

  const [
    businessStatus, users, superAdmins, inactiveUsers, customerAccounts, productStatus, orderStatus, subscriptionStatus,
    newBusinesses, newUsers, ordersInRange,
    providerSubs, manualSubs, onlineOrders, codOrders,
    businessSeries, orderSeries,
    pastDue, suspended, needsReview, publishedWithoutPlan,
    recentAudit, recentBusinesses,
  ] = await Promise.all([
    Business.aggregate(group("status")),
    User.countDocuments(),
    User.countDocuments({ platformRole: "super_admin" }),
    User.countDocuments({ active: false }),
    Customer.countDocuments(),
    Product.aggregate(group("status")),
    Order.aggregate(group("status")),
    Subscription.aggregate(group("status")),
    Business.countDocuments(inRange),
    User.countDocuments(inRange),
    Order.countDocuments(inRange),
    Payment.aggregate(money({ status: "succeeded", provider: { $ne: "manual" }, paidAt: paidInRange }, "amount", "currency")),
    Payment.aggregate(money({ status: "succeeded", provider: "manual", paidAt: paidInRange }, "amount", "currency")),
    Order.aggregate(money({ status: { $in: ["paid", "refunded"] }, paymentMethod: "online", paidAt: paidInRange }, "total", "currency")),
    Order.aggregate(money({ status: { $in: ["paid", "refunded"] }, paymentMethod: "cod", paidAt: paidInRange }, "total", "currency")),
    perDay(Business as unknown as mongoose.Model<never>, inRange),
    perDay(Order as unknown as mongoose.Model<never>, inRange),
    Subscription.countDocuments({ status: "past_due" }),
    Business.countDocuments({ status: "suspended" }),
    OrderPayment.countDocuments({ orderOutcome: "needs_review" }),
    countPublishedWithoutPlan(),
    AdminAuditLog.find().sort({ _id: -1 }).limit(8).populate({ path: "actor", select: "name", model: User }).lean(),
    Business.find().sort({ createdAt: -1 }).limit(5).select("name subdomain status createdAt").lean(),
  ]);

  const [security, openDisputes] = await Promise.all([
    getSecuritySummary(),
    PaymentDispute.countDocuments({ status: { $in: OPEN_DISPUTE_STATUSES } }),
  ]);
  const alerts: PlatformOverview["alerts"] = [];
  if (security.adminReauthFailures24h > 0) {
    alerts.push({ kind: "admin_reauth_failed", severity: "critical", count: security.adminReauthFailures24h, href: "/admin/security?type=admin_reauth_failed",
      message: "Failed super-admin password confirmations in the last 24 hours." });
  }
  if (security.targetedAccounts.length > 0) {
    alerts.push({ kind: "targeted_accounts", severity: "warning", count: security.targetedAccounts.length, href: "/admin/security",
      message: "Accounts with repeated failed sign-ins in the last hour." });
  }
  if (needsReview > 0) {
    alerts.push({ kind: "payment_needs_review", severity: "critical", count: needsReview, href: "/admin/payments?domain=order&review=1",
      message: "Online payments confirmed by Razorpay that could not be applied to their order (the business must refund or fulfil)." });
  }
  if (openDisputes > 0) {
    alerts.push({ kind: "open_disputes", severity: "warning", count: openDisputes, href: "/admin/payments?domain=dispute&status=open_any",
      message: "Payment disputes reported by Razorpay are open (the business must respond in Razorpay)." });
  }
  if (pastDue > 0) {
    alerts.push({ kind: "subscription_past_due", severity: "warning", count: pastDue, href: "/admin/businesses?subscription=past_due",
      message: "Subscriptions are past due." });
  }
  if (publishedWithoutPlan > 0) {
    alerts.push({ kind: "published_without_plan", severity: "warning", count: publishedWithoutPlan, href: "/admin/businesses?status=published&entitled=0",
      message: "Published businesses have no plan access, so their storefronts are offline." });
  }
  if (suspended > 0) {
    alerts.push({ kind: "suspended", severity: "warning", count: suspended, href: "/admin/businesses?status=suspended",
      message: "Businesses are suspended." });
  }

  return {
    range: { from: toIsoDay(range.from), to: toIsoDay(new Date(range.to.getTime() - DAY_MS)), days: range.days },
    totals: {
      businesses: countBy(businessStatus, BUSINESS_STATUSES),
      users: { total: users, superAdmins, inactive: inactiveUsers },
      customerAccounts,
      products: countBy(productStatus, ["draft", "active", "archived"]),
      orders: countBy(orderStatus, ["pending", "paid", "cancelled", "refunded"]),
      subscriptions: countBy(subscriptionStatus, SUBSCRIPTION_STATUSES),
    },
    inRange: {
      newBusinesses,
      newUsers,
      orders: ordersInRange,
      payments: {
        providerSubscriptions: moneyRows(providerSubs),
        manualSubscriptions: moneyRows(manualSubs),
        onlineOrders: moneyRows(onlineOrders),
        codOrders: moneyRows(codOrders),
      },
    },
    series: { businesses: dailySeries(businessSeries, range), orders: dailySeries(orderSeries, range) },
    alerts,
    recentActivity: recentAudit.map((entry) => {
      const actor = entry.actor as unknown as { name?: string } | null;
      return {
        id: String(entry._id), action: entry.action, targetType: entry.targetType, targetId: entry.targetId,
        targetLabel: entry.targetLabel, actorName: actor?.name ?? "", createdAt: entry.createdAt,
      };
    }),
    recentBusinesses: recentBusinesses.map((b) => ({ id: String(b._id), name: b.name, subdomain: b.subdomain, status: b.status, createdAt: b.createdAt as Date })),
  };
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export const ADMIN_BUSINESS_SORTS = ["newest", "oldest", "name"] as const;

export const businessQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  status: z.enum(BUSINESS_STATUSES).optional().catch(undefined),
  subscription: z.enum(SUBSCRIPTION_STATUSES).optional().catch(undefined),
  /** Actual feature access: a plan that grants access now, and not suspended. */
  entitled: z.enum(["0", "1"]).optional().catch(undefined),
  /** Whether publishing would be allowed (lib/store-access.ts). */
  publishable: z.enum(["0", "1"]).optional().catch(undefined),
  /** A plan key, matched against each business's latest subscription. */
  plan: z.string().trim().toLowerCase().max(40).optional().catch(undefined),
  /** Whether the business has a custom domain set. */
  domain: z.enum(["yes", "no"]).optional().catch(undefined),
  sort: z.enum(ADMIN_BUSINESS_SORTS).prefault("newest").catch("newest"),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type BusinessQuery = z.infer<typeof businessQuerySchema>;

export interface AdminBusinessRow {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  category: string;
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
  lastOrderAt: Date | null;
  owner: { name: string; email: string } | null;
  plan: { name: string; key: string } | null;
  /** The stored status. Read `access` for what it means now. */
  subscriptionStatus: string | null;
  /** An active or trialing paid subscription past its period end. */
  subscriptionExpired: boolean;
  graceUntil: Date | null;
  provider: string | null;
  /** A paid plan set by hand while manual billing is off. It still counts until it ends. */
  manualPlanNowDisabled: boolean;
  /** Set, but this plan does not include custom domains, so it does not serve the store. */
  domainNotInPlan: boolean;
  entitled: boolean;
  access: StoreAccess;
  productCount: number;
  orderCount: number;
}

/**
 * Latest subscription of the given businesses, with its plan and whether it
 * grants access now. `entitled` comes from the rule `getEntitlements` uses (lib/billing.ts),
 * so a period that ran out and a grace period read the same here as everywhere else.
 */
async function latestSubscriptions(businessIds: unknown[], now: Date = new Date()) {
  const rows = await Subscription.aggregate<{ _id: unknown; status: SubscriptionStatus; plan: unknown; provider?: string | null; graceUntil?: Date | null; currentPeriodEnd: Date | null; createdAt: Date }>([
    { $match: { business: { $in: businessIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$business", status: { $first: "$status" }, plan: { $first: "$plan" }, provider: { $first: "$provider" }, graceUntil: { $first: "$graceUntil" }, currentPeriodEnd: { $first: "$currentPeriodEnd" }, createdAt: { $first: "$createdAt" } } },
  ]);
  const plans = await Plan.find({ _id: { $in: rows.map((r) => r.plan) } }).select("name key price features.customDomain").lean();
  const planById = new Map(plans.map((p) => [String(p._id), p]));
  return new Map(
    rows.map((r) => {
      const plan = planById.get(String(r.plan)) ?? null;
      const graceUntil = r.graceUntil ? new Date(r.graceUntil) : null;
      const periodEnd = r.currentPeriodEnd ? new Date(r.currentPeriodEnd) : null;
      const entitled = plan !== null && isEntitlingSubscription(r.status, periodEnd, plan.price, now, { provider: r.provider, graceUntil });
      return [String(r._id), { ...r, plan, entitled, expired: plan !== null && isExpiredPaidSubscription(r.status, periodEnd, plan.price, now), inGrace: entitled && r.status === "past_due" ? graceUntil : null }];
    }),
  );
}

/** Published businesses with no plan access are offline to shoppers (storefront gate) even though they look published. */
async function countPublishedWithoutPlan(): Promise<number> {
  const cursor = Business.find({ status: "published" }).select("_id").lean().cursor({ batchSize: SCAN_BATCH });
  let count = 0;
  let batch: unknown[] = [];
  const flush = async () => {
    const latest = await latestSubscriptions(batch);
    count += batch.filter((id) => !latest.get(String(id))?.entitled).length;
    batch = [];
  };
  for await (const business of cursor) {
    batch.push(business._id);
    if (batch.length === SCAN_BATCH) await flush();
  }
  if (batch.length > 0) await flush();
  return count;
}

const SCAN_BATCH = 200;
/** How many stores one search looks through when access has to be worked out for each. */
const SCAN_LIMIT = 20_000;
const NARROW_LIMIT = 5_000;

/**
 * Stores whose subscriptions could match, when that is a short enough list to use. They are
 * still checked against each store's LATEST subscription afterwards. A common status or plan
 * gives no short list, and does not need one: a page of matches turns up quickly.
 */
async function storesWithSubscriptionLike(query: BusinessQuery): Promise<unknown[] | null> {
  const where: Record<string, unknown> = {};
  if (query.subscription) where.status = query.subscription;
  if (query.plan) {
    const plan = await Plan.findOne({ key: query.plan }).select("_id").lean();
    if (!plan) return [];
    where.plan = plan._id;
  }
  if (Object.keys(where).length === 0) return null;
  const rows = await Subscription.find(where).select("business").limit(NARROW_LIMIT + 1).lean();
  return rows.length > NARROW_LIMIT ? null : [...new Set(rows.map((row) => String(row.business)))].map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * Access is decided by the rule in lib/billing.ts, which runs here and not in the database, so a
 * second copy of it never has to be kept in step. Stores are looked through in order, in batches,
 * with lookups for that batch only, and stop once this page is full and one more match proves
 * there is a next page. So `total` is known only when the search reached the end.
 */
async function findStoresByAccess(filter: Record<string, unknown>, sort: Record<string, 1 | -1>, query: BusinessQuery) {
  const from = (query.page - 1) * PAGE_SIZE;
  const ids: unknown[] = [];
  let matched = 0;
  let scanned = 0;
  let hasMore = false;
  let capped = false;
  let batch: Array<{ _id: unknown; status: string; themeSettings?: { navigation?: unknown } | null }> = [];

  /** True once there is enough. */
  const settle = async (): Promise<boolean> => {
    const subs = await latestSubscriptions(batch.map((store) => store._id));
    const facts = query.publishable ? await getPublishFacts(batch) : null;
    for (const store of batch) {
      const sub = subs.get(String(store._id));
      const published = facts?.get(String(store._id));
      const access = describeStoreAccess({ status: store.status, planAccess: sub?.entitled ?? false, hasEligiblePublisher: published?.hasEligiblePublisher ?? false, navigationValid: published?.navigationValid ?? false });
      if (query.subscription && sub?.status !== query.subscription) continue;
      if (query.plan && sub?.plan?.key !== query.plan) continue;
      if (query.entitled && (query.entitled === "1") !== access.featureAccess) continue;
      if (query.publishable && (query.publishable === "1") !== access.publishEligible) continue;
      if (matched >= from && ids.length < PAGE_SIZE) ids.push(store._id);
      matched += 1;
      if (matched > from + PAGE_SIZE) {
        hasMore = true;
        return true;
      }
    }
    batch = [];
    return false;
  };

  const cursor = Business.find(filter).sort(sort).select(query.publishable ? "status themeSettings.navigation" : "status").lean().cursor({ batchSize: SCAN_BATCH });
  try {
    for await (const store of cursor) {
      scanned += 1;
      batch.push(store as unknown as (typeof batch)[number]);
      if (batch.length === SCAN_BATCH && (await settle())) break;
      if (scanned >= SCAN_LIMIT) {
        capped = true;
        break;
      }
    }
    if (!hasMore && batch.length > 0) await settle();
  } finally {
    await cursor.close().catch(() => undefined);
  }
  return { ids, total: hasMore || capped ? null : matched, hasMore, capped };
}

export async function listAdminBusinesses(query: BusinessQuery) {
  await dbConnect();
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.domain) filter.customDomain = query.domain === "yes" ? { $gt: "" } : { $in: [null, ""] };
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    const owners = await User.find({ $or: [{ email: pattern }, { name: pattern }] }).select("_id").limit(200).lean();
    filter.$or = [{ name: pattern }, { subdomain: pattern }, { customDomain: pattern }, { owner: { $in: owners.map((o) => o._id) } }];
  }
  const sort: Record<string, 1 | -1> =
    query.sort === "name" ? { name: 1, _id: 1 } : query.sort === "oldest" ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
  const FIELDS = "name subdomain customDomain category status createdAt publishedAt owner themeSettings.navigation";

  // Filters on each business's LATEST subscription and what it allows.
  const byAccess = Boolean(query.subscription || query.entitled || query.plan || query.publishable);
  let total: number | null;
  let hasMore: boolean;
  let capped = false;
  let businesses;
  if (byAccess) {
    // What can be decided in the database is decided there first.
    if ((query.entitled === "1" || query.publishable === "1") && !filter.status) filter.status = { $ne: "suspended" };
    const narrowed = await storesWithSubscriptionLike(query);
    if (narrowed) filter._id = { $in: narrowed };
    const found = await findStoresByAccess(filter, sort, query);
    ({ total, hasMore, capped } = found);
    const page = await Business.find({ _id: { $in: found.ids } }).select(FIELDS).populate({ path: "owner", select: "name email", model: User }).lean();
    const position = new Map(found.ids.map((id, index) => [String(id), index]));
    businesses = page.sort((a, b) => (position.get(String(a._id)) ?? 0) - (position.get(String(b._id)) ?? 0));
  } else {
    [total, businesses] = await Promise.all([
      Business.countDocuments(filter),
      Business.find(filter)
        .sort(sort)
        .skip((query.page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .select(FIELDS)
        .populate({ path: "owner", select: "name email", model: User })
        .lean(),
    ]);
    hasMore = query.page * PAGE_SIZE < total;
  }
  const ids = businesses.map((b) => b._id);
  const manualBillingAllowed = isManualBillingAllowed();
  const [subs, productCounts, orderCounts, publishFacts] = await Promise.all([
    latestSubscriptions(ids),
    Product.aggregate<{ _id: unknown; count: number }>([{ $match: { business: { $in: ids }, status: { $ne: "archived" } } }, { $group: { _id: "$business", count: { $sum: 1 } } }]),
    Order.aggregate<{ _id: unknown; count: number; last: Date }>([{ $match: { business: { $in: ids } } }, { $group: { _id: "$business", count: { $sum: 1 }, last: { $max: "$createdAt" } } }]),
    getPublishFacts(businesses as unknown as Array<{ _id: unknown; themeSettings?: { navigation?: unknown } | null }>),
  ]);
  const productsBy = new Map(productCounts.map((r) => [String(r._id), r.count]));
  const ordersBy = new Map(orderCounts.map((r) => [String(r._id), r.count]));
  const lastOrderBy = new Map(orderCounts.map((r) => [String(r._id), r.last]));

  const rows: AdminBusinessRow[] = businesses.map((b) => {
    const owner = b.owner as unknown as { name?: string; email?: string } | null;
    const sub = subs.get(String(b._id));
    const published = publishFacts.get(String(b._id));
    const entitled = sub?.entitled ?? false;
    return {
      id: String(b._id),
      name: b.name,
      subdomain: b.subdomain,
      customDomain: b.customDomain ?? null,
      category: b.category,
      status: b.status,
      createdAt: b.createdAt as Date,
      publishedAt: b.publishedAt ?? null,
      lastOrderAt: lastOrderBy.get(String(b._id)) ?? null,
      owner: owner && owner.email ? { name: owner.name ?? "", email: owner.email } : null,
      plan: sub?.plan ? { name: sub.plan.name, key: sub.plan.key } : null,
      subscriptionStatus: sub?.status ?? null,
      subscriptionExpired: sub?.expired ?? false,
      graceUntil: sub?.inGrace ?? null,
      provider: sub?.provider ?? null,
      manualPlanNowDisabled: !manualBillingAllowed && sub?.provider === "manual" && (sub.plan?.price ?? 0) > 0,
      domainNotInPlan: Boolean(b.customDomain) && sub?.plan?.features?.customDomain !== true,
      entitled,
      access: describeStoreAccess({ status: b.status, planAccess: entitled, hasEligiblePublisher: published?.hasEligiblePublisher ?? false, navigationValid: published?.navigationValid ?? false }),
      productCount: productsBy.get(String(b._id)) ?? 0,
      orderCount: ordersBy.get(String(b._id)) ?? 0,
    };
  });
  return { page: query.page, pageSize: PAGE_SIZE, total, hasMore, capped, businesses: rows };
}

export async function getAdminBusinessDetail(businessId: string) {
  if (!mongoose.isValidObjectId(businessId)) throw new HttpError(404, "Business not found", "not_found");
  await dbConnect();
  const id = new mongoose.Types.ObjectId(businessId);
  const business = await Business.findById(id)
    .select("name subdomain customDomain category status themeId currency codEnabled publishedAt createdAt updatedAt owner themeSettings.navigation")
    .populate({ path: "owner", select: "name email platformRole active", model: User })
    .lean();
  if (!business) throw new HttpError(404, "Business not found", "not_found");

  const [subs, members, productStatus, orderStatus, paidOrders, recentOrders, paymentAccount, audit, customerAccounts, planPayments] = await Promise.all([
    Subscription.find({ business: id }).sort({ createdAt: -1 }).limit(5).populate({ path: "plan", select: "name key price currency interval features", model: Plan }).lean(),
    Membership.find({ business: id }).populate({ path: "user", select: "name email", model: User }).sort({ createdAt: 1 }).lean(),
    Product.aggregate<{ _id: string; count: number }>([{ $match: { business: id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate<{ _id: string; count: number }>([{ $match: { business: id } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate<{ _id: { method: unknown; currency: unknown }; amount: number; count: number }>([
      { $match: { business: id, status: { $in: ["paid", "refunded"] } } },
      { $group: { _id: { method: "$paymentMethod", currency: { $toUpper: { $ifNull: ["$currency", "—"] } } }, amount: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    // No shopper names/emails: order number, money, method and state only.
    Order.find({ business: id }).sort({ createdAt: -1 }).limit(10).select("orderNumber status total currency paymentMethod createdAt paidAt").lean(),
    BusinessPaymentAccount.findOne({ business: id, provider: "razorpay" }).select("provider mode status keyId connectedAt rotatedAt").lean(),
    AdminAuditLog.find({ targetType: "business", targetId: String(id) }).sort({ _id: -1 }).limit(10).populate({ path: "actor", select: "name", model: User }).lean(),
    Customer.countDocuments({ business: id }),
    // What this business has paid SiteForge. Amounts and dates only.
    Payment.aggregate<{ _id: { verified: boolean; currency: string }; amount: number; refunded: number; count: number; last: Date | null }>([
      { $match: { business: id, paymentDomain: { $ne: "order" }, status: { $in: ["succeeded", "refunded"] } } },
      { $group: { _id: { verified: { $ne: ["$provider", "manual"] }, currency: { $toUpper: { $ifNull: ["$currency", "—"] } } }, amount: { $sum: "$amount" }, refunded: { $sum: { $ifNull: ["$refundedAmount", 0] } }, count: { $sum: 1 }, last: { $max: "$paidAt" } } },
    ]),
  ]);

  const owner = business.owner as unknown as { _id?: unknown; name?: string; email?: string; platformRole?: string; active?: boolean } | null;
  const publishFacts = (await getPublishFacts([business as unknown as { _id: unknown; themeSettings?: { navigation?: unknown } | null }])).get(String(business._id));
  const latest = subs[0] as (typeof subs)[number] | undefined;
  const plan = latest?.plan as unknown as { name: string; key: string; price: number; currency: string; interval: string; features: { productLimit: number; staffLimit: number; customDomain: boolean; removeBranding: boolean } } | undefined;
  const activeProducts = productStatus.filter((p) => p._id !== "archived").reduce((n, p) => n + p.count, 0);
  // Same counting as enforcement (lib/billing.ts assertCanAddStaff): every
  // membership except the owner's, whatever its status.
  const staffMembers = Math.max(0, members.length - 1);

  return {
    business: {
      id: String(business._id),
      name: business.name,
      subdomain: business.subdomain,
      customDomain: business.customDomain ?? null,
      category: business.category,
      status: business.status,
      themeId: business.themeId,
      currency: business.currency,
      codEnabled: business.codEnabled === true,
      publishedAt: business.publishedAt ?? null,
      createdAt: business.createdAt as Date,
      updatedAt: (business.updatedAt ?? null) as Date | null,
      owner: owner?.email ? { id: String(owner._id), name: owner.name ?? "", email: owner.email, platformRole: owner.platformRole ?? "user", active: owner.active !== false } : null,
    },
    publishFacts: publishFacts ?? { hasEligiblePublisher: false, navigationValid: false },
    /** Razorpay decides this subscription's plan, so a Super Admin cannot set one (lib/admin/plan-assignment.ts). */
    providerManaged: Boolean(latest && ((latest.provider === "razorpay" && latest.providerSubscriptionId && latest.status !== "canceled") || latest.pendingCheckout)),
    planPayments: planPayments.map((row) => ({ verified: row._id.verified, currency: String(row._id.currency), amount: Math.round(row.amount * 100) / 100, refunded: Math.round(row.refunded * 100) / 100, count: row.count, lastPaidAt: row.last ?? null })),
    subscriptions: subs.map((s) => {
      const p = s.plan as unknown as { name?: string; key?: string } | null;
      return { id: String(s._id), status: s.status, provider: s.provider, plan: p?.name ? { name: p.name, key: p.key ?? "" } : null, currentPeriodStart: s.currentPeriodStart ?? null, currentPeriodEnd: s.currentPeriodEnd ?? null, createdAt: s.createdAt as Date };
    }),
    usage: {
      products: { used: activeProducts, limit: plan?.features.productLimit ?? null },
      staff: { used: staffMembers, limit: plan?.features.staffLimit ?? null },
      customDomain: plan?.features.customDomain ?? false,
    },
    members: members.map((m) => {
      const u = m.user as unknown as { _id?: unknown; name?: string; email?: string } | null;
      return { id: String(m._id), role: m.role, status: m.status, user: u?.email ? { id: String(u._id), name: u.name ?? "", email: u.email } : null };
    }),
    products: countBy(productStatus, ["draft", "active", "archived"]),
    orders: countBy(orderStatus, ["pending", "paid", "cancelled", "refunded"]),
    customerAccounts,
    paidOrders: paidOrders.map((r) => ({ method: r._id.method === "online" || r._id.method === "cod" ? String(r._id.method) : "unknown", currency: String(r._id.currency), amount: Math.round(r.amount * 100) / 100, count: r.count })),
    recentOrders: recentOrders.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, status: o.status, total: o.total, currency: o.currency ?? "", paymentMethod: o.paymentMethod ?? null, createdAt: o.createdAt, paidAt: o.paidAt ?? null })),
    paymentAccount: paymentAccount
      ? { provider: paymentAccount.provider, mode: paymentAccount.mode, status: paymentAccount.status, keyId: paymentAccount.keyId, connectedAt: paymentAccount.connectedAt, rotatedAt: paymentAccount.rotatedAt ?? null }
      : null,
    audit: audit.map((entry) => {
      const actor = entry.actor as unknown as { name?: string } | null;
      return { id: String(entry._id), action: entry.action, reason: entry.reason, before: entry.before, after: entry.after, actorName: actor?.name ?? "", createdAt: entry.createdAt };
    }),
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const userQuerySchema = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  role: z.enum(PLATFORM_ROLES).optional().catch(undefined),
  state: z.enum(["active", "inactive", "unverified"]).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type UserQuery = z.infer<typeof userQuerySchema>;

export async function listAdminUsers(query: UserQuery) {
  await dbConnect();
  const filter: Record<string, unknown> = {};
  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ email: pattern }, { name: pattern }];
  }
  if (query.role) filter.platformRole = query.role;
  if (query.state === "active") filter.active = { $ne: false };
  if (query.state === "inactive") filter.active = false;
  // Explicit null only: a missing value is a grandfathered (verified) account.
  if (query.state === "unverified") filter.emailVerifiedAt = { $type: "null" };

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    // Explicit allowlist: never passwordHash or tokenVersion.
    User.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * PAGE_SIZE).limit(PAGE_SIZE)
      .select("name email platformRole active emailVerifiedAt createdAt").lean(),
  ]);
  const memberships = await Membership.find({ user: { $in: users.map((u) => u._id) } })
    .select("user role status business")
    .populate({ path: "business", select: "name", model: Business })
    .lean();
  const byUser = new Map<string, Array<{ businessId: string; businessName: string; role: string; status: string }>>();
  for (const m of memberships) {
    const b = m.business as unknown as { _id?: unknown; name?: string } | null;
    const list = byUser.get(String(m.user)) ?? [];
    list.push({ businessId: String(b?._id ?? ""), businessName: b?.name ?? "", role: m.role, status: m.status });
    byUser.set(String(m.user), list);
  }
  return {
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
    users: users.map((u) => ({
      id: String(u._id),
      name: u.name,
      email: u.email,
      platformRole: u.platformRole,
      active: u.active !== false,
      emailVerification: u.emailVerifiedAt instanceof Date ? "verified" : u.emailVerifiedAt === null ? "unverified" : "legacy",
      createdAt: u.createdAt as Date,
      memberships: byUser.get(String(u._id)) ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Payments (read-only)
// ---------------------------------------------------------------------------

export const paymentQuerySchema = z.object({
  domain: z.enum(["subscription", "order", "dispute"]).prefault("subscription").catch("subscription"),
  status: z.string().trim().max(20).optional().catch(undefined),
  review: z.enum(["1"]).optional().catch(undefined),
  business: z.string().trim().max(24).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type PaymentQuery = z.infer<typeof paymentQuerySchema>;

export const ORDER_PAYMENT_STATUS_FILTERS = ["created", "paid", "failed", "cancelled"] as const;

export async function listAdminPayments(query: PaymentQuery) {
  await dbConnect();
  const businessFilter = query.business && mongoose.isValidObjectId(query.business)
    ? { business: new mongoose.Types.ObjectId(query.business) }
    : {};
  const skip = (query.page - 1) * PAGE_SIZE;

  if (query.domain === "dispute") {
    const filter: Record<string, unknown> = { ...businessFilter };
    if (query.status === "open_any") filter.status = { $in: OPEN_DISPUTE_STATUSES };
    else if (query.status && (DISPUTE_STATUSES as readonly string[]).includes(query.status)) filter.status = query.status;
    const [total, rows] = await Promise.all([
      PaymentDispute.countDocuments(filter),
      PaymentDispute.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(PAGE_SIZE)
        .select("business order providerDisputeId providerPaymentId amountMinor amountDeductedMinor currency reasonCode phase status respondBy openedAt closedAt lastSyncedAt mode")
        .populate({ path: "business", select: "name subdomain", model: Business })
        .populate({ path: "order", select: "orderNumber status", model: Order })
        .lean(),
    ]);
    return {
      domain: "dispute" as const,
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
      records: rows.map((r) => {
        const b = r.business as unknown as { _id?: unknown; name?: string; subdomain?: string } | null;
        const o = r.order as unknown as { orderNumber?: string; status?: string } | null;
        return {
          id: String(r._id),
          business: b ? { id: String(b._id), name: b.name ?? "", subdomain: b.subdomain ?? "" } : null,
          order: o ? { number: o.orderNumber ?? "", status: o.status ?? "" } : null,
          reference: r.providerDisputeId,
          providerPaymentId: r.providerPaymentId,
          amount: r.amountMinor / 100,
          amountDeducted: r.amountDeductedMinor / 100,
          currency: r.currency,
          reasonCode: r.reasonCode,
          phase: r.phase,
          status: r.status,
          mode: r.mode,
          respondBy: r.respondBy ?? null,
          openedAt: r.openedAt ?? null,
          closedAt: r.closedAt ?? null,
          lastSyncedAt: r.lastSyncedAt,
        };
      }),
    };
  }

  if (query.domain === "order") {
    const filter: Record<string, unknown> = { ...businessFilter };
    if (query.status && (ORDER_PAYMENT_STATUS_FILTERS as readonly string[]).includes(query.status)) filter.status = query.status;
    if (query.review) filter.orderOutcome = "needs_review";
    const [total, rows] = await Promise.all([
      OrderPayment.countDocuments(filter),
      OrderPayment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(PAGE_SIZE)
        .select("business order provider mode providerLinkId providerPaymentId amountMinor currency status orderOutcome outcomeReason paidAt createdAt")
        .populate({ path: "business", select: "name subdomain", model: Business })
        .populate({ path: "order", select: "orderNumber status", model: Order })
        .lean(),
    ]);
    return {
      domain: "order" as const,
      page: query.page,
      pageSize: PAGE_SIZE,
      total,
      records: rows.map((r) => {
        const b = r.business as unknown as { _id?: unknown; name?: string; subdomain?: string } | null;
        const o = r.order as unknown as { orderNumber?: string; status?: string } | null;
        return {
          id: String(r._id),
          business: b ? { id: String(b._id), name: b.name ?? "", subdomain: b.subdomain ?? "" } : null,
          provider: r.provider,
          mode: r.mode,
          reference: r.providerLinkId,
          providerPaymentId: r.providerPaymentId ?? null,
          amount: r.amountMinor / 100,
          currency: r.currency,
          status: r.status,
          orderOutcome: r.orderOutcome ?? null,
          outcomeReason: r.outcomeReason ?? null,
          order: o ? { number: o.orderNumber ?? "", status: o.status ?? "" } : null,
          paidAt: r.paidAt ?? null,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  const filter: Record<string, unknown> = { paymentDomain: { $ne: "order" }, ...businessFilter };
  if (query.status && (PAYMENT_STATUSES as readonly string[]).includes(query.status)) filter.status = query.status;
  const [total, rows] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(PAGE_SIZE)
      .select("business amount currency status provider providerEventId providerPaymentId description paidAt createdAt")
      .populate({ path: "business", select: "name subdomain", model: Business })
      .lean(),
  ]);
  return {
    domain: "subscription" as const,
    page: query.page,
    pageSize: PAGE_SIZE,
    total,
    records: rows.map((r) => {
      const b = r.business as unknown as { _id?: unknown; name?: string; subdomain?: string } | null;
      return {
        id: String(r._id),
        business: b ? { id: String(b._id), name: b.name ?? "", subdomain: b.subdomain ?? "" } : null,
        provider: r.provider,
        /** "manual" records are sandbox activations, not provider-verified money. */
        verified: r.provider !== "manual",
        reference: r.providerPaymentId || r.providerEventId || "",
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        description: r.description ?? "",
        paidAt: r.paidAt ?? null,
        createdAt: r.createdAt as Date,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Audit log (read-only, filtered)
// ---------------------------------------------------------------------------

export const auditQuerySchema = z.object({
  action: z.enum(ADMIN_AUDIT_ACTIONS).optional().catch(undefined),
  targetType: z.enum(ADMIN_AUDIT_TARGET_TYPES).optional().catch(undefined),
  targetId: z.string().trim().max(80).optional().catch(undefined),
  actor: z.string().trim().max(24).optional().catch(undefined),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
  limit: z.coerce.number().int().min(1).max(100).prefault(25).catch(25),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export function auditFilter(query: AuditQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (query.action) filter.action = query.action;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId) filter.targetId = query.targetId;
  if (query.actor && mongoose.isValidObjectId(query.actor)) filter.actor = new mongoose.Types.ObjectId(query.actor);
  if (query.from || query.to) {
    const createdAt: Record<string, Date> = {};
    if (query.from) createdAt.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) createdAt.$lt = new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + DAY_MS);
    filter.createdAt = createdAt;
  }
  return filter;
}
