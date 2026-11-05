import mongoose from "mongoose";
import { z } from "zod";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { HttpError } from "@/lib/api";
import { isManualBillingAllowed } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { Business } from "@/models/Business";
import { Plan, type PlanDoc } from "@/models/Plan";
import { Subscription } from "@/models/Subscription";

/**
 * A Super Admin giving a store a plan by hand, such as a complimentary upgrade (server-only;
 * callers pass `requireSuperAdmin()` first). Audited in the same transaction.
 *
 * - No payment is recorded, because none happened: it can never make money appear.
 * - A subscription Razorpay is billing is refused. Its state comes only from Razorpay, and
 *   overwriting it here would keep charging the owner for something else.
 * - In production, a paid plan needs ALLOW_MANUAL_BILLING, like any other manual activation.
 * - Nothing in the store changes except its limits: a smaller plan never removes anything.
 */
export const planAssignmentSchema = z.object({
  planKey: z.string().trim().toLowerCase().min(1, "Choose a plan").max(40),
  reason: z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`).max(ADMIN_REASON_MAX),
});

export async function assignPlanToBusiness(input: { businessId: string; adminId: string; planKey: string; reason: string; now?: Date }) {
  await dbConnect();
  const now = input.now ?? new Date();
  const plan = await Plan.findOne({ key: input.planKey, active: true }).lean<PlanDoc & { _id: mongoose.Types.ObjectId }>();
  if (!plan) throw new HttpError(404, "That plan is not available.", "not_found");
  if (plan.price > 0 && !isManualBillingAllowed()) {
    throw new HttpError(402, "Manual activation of paid plans is disabled on this platform (ALLOW_MANUAL_BILLING).", "manual_billing_disabled");
  }
  const periodEnd = new Date(now);
  if (plan.interval === "year") periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
  else periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

  return runAuditedAdminAction(async (session) => {
    const business = await Business.findById(input.businessId).select("name").session(session).lean<{ name: string }>();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    const current = await Subscription.findOne({ business: input.businessId }).sort({ createdAt: -1 }).populate<{ plan: PlanDoc | null }>({ path: "plan", select: "key name", model: Plan }).session(session);
    const onRazorpay = current?.provider === "razorpay" && Boolean(current.providerSubscriptionId) && current.status !== "canceled";
    if (onRazorpay || current?.pendingCheckout) {
      throw new HttpError(409, "Razorpay manages this subscription, so its plan cannot be set here. The owner changes it from their billing page.", "provider_managed");
    }
    const previous = current?.plan?.key ?? null;
    const updated = await Subscription.findOneAndUpdate(
      current ? { _id: current._id } : { business: input.businessId },
      // A finished Razorpay subscription lets go of its id, so a late event cannot change this.
      { $set: { plan: plan._id, status: "active", provider: "manual", providerSubscriptionId: null, graceUntil: null, currentPeriodStart: now, currentPeriodEnd: plan.price === 0 ? null : periodEnd, cancelAtPeriodEnd: false } },
      { new: true, upsert: true, session },
    );
    return {
      result: { planName: plan.name, currentPeriodEnd: updated?.currentPeriodEnd ?? null },
      audit: {
        actorId: input.adminId,
        action: "business.plan_assign" as const,
        targetType: "business" as const,
        targetId: input.businessId,
        targetLabel: business.name,
        reason: input.reason,
        before: { plan: previous },
        after: { plan: plan.key, currentPeriodEnd: plan.price === 0 ? null : periodEnd.toISOString() },
      },
    };
  });
}
