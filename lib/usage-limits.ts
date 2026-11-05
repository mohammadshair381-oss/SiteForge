import mongoose, { type ClientSession } from "mongoose";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { HttpError } from "@/lib/api";
import { countBillableProducts, getEntitlements, takeUsageTurn, type Entitlements } from "@/lib/billing";
import { THEME_IDS } from "@/lib/constants";
import { dbConnect } from "@/lib/db";
import { formatUsageValue, type UsageKey, type UsageLine } from "@/lib/plan-limits";
import { Business } from "@/models/Business";
import { Media } from "@/models/Media";
import { Membership } from "@/models/Membership";
import { Order } from "@/models/Order";
import { Page } from "@/models/Page";
import { TeamInvitation } from "@/models/TeamInvitation";

/**
 * Current usage against plan limits, in one place (server-only; callers authorise first).
 * The billing page, insights, the Super Admin and these checks all count the same way, as
 * lib/billing.ts enforces products and team members.
 *
 * A limit only ever stops something new. Nothing is deleted, hidden or changed when a plan
 * gets smaller: over a limit, a store keeps everything it has and can still edit it.
 *
 * To hold when requests arrive together, a limit is checked in the same transaction as the
 * write it allows: `withUsageCheck`, or passing a session to the `assert*` functions.
 */
export interface BusinessUsage {
  entitlements: Entitlements;
  lines: UsageLine[];
}

const startOfMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const businessOid = (id: string) => new mongoose.Types.ObjectId(id);

async function storageUsedBytes(businessId: string, session?: ClientSession): Promise<number> {
  // A file still counts until it is really gone from storage.
  const [row] = await Media.aggregate<{ total: number }>([
    { $match: { business: businessOid(businessId), storageDeletedAt: null } },
    { $group: { _id: null, total: { $sum: "$size" } } },
  ]).session(session ?? null);
  return row?.total ?? 0;
}

const countPages = (businessId: string, session?: ClientSession) => Page.countDocuments({ business: businessId, isHome: { $ne: true } }).session(session ?? null);

/** Orders count from when they are placed; a cancelled one gives its place back. */
const countMonthlyOrders = (businessId: string, now: Date, session?: ClientSession) => Order.countDocuments({ business: businessId, createdAt: { $gte: startOfMonth(now) }, status: { $ne: "cancelled" } }).session(session ?? null);

/**
 * Runs a limit check and the write it allows in one transaction, so a refused request leaves
 * nothing behind and requests at the same moment cannot both pass. Both functions can run
 * more than once (`withTransaction` retries on a conflict), so they must only use the session.
 */
export async function withUsageCheck<T>(check: (session: ClientSession) => Promise<void>, work: (session: ClientSession) => PromiseLike<T>): Promise<T> {
  await dbConnect();
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      await check(session);
      result = await work(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

export async function getBusinessUsage(businessId: string, now: Date = new Date()): Promise<BusinessUsage> {
  await dbConnect();
  const entitlements = await getEntitlements(businessId);
  const [products, pages, members, invitations, storage, monthlyOrders, ai, business] = await Promise.all([
    countBillableProducts(businessId),
    countPages(businessId),
    Membership.countDocuments({ business: businessId }),
    TeamInvitation.countDocuments({ business: businessId, status: "pending", expiresAt: { $gt: now } }),
    storageUsedBytes(businessId),
    countMonthlyOrders(businessId, now),
    getAiUsageSummary(businessId, entitlements.aiRequestsPerMonth, now),
    Business.findById(businessId).select("customDomain").lean<{ customDomain?: string | null }>(),
  ]);

  const lines: UsageLine[] = [
    { key: "products", label: "Products", used: products, limit: entitlements.productLimit, unit: "count", atLimit: "You can edit your products, but not add more.", hint: "Archived products do not count." },
    { key: "pages", label: "Pages", used: pages, limit: entitlements.pageLimit, unit: "count", atLimit: "You can edit your pages, but not add more.", hint: "Your homepage does not count." },
    {
      key: "teamMembers",
      label: "Team members",
      used: Math.max(0, members - 1),
      limit: entitlements.staffLimit,
      unit: "count",
      atLimit: "Everyone keeps their access, but you cannot invite more.",
      hint: invitations > 0 ? `Not counting the owner. ${invitations} waiting invitation${invitations === 1 ? " holds a place" : "s hold places"} too.` : "Not counting the owner.",
    },
    { key: "storage", label: "Media storage", used: storage, limit: entitlements.storageBytes, unit: "bytes", atLimit: "Your images stay, but you cannot upload more until you delete some or upgrade." },
    { key: "customDomains", label: "Custom domains", used: business?.customDomain ? 1 : 0, limit: entitlements.customDomain ? 1 : 0, unit: "count", atLimit: entitlements.customDomain ? "A store can use one custom domain." : "Your plan does not include custom domains. A domain you added stays saved, but it does not serve your store until you upgrade." },
    { key: "monthlyOrders", label: "Orders this month", used: monthlyOrders, limit: entitlements.monthlyOrderLimit, unit: "count", atLimit: "New orders are refused until next month or until you upgrade. Existing orders are not affected.", hint: "Restarts on the 1st (UTC)." },
    { key: "themes", label: "Themes available", used: entitlements.themes.length, limit: THEME_IDS.length, unit: "count", atLimit: "", hint: "Your current theme always stays usable." },
    { key: "aiRequests", label: "AI suggestions this month", used: ai.used, limit: entitlements.aiRequestsPerMonth, unit: "count", atLimit: "AI suggestions stop until next month or until you upgrade.", hint: "Restarts on the 1st (UTC)." },
  ];
  return { entitlements, lines };
}

export const usageLine = (usage: BusinessUsage, key: UsageKey) => usage.lines.find((line) => line.key === key) as UsageLine;

/**
 * Creates pages within the plan's limit. With no limit there is nothing to protect, so no
 * transaction is opened and `session` is undefined. That is not a fallback: with a limit, this
 * always uses one, and refuses if the database cannot run it.
 */
export async function withPageCapacity<T>(businessId: string, count: number, work: (session: ClientSession | undefined) => PromiseLike<T>): Promise<T> {
  const { pageLimit } = await getEntitlements(businessId);
  if (pageLimit === null) return work(undefined);
  return withUsageCheck((session) => assertCanAddPages(businessId, count, session), work);
}

/** Records a file within the plan's storage. `session` is undefined when the plan sets no limit. */
export async function withStorageCapacity<T>(businessId: string, addBytes: number, work: (session: ClientSession | undefined) => PromiseLike<T>): Promise<T> {
  const { storageBytes } = await getEntitlements(businessId);
  if (storageBytes === null) return work(undefined);
  return withUsageCheck((session) => assertStorageAvailable(businessId, addBytes, session), work);
}

/** How many more pages this plan has room for. `remaining` is null when it sets no limit. */
export async function getPageAllowance(businessId: string): Promise<{ limit: number | null; used: number; remaining: number | null }> {
  const [{ pageLimit }, used] = await Promise.all([getEntitlements(businessId), countPages(businessId)]);
  return { limit: pageLimit, used, remaining: pageLimit === null ? null : Math.max(0, pageLimit - used) };
}

/**
 * Before creating pages. The homepage and moving a legacy homepage never need this. With a
 * session, it takes the store's turn first, so requests at the same moment cannot both pass.
 */
export async function assertCanAddPages(businessId: string, count = 1, session?: ClientSession): Promise<void> {
  const { pageLimit, planName } = await getEntitlements(businessId);
  if (pageLimit === null) return;
  if (session) await takeUsageTurn(businessId, session);
  const used = await countPages(businessId, session);
  if (used + count > pageLimit) {
    throw new HttpError(402, `Your ${planName} plan allows up to ${pageLimit} pages, and you have ${used}. Your pages are safe; upgrade to add more.`, "limit_reached");
  }
}

export async function getStorageUsage(businessId: string): Promise<{ usedBytes: number; limitBytes: number | null }> {
  const [{ storageBytes }, usedBytes] = await Promise.all([getEntitlements(businessId), storageUsedBytes(businessId)]);
  return { usedBytes, limitBytes: storageBytes };
}

/** Before an upload, and again with a session as the file is recorded. Deleting files frees the space straight away. */
export async function assertStorageAvailable(businessId: string, addBytes: number, session?: ClientSession): Promise<void> {
  const { storageBytes, planName } = await getEntitlements(businessId);
  if (storageBytes === null) return;
  if (session) await takeUsageTurn(businessId, session);
  const used = await storageUsedBytes(businessId, session);
  if (used + addBytes > storageBytes) {
    throw new HttpError(402, `Your ${planName} plan includes ${formatUsageValue(storageBytes, "bytes")} of media storage, and you have used ${formatUsageValue(used, "bytes")}. Delete unused images or upgrade to upload more.`, "storage_limit_reached");
  }
}

/**
 * Before placing an order, for plans that set a monthly limit. Shoppers are told only that
 * the store cannot take orders now: its plan is not their concern. With a session it is
 * exact, inside the order's own transaction. `alreadyCounted` is the order that transaction
 * has itself just inserted, if any, so it does not count against itself.
 */
export async function assertCanAcceptOrder(businessId: string, options: { session?: ClientSession; alreadyCounted?: number; now?: Date } = {}): Promise<void> {
  const { monthlyOrderLimit } = await getEntitlements(businessId);
  if (monthlyOrderLimit === null) return;
  if (options.session) await takeUsageTurn(businessId, options.session);
  const used = await countMonthlyOrders(businessId, options.now ?? new Date(), options.session);
  if (used - (options.alreadyCounted ?? 0) >= monthlyOrderLimit) {
    throw new HttpError(403, "This store can't take new orders right now. Please try again later.", "store_order_limit");
  }
}
