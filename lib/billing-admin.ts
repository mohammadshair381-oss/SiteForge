import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { describeBillingState, type BillingStateView } from "@/lib/billing-status";
import { BillingAdjustment } from "@/models/BillingAdjustment";
import { BillingEvent } from "@/models/BillingEvent";
import { Business } from "@/models/Business";
import { Payment } from "@/models/Payment";
import { Plan } from "@/models/Plan";
import { Subscription } from "@/models/Subscription";

/**
 * Read-only billing data for the Super Admin (server-only). Callers pass
 * `requireSuperAdmin()` or `requireSuperAdminPage()` first. Only references and
 * states come back: never keys, webhook secrets, checkout links or customer details.
 */
const PAGE_SIZE = 25;

export const BILLING_FILTERS = ["all", "active", "past_due", "halted", "ending", "ended", "attention"] as const;
export const billingQuerySchema = z.object({
  filter: z.enum(BILLING_FILTERS).prefault("all").catch("all"),
  page: z.coerce.number().int().min(1).max(10_000).prefault(1).catch(1),
});
export type BillingQuery = z.infer<typeof billingQuerySchema>;

function filterFor(filter: BillingQuery["filter"]): Record<string, unknown> {
  const base = { $or: [{ provider: "razorpay" }, { "pendingCheckout.providerSubscriptionId": { $gt: "" } }] };
  switch (filter) {
    case "active":
      return { ...base, status: "active", cancelAtPeriodEnd: { $ne: true } };
    case "past_due":
      return { ...base, status: "past_due" };
    case "halted":
      return { ...base, providerStatus: "halted" };
    case "ending":
      return { ...base, status: "active", cancelAtPeriodEnd: true };
    case "ended":
      return { ...base, status: "canceled" };
    case "attention":
      return { ...base, $and: [{ $or: [{ status: "past_due" }, { lastReconcileError: { $gt: "" } }] }] };
    default:
      return base;
  }
}

export interface AdminBillingRow {
  businessId: string;
  businessName: string;
  planName: string;
  provider: string;
  providerSubscriptionId: string | null;
  checkoutPending: boolean;
  state: BillingStateView;
  status: string;
  providerStatus: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
  lastWebhookAt: string | null;
  lastReconciledAt: string | null;
  lastReconcileOutcome: string | null;
  lastReconcileError: string | null;
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

export async function listAdminBilling(query: BillingQuery) {
  await dbConnect();
  const where = filterFor(query.filter);
  const [rows, total] = await Promise.all([
    Subscription.find(where).sort({ updatedAt: -1 }).skip((query.page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    Subscription.countDocuments(where),
  ]);
  const [businesses, plans] = await Promise.all([
    Business.find({ _id: { $in: rows.map((row) => row.business) } }).select("name").lean(),
    Plan.find({ _id: { $in: rows.map((row) => row.plan) } }).select("name").lean(),
  ]);
  const businessName = new Map(businesses.map((business) => [String(business._id), business.name]));
  const planName = new Map(plans.map((plan) => [String(plan._id), plan.name]));
  const items: AdminBillingRow[] = rows.map((row) => ({
    businessId: String(row.business),
    businessName: businessName.get(String(row.business)) ?? "Unknown business",
    planName: planName.get(String(row.plan)) ?? "Unknown plan",
    provider: row.provider,
    providerSubscriptionId: row.providerSubscriptionId ?? null,
    checkoutPending: Boolean(row.pendingCheckout),
    state: describeBillingState(row),
    status: row.status,
    providerStatus: row.providerStatus ?? null,
    currentPeriodEnd: iso(row.currentPeriodEnd),
    graceUntil: iso(row.graceUntil),
    cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
    lastWebhookAt: iso(row.lastWebhookAt),
    lastReconciledAt: iso(row.lastReconciledAt),
    lastReconcileOutcome: row.lastReconcileOutcome ?? null,
    lastReconcileError: row.lastReconcileError ?? null,
  }));
  return { items, total, page: query.page, pageSize: PAGE_SIZE };
}

/** One store's billing: its payments, refunds, disputes and the events acted on. */
export async function getAdminBillingDetail(businessId: string) {
  await dbConnect();
  const [business, payments, adjustments, events] = await Promise.all([
    Business.findById(businessId).select("name").lean<{ name: string }>(),
    Payment.find({ business: businessId, paymentDomain: "subscription" }).sort({ createdAt: -1 }).limit(25).select("amount currency status providerPaymentId description paidAt createdAt refundedAmount").lean(),
    BillingAdjustment.find({ business: businessId }).sort({ createdAt: -1 }).limit(25).lean(),
    BillingEvent.find({ business: businessId }).sort({ createdAt: -1 }).limit(25).select("type outcome remoteStatus createdAt").lean(),
  ]);
  return {
    businessId,
    businessName: business?.name ?? "Unknown business",
    payments: payments.map((payment) => ({
      id: String(payment._id),
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      providerPaymentId: payment.providerPaymentId,
      description: payment.description,
      paidAt: iso(payment.paidAt),
      createdAt: iso(payment.createdAt),
      refundedAmount: payment.refundedAmount ?? 0,
    })),
    adjustments: adjustments.map((item) => ({
      id: String(item._id),
      kind: item.kind,
      providerId: item.providerId,
      providerPaymentId: item.providerPaymentId,
      amount: item.amountMinor / 100,
      currency: item.currency,
      status: item.status,
      reasonCode: item.reasonCode,
      respondBy: iso(item.respondBy),
      createdAt: iso(item.createdAt),
    })),
    events: events.map((event) => ({ id: String(event._id), type: event.type, outcome: event.outcome, remoteStatus: event.remoteStatus, createdAt: iso(event.createdAt) })),
  };
}
