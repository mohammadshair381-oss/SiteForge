import mongoose from "mongoose";
import { runAfterResponse } from "@/lib/after-response";
import { dbConnect } from "@/lib/db";
import {
  dashboardBase,
  disputeOpenedEvent,
  domainEvents,
  monthKey,
  orderCancelledEvent,
  orderDeliveryEvent,
  orderPaidEvent,
  orderPlacedEvent,
  paymentFailedEvent,
  refundEvent,
  stockEvents,
  storeStatusEvents,
  subscriptionEvents,
  teamAcceptedEvent,
  writeNotifications,
  type NotificationEvent,
} from "@/lib/notification-events";
import { isOverLimit } from "@/lib/plan-limits";
import { isFeatureReady } from "@/lib/required-indexes";
import { getBusinessUsage, usageLine } from "@/lib/usage-limits";
import { Business } from "@/models/Business";
import { Notification, type NotificationDoc, type NotificationKind, type NotificationRole, type NotificationSeverity } from "@/models/Notification";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { OrderRefund } from "@/models/OrderRefund";
import { PaymentDispute } from "@/models/PaymentDispute";
import { TeamInvitation } from "@/models/TeamInvitation";

/**
 * Reading a store's notification centre, and catching up (server-only; callers authorise
 * first). Events are created as they happen (lib/notification-events.ts). That work is not a
 * durable queue, so while someone has the dashboard open, every few minutes per store, the same
 * events are worked out again from stored records. Each has a fixed key, so nothing is listed
 * twice. This also covers what nothing announces, such as an order whose stock hold ran out, a
 * dispute, or a plan limit being reached.
 *
 * The cursor (`notificationsSyncedAt`) only moves once a look has fully succeeded, so a crash or
 * failed read just means looking again. A lease stops two requests doing it at once. A look that
 * finds more than one batch moves the cursor to where it got to, and the next continues from there.
 */
const SYNC_GAP_MS = 5 * 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
/** Looks back slightly further than the cursor, for work that committed just as the last look ran. */
const OVERLAP_MS = 2 * 60 * 1000;
const FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const ORDER_BATCH = 200;
const BATCH = 50;
const PAGE_SIZE = 30;

interface CatchUp {
  events: NotificationEvent[];
  /** Set when a batch was full: everything up to here was covered, and there may be more. */
  coveredTo: Date | null;
}

const earliest = (dates: Array<Date | null>): Date | null => dates.filter((date): date is Date => date !== null).reduce<Date | null>((min, date) => (!min || date < min ? date : min), null);
const coveredBy = (rows: Array<Record<string, unknown>>, limit: number, field: string): Date | null => (rows.length === limit ? new Date(rows[rows.length - 1][field] as Date) : null);

async function orderCatchUp(businessId: string, since: Date, base: string): Promise<CatchUp> {
  const business = new mongoose.Types.ObjectId(businessId);
  // One read: every change to an order moves its `updatedAt`, oldest first so nothing is skipped.
  const [orders, refunds, failures, disputes] = await Promise.all([
    Order.find({ business, updatedAt: { $gte: since } }).sort({ updatedAt: 1 }).limit(ORDER_BATCH).select("orderNumber total currency paymentMethod items.quantity createdAt updatedAt paidAt cancelledAt cancelReason shippedAt deliveredAt").lean(),
    OrderRefund.find({ business, updatedAt: { $gte: since }, status: { $in: ["processed", "failed"] } }).sort({ updatedAt: 1 }).limit(BATCH).select("order status amount currency processedAt updatedAt").lean(),
    OrderPayment.find({ business, lastFailureAt: { $gte: since } }).sort({ lastFailureAt: 1 }).limit(BATCH).select("order lastFailureAt").lean(),
    PaymentDispute.find({ business, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(BATCH).select("order createdAt").lean(),
  ]);
  const inWindow = (value: Date | null | undefined) => Boolean(value && new Date(value) >= since);
  const events: NotificationEvent[] = [];
  for (const order of orders) {
    if (inWindow(order.createdAt)) events.push(orderPlacedEvent(order, base));
    if (inWindow(order.paidAt)) events.push(orderPaidEvent(order, base));
    if (inWindow(order.cancelledAt)) events.push(orderCancelledEvent(order, base));
    if (inWindow(order.shippedAt)) events.push(orderDeliveryEvent(order, "shipped", base));
    if (inWindow(order.deliveredAt)) events.push(orderDeliveryEvent(order, "delivered", base));
  }
  const related = await Order.find({ _id: { $in: [...refunds.map((r) => r.order), ...failures.map((f) => f.order), ...disputes.map((d) => d.order)].filter(Boolean) }, business }).select("orderNumber").lean();
  const numberOf = new Map(related.map((order) => [String(order._id), order.orderNumber]));
  for (const refund of refunds) {
    const number = numberOf.get(String(refund.order));
    const event = number ? refundEvent(refund, number, base) : null;
    if (event) events.push(event);
  }
  for (const failure of failures) {
    const number = numberOf.get(String(failure.order));
    if (number && failure.lastFailureAt) events.push(paymentFailedEvent({ _id: failure._id, lastFailureAt: failure.lastFailureAt }, number, base));
  }
  for (const dispute of disputes) {
    const number = numberOf.get(String(dispute.order));
    if (number) events.push(disputeOpenedEvent(dispute, number, base));
  }
  return {
    events,
    coveredTo: earliest([
      coveredBy(orders as unknown as Array<Record<string, unknown>>, ORDER_BATCH, "updatedAt"),
      coveredBy(refunds as unknown as Array<Record<string, unknown>>, BATCH, "updatedAt"),
      coveredBy(failures as unknown as Array<Record<string, unknown>>, BATCH, "lastFailureAt"),
      coveredBy(disputes as unknown as Array<Record<string, unknown>>, BATCH, "createdAt"),
    ]),
  };
}

/** The state of things now. Keys include the week or month, so a problem repeats at most that often. */
async function stateCatchUp(businessId: string, since: Date, now: Date, base: string): Promise<CatchUp> {
  const usage = await getBusinessUsage(businessId, now);
  const events: NotificationEvent[] = [
    ...(await stockEvents(businessId, now)),
    // Usage has already read these, so they are not read again.
    ...(await subscriptionEvents(businessId, now, usage.entitlements)),
    ...(usageLine(usage, "customDomains").used > 0 ? await domainEvents(businessId, now) : []),
  ];
  for (const line of usage.lines) {
    if (line.key === "themes" || line.limit === null || line.limit === 0) continue;
    if (isOverLimit(line) || (line.key === "monthlyOrders" && line.used >= line.limit)) {
      events.push({ dedupeKey: `usage:${line.key}:${monthKey(now)}`, kind: "usage", severity: "warning", title: `${line.label}: your plan's limit is reached`, body: line.atLimit, link: `${base}/billing`, audience: ["owner"], occurredAt: now });
    }
  }
  const store = await Business.findById(businessId).select("status publishedAt statusChangedAt").lean<{ status: string; publishedAt?: Date | null; statusChangedAt?: Date | null }>();
  if (store) {
    events.push(...storeStatusEvents(store, base, now));
    if (store.status === "published" && store.publishedAt && new Date(store.publishedAt) >= since) {
      events.push({ dedupeKey: `store:published:${new Date(store.publishedAt).getTime()}`, kind: "store", severity: "success", title: "Your store is live", body: "It was published and shoppers can now visit it.", link: base, audience: ["owner", "manager"], occurredAt: new Date(store.publishedAt) });
    }
  }
  return { events, coveredTo: null };
}

async function teamCatchUp(businessId: string, since: Date, base: string): Promise<CatchUp> {
  const invitations = await TeamInvitation.find({ business: businessId, acceptedAt: { $gte: since } }).sort({ acceptedAt: 1 }).limit(BATCH).select("email acceptedAt").lean();
  return { events: invitations.map((invitation) => teamAcceptedEvent(invitation, base)), coveredTo: coveredBy(invitations as unknown as Array<Record<string, unknown>>, BATCH, "acceptedAt") };
}

/** Saves asking the database again and again on an instance that has just asked. */
const lastAttempt = new Map<string, number>();
function attemptedRecently(businessId: string, nowMs: number): boolean {
  const last = lastAttempt.get(businessId);
  if (last !== undefined && nowMs - last < 60 * 1000) return true;
  if (lastAttempt.size > 5000) lastAttempt.clear();
  lastAttempt.set(businessId, nowMs);
  return false;
}

/** Only one request per store does this at a time. Never throws: a list can always be shown. */
export async function syncBusinessNotifications(businessId: string, now: Date = new Date()): Promise<void> {
  if (attemptedRecently(businessId, now.getTime())) return;
  try {
    const previous = await Business.findOneAndUpdate(
      {
        _id: businessId,
        $and: [
          { $or: [{ notificationsSyncedAt: null }, { notificationsSyncedAt: { $lte: new Date(now.getTime() - SYNC_GAP_MS) } }] },
          { $or: [{ notificationsSyncLeaseUntil: null }, { notificationsSyncLeaseUntil: { $lte: now } }] },
        ],
      },
      { $set: { notificationsSyncLeaseUntil: new Date(now.getTime() + LEASE_MS) } },
      { timestamps: false },
    )
      .select("notificationsSyncedAt")
      .lean<{ notificationsSyncedAt?: Date | null }>();
    if (!previous) return;

    const cursor = previous.notificationsSyncedAt ? new Date(previous.notificationsSyncedAt) : null;
    const oldest = now.getTime() - MAX_LOOKBACK_MS;
    const since = new Date(Math.max(cursor ? cursor.getTime() - OVERLAP_MS : now.getTime() - FIRST_LOOKBACK_MS, oldest));
    const base = dashboardBase(businessId);
    // Separately, so a problem with one kind of event does not lose the others.
    const groups = await Promise.allSettled([orderCatchUp(businessId, since, base), stateCatchUp(businessId, since, now, base), teamCatchUp(businessId, since, base)]);
    const done = groups.flatMap((group) => (group.status === "fulfilled" ? [group.value] : []));
    await writeNotifications(businessId, done.flatMap((group) => group.events), now);
    if (done.length < groups.length) {
      // The cursor stays put and the lease runs out by itself, so the next look covers this again.
      console.error("[notifications] some events could not be read");
      return;
    }
    const coveredTo = earliest(done.map((group) => group.coveredTo));
    // More than a whole batch inside the overlap would never move on, so that case moves to now.
    const next = coveredTo && (!cursor || coveredTo > cursor) ? coveredTo : now;
    await Business.updateOne({ _id: businessId }, { $set: { notificationsSyncedAt: next, notificationsSyncLeaseUntil: null } }, { timestamps: false });
  } catch {
    console.error("[notifications] could not be updated");
  }
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  link: string;
  occurredAt: string;
  read: boolean;
}

export interface NotificationPage {
  ready: boolean;
  notifications: NotificationView[];
  unread: number;
  page: number;
  hasMore: boolean;
}

function toView(notification: NotificationDoc, userId: string): NotificationView {
  return {
    id: String(notification._id),
    kind: notification.kind,
    severity: notification.severity,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    occurredAt: new Date(notification.occurredAt).toISOString(),
    read: (notification.readBy ?? []).some((id) => String(id) === userId),
  };
}

/** For the bell: only the count, with any catching up done after the response. */
export async function getNotificationSummary(input: { businessId: string; userId: string; role: NotificationRole }): Promise<{ ready: boolean; unread: number }> {
  if (!(await isFeatureReady("notifications"))) return { ready: false, unread: 0 };
  await dbConnect();
  const unread = await Notification.countDocuments({ business: new mongoose.Types.ObjectId(input.businessId), audience: input.role, readBy: { $ne: new mongoose.Types.ObjectId(input.userId) } });
  runAfterResponse(() => syncBusinessNotifications(input.businessId), { operation: "notification_sync", onError: () => console.error("[notifications] could not be updated") });
  return { ready: true, unread };
}

export async function listNotifications(input: { businessId: string; userId: string; role: NotificationRole; page?: number; unreadOnly?: boolean; kind?: NotificationKind }): Promise<NotificationPage> {
  const page = Math.max(input.page ?? 1, 1);
  if (!(await isFeatureReady("notifications"))) return { ready: false, notifications: [], unread: 0, page, hasMore: false };
  await dbConnect();
  await syncBusinessNotifications(input.businessId);
  const user = new mongoose.Types.ObjectId(input.userId);
  const visible = { business: new mongoose.Types.ObjectId(input.businessId), audience: input.role };
  const where = { ...visible, ...(input.unreadOnly ? { readBy: { $ne: user } } : {}), ...(input.kind ? { kind: input.kind } : {}) };
  const [rows, unread] = await Promise.all([
    Notification.find(where).sort({ occurredAt: -1, _id: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean<NotificationDoc[]>(),
    Notification.countDocuments({ ...visible, readBy: { $ne: user } }),
  ]);
  return { ready: true, notifications: rows.slice(0, PAGE_SIZE).map((row) => toView(row, input.userId)), unread, page, hasMore: rows.length > PAGE_SIZE };
}

/** Marks some, or all, as read for this person only. Others keep their own state. */
export async function markNotificationsRead(input: { businessId: string; userId: string; role: NotificationRole; ids?: string[] }): Promise<void> {
  if (!(await isFeatureReady("notifications"))) return;
  await dbConnect();
  const ids = input.ids?.filter((id) => /^[a-f0-9]{24}$/i.test(id));
  await Notification.updateMany(
    { business: new mongoose.Types.ObjectId(input.businessId), audience: input.role, ...(ids ? { _id: { $in: ids } } : {}) },
    { $addToSet: { readBy: new mongoose.Types.ObjectId(input.userId) } },
  );
}
