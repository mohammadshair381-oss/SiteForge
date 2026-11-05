import { z } from "zod";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { billingConfig, reconcileBusinessSubscription } from "@/lib/billing-razorpay";
import { assertFeatureReady } from "@/lib/required-indexes";

const bodySchema = z.object({
  businessId: z.string().regex(/^[a-f0-9]{24}$/i, "Choose a business"),
  reason: z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`).max(500),
});

/**
 * `POST { businessId, reason }` asks Razorpay about one store now. It can only bring the
 * store in line with what Razorpay reports, so an admin cannot grant or extend anything.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { businessId, reason } = bodySchema.parse(await readJson(request));
    if (!billingConfig()) throw new HttpError(503, "Online billing is not configured.", "billing_not_configured");
    await assertFeatureReady("subscription_billing");
    const result = await reconcileBusinessSubscription({ businessId });
    await runAuditedAdminAction(async () => ({
      result,
      audit: {
        actorId: String(admin._id),
        action: "billing.reconcile",
        targetType: "business",
        targetId: businessId,
        targetLabel: "",
        reason,
        before: null,
        after: { outcome: result.outcome, error: result.error },
      },
    }));
    return ok(result);
  });
}
