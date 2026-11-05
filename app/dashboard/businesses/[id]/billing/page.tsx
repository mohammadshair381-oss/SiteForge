import { billingConfig } from "@/lib/billing-razorpay";
import { dbConnect } from "@/lib/db";
import { requireBusinessRole } from "@/lib/auth/guards";
import { DEFAULT_AI_REQUESTS_PER_MONTH, isManualBillingAllowed } from "@/lib/billing";
import { THEME_IDS } from "@/lib/constants";
import { env } from "@/lib/env";
import { isFeatureReady } from "@/lib/required-indexes";
import { planThemes } from "@/lib/theme-tiers";
import { getThemeMeta } from "@/lib/themes";
import { getBusinessUsage } from "@/lib/usage-limits";
import { BillingAdjustment } from "@/models/BillingAdjustment";
import { Plan } from "@/models/Plan";
import { Payment } from "@/models/Payment";
import { Subscription } from "@/models/Subscription";
import BillingPanel from "@/components/dashboard/BillingPanel";
import { Card } from "@/components/ui/Surface";

export const dynamic = "force-dynamic";

export default async function BusinessBilling({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
  // Billing and payment history are owner-only (same rule as the API).
  if (membership.role !== "owner") {
    return (
      <Card role="note" className="p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Subscription</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
          Only the business owner can view the subscription and payment history. Your plan and limits are shown on the
          business overview.
        </p>
      </Card>
    );
  }
  await dbConnect();

  const [{ entitlements, lines }, plans, payments, subscription] = await Promise.all([
    getBusinessUsage(id),
    Plan.find({ active: true }).sort({ sort: 1 }).lean(),
    Payment.find({ business: id }).sort({ createdAt: -1 }).limit(50).lean(),
    Subscription.findOne({ business: id }).sort({ createdAt: -1 }).lean(),
  ]);

  const billing = billingConfig();
  const [billingReady, adjustments] = await Promise.all([
    billing ? isFeatureReady("subscription_billing") : false,
    BillingAdjustment.find({ business: id }).sort({ createdAt: -1 }).limit(20).select("kind amountMinor currency status createdAt").lean(),
  ]);

  return (
    <BillingPanel
      businessId={id}
      entitlements={{
        planKey: entitlements.planKey,
        planName: entitlements.planName,
        status: entitlements.status,
        active: entitlements.active,
        expired: entitlements.expired,
        productLimit: entitlements.productLimit,
        staffLimit: entitlements.staffLimit,
        customDomain: entitlements.customDomain,
        removeBranding: entitlements.removeBranding,
        aiRequestsPerMonth: entitlements.aiRequestsPerMonth,
        themes: entitlements.themes.map((themeId) => getThemeMeta(themeId).name),
      }}
      usage={lines}
      totalThemes={THEME_IDS.length}
      plans={plans.map((plan) => ({
        key: plan.key,
        name: plan.name,
        description: plan.description,
        price: plan.price,
        currency: plan.currency,
        interval: plan.interval,
        features: {
          productLimit: plan.features.productLimit,
          staffLimit: plan.features.staffLimit,
          customDomain: plan.features.customDomain,
          removeBranding: plan.features.removeBranding,
          aiRequestsPerMonth: typeof plan.features.aiRequestsPerMonth === "number" ? plan.features.aiRequestsPerMonth : DEFAULT_AI_REQUESTS_PER_MONTH,
          pageLimit: plan.features.pageLimit ?? null,
          storageMb: plan.features.storageMb ?? null,
          monthlyOrderLimit: plan.features.monthlyOrderLimit ?? null,
        },
        themes: planThemes(plan).map((themeId) => getThemeMeta(themeId).name),
      }))}
      payments={payments.map((payment) => ({
        _id: String(payment._id),
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        description: payment.description,
        createdAt: new Date(payment.createdAt).toISOString(),
        paidAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : null,
        refundedAmount: payment.refundedAmount ?? 0,
      }))}
      adjustments={adjustments.map((item) => ({
        id: String(item._id),
        kind: item.kind,
        amount: item.amountMinor / 100,
        currency: item.currency,
        status: item.status,
        createdAt: new Date(item.createdAt).toISOString(),
      }))}
      subscription={
        subscription
          ? {
              status: subscription.status,
              currentPeriodEnd: subscription.currentPeriodEnd
                ? new Date(subscription.currentPeriodEnd).toISOString()
                : null,
              cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
            }
          : null
      }
      canManage={membership.role === "owner"}
      provider={env().PAYMENT_PROVIDER}
      manualPaidPlansAllowed={isManualBillingAllowed()}
      onlineBilling={
        billing
          ? {
              mode: billing.mode,
              onProvider: subscription?.provider === "razorpay" && Boolean(subscription.providerSubscriptionId),
              checkoutPending: Boolean(subscription?.pendingCheckout),
              graceUntil: entitlements.graceUntil ? new Date(entitlements.graceUntil).toISOString() : null,
              providerStatus: subscription?.providerStatus ?? null,
              pendingPlanName: subscription?.pendingPlan ? plans.find((plan) => String(plan._id) === String(subscription.pendingPlan))?.name ?? null : null,
              scheduledChangeAt: subscription?.scheduledChangeAt ? new Date(subscription.scheduledChangeAt).toISOString() : null,
              lastReconciledAt: subscription?.lastReconciledAt ? new Date(subscription.lastReconciledAt).toISOString() : null,
              ready: billingReady,
            }
          : null
      }
    />
  );
}
