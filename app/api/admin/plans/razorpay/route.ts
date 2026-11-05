import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { runAuditedAdminAction, ADMIN_REASON_MIN } from "@/lib/admin-audit";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { billingConfig, ensureProviderPlan } from "@/lib/billing-razorpay";

const bodySchema = z.object({
  key: z.string().trim().toLowerCase().min(1).max(40),
  reason: z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`).max(500),
});

/** `GET` — whether online billing is on, and in which mode. No keys. */
export async function GET() {
  return handle(async () => {
    await requireSuperAdmin();
    const config = billingConfig();
    return ok({ configured: Boolean(config), mode: config?.mode ?? null });
  });
}

/**
 * `POST { key, reason }` creates this plan at Razorpay at its current price, or finds the
 * one already made. Razorpay plans cannot be edited, so a new price needs this again;
 * people already subscribed stay on the price they agreed to. Audited.
 */
export async function POST(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { key, reason } = bodySchema.parse(await readJson(request));
    if (!billingConfig()) throw new HttpError(503, "Online billing is not configured.", "billing_not_configured");
    const { plan, mapping, created } = await ensureProviderPlan(key);
    await runAuditedAdminAction(
      async () => ({
        result: created,
        audit: {
          actorId: String(admin._id),
          action: "plan.provider_mapping",
          targetType: "plan",
          targetId: key,
          targetLabel: plan.name,
          reason,
          before: null,
          after: { provider: mapping.provider, mode: mapping.mode, planId: mapping.planId, amountMinor: mapping.amountMinor, currency: mapping.currency, interval: mapping.interval },
        },
      }),
      { skipAuditWhen: (wasCreated) => !wasCreated },
    );
    return ok({ created, mapping: { mode: mapping.mode, planId: mapping.planId, amountMinor: mapping.amountMinor, currency: mapping.currency, interval: mapping.interval } });
  });
}
