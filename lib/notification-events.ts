import mongoose from "mongoose";
import { runAfterResponse } from "@/lib/after-response";
import { getEntitlements, type Entitlements } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { domainHealth, DOMAIN_WARNING_TEXT } from "@/lib/domains/health";
import { formatPrice } from "@/lib/format";
import { LOW_STOCK_DEFAULT, lowStockLevel } from "@/lib/inventory-rules";
import { isFeatureReady } from "@/lib/required-indexes";
import { Business } from "@/models/Business";
import { DomainVerification, domainOwnershipExpiry, domainStatusOf, isDomainOwnershipFresh, type DomainVerificationDoc } from "@/models/DomainVerification";
import { Notification, type NotificationKind, type NotificationRole, type NotificationSeverity } from "@/models/Notification";
import { Order } from "@/models/Order";
import { OrderPayment } from "@/models/OrderPayment";
import { OrderRefund } from "@/models/OrderRefund";
import { Product } from "@/models/Product";
import { Subscription } from "@/models/Subscription";
import { TeamInvitation } from "@/models/TeamInvitation";

/**
 * The one place store notifications are created (server-only). Each `notify*` function is
 * called after the change it describes has been committed, and does its work after the
 * response. It never throws and never changes an order, a payment or an API answer. In-app
 * only: nothing here sends an email.
 *
 * An event's `dedupeKey` is fixed by what happened, so the same event is listed once however
 * many times it is reported (the unique index on `{ business, dedupeKey }`). After-response
 * work is not a durable queue, so `lib/notifications.ts` builds the same events from stored
 * records as a catch-up, using the same functions and keys below.
 */
const OWNER: NotificationRole[] = ["owner"];
const MANAGERS: NotificationRole[] = ["owner", "manager"];
const EVERYONE: NotificationRole[] = ["owner", "manager", "staff"];

export interface NotificationEvent {
  dedupeKey: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body?: string;
  link: string;
  audience: NotificationRole[];
  occurredAt: Date;
}

export const dashboardBase = (businessId: string) => `/dashboard/businesses/${businessId}`;
const orderLink = (base: string, number: string) => `${base}/orders?order=${number}`;
const shortDate = (value: Date) => value.toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
export const weekKey = (now: Date) => `${now.getUTCFullYear()}-${Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000))}`;
export const monthKey = (now: Date) => now.toISOString().slice(0, 7);

// ---- What each event says. Used by the notify functions and by the catch-up.

interface OrderFacts {
  _id: unknown;
  orderNumber: string;
  total: number;
  currency?: string | null;
  paymentMethod?: string | null;
  items?: Array<{ quantity: number }>;
  createdAt?: Date;
  paidAt?: Date | null;
  cancelledAt?: Date | null;
  cancelReason?: string | null;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
}

export function orderPlacedEvent(order: OrderFacts, base: string): NotificationEvent {
  const units = (order.items ?? []).reduce((sum, item) => sum + item.quantity, 0);
  return {
    dedupeKey: `order:${order._id}:placed`,
    kind: "order",
    severity: "info",
    title: `New order #${order.orderNumber}`,
    body: `${units} ${units === 1 ? "item" : "items"}, ${formatPrice(order.total, order.currency ?? "USD")}${order.paymentMethod === "cod" ? ", cash on delivery" : order.paymentMethod === "online" ? ", waiting for online payment" : ""}.`,
    link: orderLink(base, order.orderNumber),
    audience: MANAGERS,
    occurredAt: new Date(order.createdAt ?? Date.now()),
  };
}

export function orderPaidEvent(order: OrderFacts, base: string): NotificationEvent {
  return {
    dedupeKey: `order:${order._id}:paid`,
    kind: "payment",
    severity: "success",
    title: `Order #${order.orderNumber} is paid`,
    body: `${formatPrice(order.total, order.currency ?? "USD")}${order.paymentMethod === "online" ? ", confirmed by Razorpay" : order.paymentMethod === "cod" ? ", cash on delivery" : ""}.`,
    link: orderLink(base, order.orderNumber),
    audience: MANAGERS,
    occurredAt: new Date(order.paidAt ?? Date.now()),
  };
}

export function orderCancelledEvent(order: OrderFacts, base: string): NotificationEvent {
  return {
    dedupeKey: `order:${order._id}:cancelled`,
    kind: "order",
    severity: "warning",
    title: `Order #${order.orderNumber} was cancelled`,
    body: order.cancelReason === "expired" ? "Its stock hold ended without payment or confirmation, and the items went back on sale." : order.cancelReason === "customer" ? "The customer cancelled it, and the items went back on sale." : "The items went back on sale.",
    link: orderLink(base, order.orderNumber),
    audience: MANAGERS,
    occurredAt: new Date(order.cancelledAt ?? Date.now()),
  };
}

export function orderDeliveryEvent(order: OrderFacts, stage: "shipped" | "delivered", base: string): NotificationEvent {
  return {
    dedupeKey: `order:${order._id}:${stage}`,
    kind: "order",
    severity: stage === "delivered" ? "success" : "info",
    title: `Order #${order.orderNumber} ${stage === "delivered" ? "was delivered" : "has shipped"}`,
    link: orderLink(base, order.orderNumber),
    audience: MANAGERS,
    occurredAt: new Date((stage === "delivered" ? order.deliveredAt : order.shippedAt) ?? Date.now()),
  };
}

const REFUND_TEXT: Record<string, { title: string; severity: NotificationSeverity }> = {
  processed: { title: "Refund completed", severity: "success" },
  failed: { title: "A refund did not go through", severity: "danger" },
};

/** The fields a refund's notification needs: these are what every caller selects. */
export const REFUND_EVENT_FIELDS = "order status amount currency processedAt updatedAt recovery.at lateProviderReport confirmsRecoveryOf";

/**
 * Three different things, never worded alike: Razorpay confirming a refund was made, Razorpay confirming it
 * failed, and the owner releasing the hold of one whose outcome was unknown, which is their statement and not
 * Razorpay's. Whatever Razorpay says about a released refund afterwards is its own notice.
 */
export function refundEvent(
  refund: {
    _id: unknown;
    status: string;
    amount: number;
    currency: string;
    processedAt?: Date | null;
    updatedAt?: Date;
    recovery?: { at: Date } | null;
    lateProviderReport?: { at: Date; outcome: string; providerStatus: string } | null;
    confirmsRecoveryOf?: unknown;
  },
  orderNumber: string,
  base: string,
): NotificationEvent | null {
  const amount = formatPrice(refund.amount, refund.currency);
  const common = { kind: "refund" as const, link: orderLink(base, orderNumber), audience: MANAGERS };
  const late = refund.lateProviderReport;
  if (refund.recovery && late) {
    const text =
      late.outcome === "recorded"
        ? { title: "Razorpay confirmed a refund whose hold was released", severity: "warning" as NotificationSeverity, body: `Razorpay reports that ${amount} on order #${orderNumber} was refunded after all, and it is now recorded. Check that the customer was not refunded twice.` }
        : late.outcome === "provider_failed"
          ? { title: "Razorpay confirmed a refund was not made", severity: "info" as NotificationSeverity, body: `${amount} on order #${orderNumber}: Razorpay confirms what the owner found when releasing its hold.` }
          : { title: "A released refund needs your review", severity: "danger" as NotificationSeverity, body: `Razorpay reported on ${amount} on order #${orderNumber} after its hold was released, and it could not be recorded automatically. Check the order and your Razorpay dashboard.` };
    return { ...common, ...text, dedupeKey: `refund:${refund._id}:late:${late.outcome}:${late.providerStatus}`, occurredAt: new Date(late.at) };
  }
  if (refund.recovery) {
    return {
      ...common,
      dedupeKey: `refund:${refund._id}:recovered`,
      severity: "warning",
      title: "Refund hold manually released by the owner",
      body: `${amount} on order #${orderNumber}. The owner confirmed that Razorpay's dashboard showed no refund at the time. Razorpay never reported a result.`,
      occurredAt: new Date(refund.recovery.at),
    };
  }
  const text = REFUND_TEXT[refund.status];
  if (!text) return null;
  return {
    ...common,
    dedupeKey: `refund:${refund._id}:${refund.status}`,
    severity: text.severity,
    title: refund.status === "processed" && refund.confirmsRecoveryOf ? "Refund completed: confirmed by Razorpay after its hold was released" : text.title,
    body: `${amount} on order #${orderNumber}.`,
    occurredAt: new Date(refund.processedAt ?? refund.updatedAt ?? Date.now()),
  };
}

export function paymentFailedEvent(payment: { _id: unknown; lastFailureAt: Date }, orderNumber: string, base: string): NotificationEvent {
  const at = new Date(payment.lastFailureAt);
  return {
    dedupeKey: `payment:${payment._id}:failed:${at.getTime()}`,
    kind: "payment",
    severity: "warning",
    title: `A payment attempt was declined on order #${orderNumber}`,
    body: "The customer can try again until the order's stock hold ends.",
    link: orderLink(base, orderNumber),
    audience: MANAGERS,
    occurredAt: at,
  };
}

export function disputeOpenedEvent(dispute: { _id: unknown; createdAt: Date }, orderNumber: string, base: string): NotificationEvent {
  return {
    dedupeKey: `dispute:${dispute._id}:opened`,
    kind: "payment",
    severity: "danger",
    title: `Payment dispute on order #${orderNumber}`,
    body: "Razorpay reported a dispute. Respond in your Razorpay dashboard.",
    link: orderLink(base, orderNumber),
    audience: OWNER,
    occurredAt: new Date(dispute.createdAt),
  };
}

export function teamAcceptedEvent(invitation: { _id: unknown; email: string; acceptedAt?: Date | null }, base: string): NotificationEvent {
  return {
    dedupeKey: `team:${invitation._id}:accepted`,
    kind: "team",
    severity: "success",
    title: "A team invitation was accepted",
    body: `${invitation.email} joined your team.`,
    link: `${base}/settings`,
    audience: OWNER,
    occurredAt: new Date(invitation.acceptedAt ?? Date.now()),
  };
}

/** `statusChangedAt` is set only by the Super Admin's suspend and reactivate actions. */
export function storeStatusEvents(store: { status: string; statusChangedAt?: Date | null }, base: string, now: Date): NotificationEvent[] {
  const at = store.statusChangedAt ? new Date(store.statusChangedAt) : null;
  if (store.status === "suspended") {
    return [{ dedupeKey: `store:suspended:${at ? at.getTime() : "earlier"}`, kind: "store", severity: "danger", title: "Your store has been suspended", body: "A platform administrator suspended this store, so it is offline to shoppers.", link: base, audience: MANAGERS, occurredAt: at ?? now }];
  }
  if (store.status === "draft" && at) {
    return [{ dedupeKey: `store:reactivated:${at.getTime()}`, kind: "store", severity: "success", title: "Your store has been reactivated", body: "It is a draft for now. Publish it again when you are ready.", link: `${base}/publish`, audience: MANAGERS, occurredAt: at }];
  }
  return [];
}

export async function stockEvents(businessId: string, now: Date, productIds?: readonly unknown[]): Promise<NotificationEvent[]> {
  const base = dashboardBase(businessId);
  const products = await Product.find({
    business: new mongoose.Types.ObjectId(businessId),
    status: "active",
    ...(productIds ? { _id: { $in: productIds } } : {}),
    $expr: { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", LOW_STOCK_DEFAULT] }] },
  })
    .sort({ stock: 1 })
    .limit(20)
    .select("name stock lowStockThreshold")
    .lean();
  return products.map((product) => {
    const out = product.stock <= 0;
    return {
      dedupeKey: `stock:${product._id}:${out ? "out" : "low"}:${weekKey(now)}`,
      kind: "stock" as const,
      severity: out ? ("danger" as const) : ("warning" as const),
      title: out ? `${product.name} is out of stock` : `${product.name} is running low`,
      body: out ? "Shoppers cannot buy it until you add more." : `${product.stock} left, at or below your alert level of ${lowStockLevel(product.lowStockThreshold)}.`,
      link: `${base}/inventory`,
      audience: EVERYONE,
      occurredAt: now,
    };
  });
}

/** `known` saves reading the entitlements again when the caller already has them. */
export async function subscriptionEvents(businessId: string, now: Date, known?: Entitlements): Promise<NotificationEvent[]> {
  const billing = `${dashboardBase(businessId)}/billing`;
  const [entitlements, subscription] = await Promise.all([
    known ?? getEntitlements(businessId),
    Subscription.findOne({ business: businessId }).sort({ createdAt: -1 }).select("status cancelAtPeriodEnd currentPeriodEnd").lean<{ cancelAtPeriodEnd?: boolean; currentPeriodEnd?: Date | null }>(),
  ]);
  if (entitlements.graceUntil) {
    return [{ dedupeKey: `subscription:grace:${entitlements.graceUntil.toISOString().slice(0, 10)}`, kind: "subscription", severity: "warning", title: "Your last subscription payment failed", body: `Your store keeps its features until ${shortDate(entitlements.graceUntil)}. See what to do on the billing page.`, link: billing, audience: OWNER, occurredAt: now }];
  }
  if (subscription && !entitlements.active) {
    return [{ dedupeKey: `subscription:inactive:${weekKey(now)}`, kind: "subscription", severity: "danger", title: "Your store has no active plan", body: "Your store is offline to shoppers until a plan is active again. Nothing has been deleted.", link: billing, audience: OWNER, occurredAt: now }];
  }
  if (subscription?.cancelAtPeriodEnd && subscription.currentPeriodEnd) {
    const end = new Date(subscription.currentPeriodEnd);
    return [{ dedupeKey: `subscription:ending:${end.toISOString().slice(0, 10)}`, kind: "subscription", severity: "warning", title: "Your subscription is ending", body: `It ends on ${shortDate(end)}. Choose a plan before then to keep your store online.`, link: billing, audience: OWNER, occurredAt: now }];
  }
  return [];
}

/** Problems an owner can act on. Routine reminders stay on the domain's own page. */
export async function domainEvents(businessId: string, now: Date): Promise<NotificationEvent[]> {
  const store = await Business.findById(businessId).select("customDomain").lean<{ customDomain?: string | null }>();
  if (!store?.customDomain) return [];
  const record = await DomainVerification.findOne({ business: businessId, domain: store.customDomain }).select("-tokenHash -renewalTokenHash").lean<DomainVerificationDoc>();
  if (!record) return [];
  const status = domainStatusOf(record);
  const health = domainHealth({ ...record, status, selected: true, ownershipFresh: status === "verified" && isDomainOwnershipFresh(record, now), ownershipExpiresAt: domainOwnershipExpiry(record) }, now);
  if (health.status !== "degraded" && health.status !== "unhealthy") return [];
  return health.warnings
    .filter((warning) => warning !== "check_overdue" && warning !== "not_confirmed" && warning !== "activation_needed")
    .map((warning) => ({
      dedupeKey: `domain:${record.domain}:${warning}:${monthKey(now)}`,
      kind: "domain" as const,
      severity: health.status === "unhealthy" ? ("danger" as const) : ("warning" as const),
      title: `${record.domain} needs attention`,
      body: DOMAIN_WARNING_TEXT[warning],
      link: `${dashboardBase(businessId)}/settings`,
      audience: OWNER,
      occurredAt: now,
    }));
}

// ---- Saving

function logFailure(error: unknown): void {
  console.error(JSON.stringify({ event: "notification_failed", category: error instanceof Error ? error.name : "unknown" }));
}

const isDuplicateKey = (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === 11000);

/** Saves events that are not there yet. Throws if it cannot: the catch-up needs to know. */
export async function writeNotifications(businessId: string, events: readonly NotificationEvent[], now: Date = new Date()): Promise<void> {
  if (events.length === 0) return;
  try {
    await Notification.bulkWrite(
      events.map((event) => ({
        updateOne: {
          filter: { business: new mongoose.Types.ObjectId(businessId), dedupeKey: event.dedupeKey },
          update: { $setOnInsert: { kind: event.kind, severity: event.severity, title: event.title.slice(0, 160), body: (event.body ?? "").slice(0, 400), link: event.link, audience: event.audience, readBy: [], occurredAt: event.occurredAt, createdAt: now } },
          upsert: true,
        },
      })),
      { ordered: false, timestamps: false },
    );
  } catch (error) {
    // Two reports of one event at once: it exists, which is what was wanted.
    if (!isDuplicateKey(error)) throw error;
  }
}

/** Runs after the response. Stays off, building nothing, until the unique index exists. */
function queue(businessId: string, build: (now: Date) => Promise<Array<NotificationEvent | null>>): void {
  try {
    runAfterResponse(
      async () => {
        await dbConnect();
        if (!(await isFeatureReady("notifications"))) return;
        const now = new Date();
        const events = (await build(now)).filter((event): event is NotificationEvent => event !== null);
        await writeNotifications(businessId, events, now);
      },
      { operation: "notification", onError: logFailure },
    );
  } catch (error) {
    logFailure(error);
  }
}

// ---- What the rest of the app calls, after its own work is committed

export type OrderNotification = "placed" | "paid" | "cancelled" | "shipped" | "delivered";

export function notifyOrder(what: OrderNotification, businessId: string, orderId: string): void {
  queue(businessId, async (now) => {
    const order = await Order.findOne({ _id: new mongoose.Types.ObjectId(orderId), business: new mongoose.Types.ObjectId(businessId) })
      .select("orderNumber total currency paymentMethod items.quantity items.product createdAt paidAt cancelledAt cancelReason shippedAt deliveredAt")
      .lean<OrderFacts & { items?: Array<{ quantity: number; product: unknown }> }>();
    if (!order) return [];
    const base = dashboardBase(businessId);
    if (what === "placed") return [orderPlacedEvent(order, base), ...(await stockEvents(businessId, now, (order.items ?? []).map((item) => item.product)))];
    if (what === "paid") return [orderPaidEvent(order, base)];
    if (what === "cancelled") return [orderCancelledEvent(order, base)];
    return [orderDeliveryEvent(order, what, base)];
  });
}

export function notifyRefund(businessId: string, refundId: unknown): void {
  queue(businessId, async () => {
    const refund = await OrderRefund.findOne({ _id: refundId, business: businessId }).select(REFUND_EVENT_FIELDS).lean();
    if (!refund) return [];
    const order = await Order.findOne({ _id: refund.order, business: businessId }).select("orderNumber").lean<{ orderNumber: string }>();
    return order ? [refundEvent(refund, order.orderNumber, dashboardBase(businessId))] : [];
  });
}

export function notifyPaymentFailure(businessId: string, orderId: string): void {
  queue(businessId, async () => {
    const payment = await OrderPayment.findOne({ business: businessId, order: orderId, lastFailureAt: { $ne: null } }).sort({ lastFailureAt: -1 }).select("lastFailureAt").lean<{ _id: unknown; lastFailureAt: Date }>();
    if (!payment) return [];
    const order = await Order.findOne({ _id: orderId, business: businessId }).select("orderNumber").lean<{ orderNumber: string }>();
    return order ? [paymentFailedEvent(payment, order.orderNumber, dashboardBase(businessId))] : [];
  });
}

export function notifyStock(businessId: string, productIds: readonly unknown[]): void {
  queue(businessId, (now) => stockEvents(businessId, now, productIds));
}

export function notifySubscription(businessId: string): void {
  queue(businessId, (now) => subscriptionEvents(businessId, now));
}

export function notifyDomain(businessId: string): void {
  queue(businessId, (now) => domainEvents(businessId, now));
}

export function notifyTeamAccepted(businessId: string, invitationId: unknown): void {
  queue(businessId, async () => {
    const invitation = await TeamInvitation.findOne({ _id: invitationId, business: businessId, status: "accepted" }).select("email acceptedAt").lean();
    return invitation ? [teamAcceptedEvent(invitation, dashboardBase(businessId))] : [];
  });
}

export function notifyStoreStatus(businessId: string): void {
  queue(businessId, async (now) => {
    const store = await Business.findById(businessId).select("status statusChangedAt").lean<{ status: string; statusChangedAt?: Date | null }>();
    return store ? storeStatusEvents(store, dashboardBase(businessId), now) : [];
  });
}
