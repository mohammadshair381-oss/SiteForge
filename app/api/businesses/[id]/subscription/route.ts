import { dbConnect } from "@/lib/db";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireVerifiedEmail, requireBusinessRole } from "@/lib/auth/guards";
import { getEntitlements, isManualBillingAllowed } from "@/lib/billing";
import {
  abandonCheckout,
  billingConfig,
  cancelAtCycleEnd,
  cancelScheduledPlanChange,
  paymentRecoveryUrl,
  reconcileBusinessSubscription,
  scheduleMoveToFreePlan,
  startPaidPlan,
} from "@/lib/billing-razorpay";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { checkoutSchema } from "@/lib/validation";
import { env } from "@/lib/env";
import { Subscription } from "@/models/Subscription";
import { Payment } from "@/models/Payment";
import { Plan, type PlanDoc } from "@/models/Plan";
import { Membership } from "@/models/Membership";
import { Product } from "@/models/Product";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Subscription, entitlements and payment history. Owner only: billing is an
 * owner capability (AGENTS.md role matrix); managers and staff see the plan
 * name and limits on the business overview, not payment records.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner"]);
    await dbConnect();

    const [entitlements, subscription, payments] = await Promise.all([
      getEntitlements(id),
      Subscription.findOne({ business: id }).sort({ createdAt: -1 }).populate("plan").lean(),
      Payment.find({ business: id }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);

    return ok({ entitlements, subscription, payments });
  });
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireVerifiedEmail();
    await requireBusinessRole(id, ["owner"]);
    const raw = (await readJson(request)) as { action?: unknown };
    await dbConnect();
    const razorpayBilling = env().PAYMENT_PROVIDER === "razorpay";
    if (razorpayBilling) {
      assertSameOriginJsonRequest(request);
      await enforceRateLimit({ key: `billing:${id}`, windowMs: 60 * 60 * 1000, limit: 30 });
    }

    // Provider subscriptions: what happens next is decided by Razorpay's answer.
    const stored = await Subscription.findOne({ business: id }).sort({ createdAt: -1 }).lean<{ _id: unknown; provider: string; status: string; providerSubscriptionId: string | null; cancelAtPeriodEnd?: boolean; pendingCheckout?: { providerSubscriptionId: string } | null; currentPeriodEnd?: Date | null }>();
    const onProvider = stored?.provider === "razorpay" && Boolean(stored.providerSubscriptionId);
    if (raw?.action === "refresh" && razorpayBilling) {
      const result = await reconcileBusinessSubscription({ businessId: id });
      if (result.outcome === "failed") throw new HttpError(502, "Razorpay could not be reached. Please try again shortly.", "billing_provider_error");
      return ok({ outcome: result.outcome, reconciledAt: result.at, entitlements: await getEntitlements(id) });
    }
    if (raw?.action === "abandon_checkout" && razorpayBilling) {
      await abandonCheckout({ businessId: id });
      return ok({ entitlements: await getEntitlements(id) });
    }
    if (raw?.action === "cancel_plan_change" && razorpayBilling) {
      await cancelScheduledPlanChange({ businessId: id });
      return ok({ entitlements: await getEntitlements(id) });
    }
    if (raw?.action === "payment_link" && razorpayBilling) {
      return ok({ url: await paymentRecoveryUrl({ businessId: id }) });
    }
    if (raw?.action === "cancel" && onProvider) {
      await cancelAtCycleEnd({ businessId: id });
      return ok({ cancelAtPeriodEnd: true, currentPeriodEnd: stored?.currentPeriodEnd ?? null, entitlements: await getEntitlements(id) });
    }
    if (raw?.action === "resume" && onProvider) {
      // Razorpay documents no way to undo a cancellation, only pending plan updates.
      throw new HttpError(409, "A cancellation cannot be undone. Choose a plan again once this one has ended.", "cannot_resume");
    }

    // Cancel at the end of the paid period, or change your mind. Access keeps
    // following `lib/billing.ts`: it ends at `currentPeriodEnd`, with no refund.
    if (raw?.action === "cancel" || raw?.action === "resume") {
      const current = await Subscription.findOne({ business: id }).sort({ createdAt: -1 }).populate("plan").lean<{ _id: unknown; provider: string; plan?: { price?: number } | null; currentPeriodEnd?: Date | null }>();
      if (!current) throw new HttpError(404, "This business has no subscription", "not_found");
      if (current.provider !== "manual") {
        throw new HttpError(501, "Cancellation goes through the configured billing provider, which is not connected.", "not_implemented");
      }
      if (razorpayBilling && current.plan?.price) {
        throw new HttpError(409, "This plan was set up by hand, so it is not billed online. Contact support to change it.", "manual_plan");
      }
      if (!current.plan?.price) throw new HttpError(409, "Free plans have no billing period to cancel.", "nothing_to_cancel");
      await Subscription.updateOne({ _id: current._id, business: id }, { $set: { cancelAtPeriodEnd: raw.action === "cancel" } });
      return ok({ cancelAtPeriodEnd: raw.action === "cancel", currentPeriodEnd: current.currentPeriodEnd ?? null, entitlements: await getEntitlements(id) });
    }

    const { planKey } = checkoutSchema.parse(raw);

    const plan = await Plan.findOne({ key: planKey, active: true });
    if (!plan) throw new HttpError(404, "Plan not found", "not_found");

    if (razorpayBilling) {
      if (plan.price > 0) {
        if (!billingConfig()) throw new HttpError(503, "Online billing is not available yet. Please try again later.", "billing_not_configured");
        const result = await startPaidPlan({ businessId: id, planKey });
        return result.kind === "checkout"
          ? ok({ checkoutUrl: result.url, entitlements: await getEntitlements(id) })
          : ok({ scheduledPlan: plan.key, effectiveAt: result.effectiveAt, entitlements: await getEntitlements(id) });
      }
      if (onProvider) {
        // A free plan takes over when the paid period ends.
        await scheduleMoveToFreePlan({ businessId: id, freePlanId: plan._id });
        return ok({ scheduledPlan: plan.key, effectiveAt: stored?.currentPeriodEnd ?? null, entitlements: await getEntitlements(id) });
      }
      // A free plan involves no payment, so it switches below without a provider.
    }

    // Live billing is intentionally gated. Without a configured provider we
    // only allow the server-authoritative manual/sandbox switch.
    if (env().PAYMENT_PROVIDER !== "manual" && !razorpayBilling) {
      throw new HttpError(
        501,
        "Online checkout is not configured. Payment must be completed through the configured provider.",
        "not_implemented",
      );
    }

    // Fail closed in production: manual activation must never grant a paid plan
    // for free unless an operator explicitly opted in via ALLOW_MANUAL_BILLING.
    if (plan.price > 0 && !isManualBillingAllowed()) {
      throw new HttpError(
        402,
        "Manual activation of paid plans is disabled. Configure a payment provider to upgrade.",
        "manual_billing_disabled",
      );
    }

    const now = new Date();
    const periodEnd = new Date(now);
    if (plan.interval === "year") {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    } else {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    }

    const subscription = await Subscription.findOneAndUpdate(
      { business: id },
      {
        plan: plan._id,
        status: "active",
        provider: "manual",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
      { new: true, upsert: true, sort: { createdAt: -1 } },
    );

    if (plan.price > 0) {
      await Payment.create({
        business: id,
        subscription: subscription._id,
        amount: plan.price,
        currency: plan.currency,
        status: "succeeded",
        provider: "manual",
        providerPaymentId: `manual_${Date.now().toString(36)}`,
        description: `Manual activation: ${plan.name} plan`,
        paidAt: now,
        paymentDomain: "subscription",
      });
    }

    // A lower limit never removes anything: it only blocks adding more.
    const [products, members] = await Promise.all([
      Product.countDocuments({ business: id, status: { $ne: "archived" } }),
      Membership.countDocuments({ business: id, status: "active" }),
    ]);
    const warnings = [
      ...(products > plan.features.productLimit ? [`You have ${products} products and this plan allows ${plan.features.productLimit}. They stay on your store, but you cannot add more until you are under the limit.`] : []),
      ...(members > plan.features.staffLimit + 1 ? [`Your team is larger than this plan allows. Everyone stays, but you cannot add more people.`] : []),
    ];
    const entitlements = await getEntitlements(id);
    return ok({ subscription: subscription.toJSON(), entitlements, warnings });
  });
}