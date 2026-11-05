import { NextResponse } from "next/server";
import { billingConfig, reconcileDueSubscriptions } from "@/lib/billing-razorpay";
import { isFeatureReady } from "@/lib/required-indexes";
import { billingReconcileSettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <BILLING_RECONCILE_SECRET>`
 * (docs/scheduled-jobs.md). Compares up to 50 of the subscriptions checked least recently
 * with Razorpay. Off until the secret is set. It only brings stores in line with what
 * Razorpay reports, so repeating it changes nothing further, and a call during another run
 * does nothing. Answers with counts only.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "BILLING_RECONCILE_SECRET");
  if (denied) return denied;
  if (!billingConfig() || !(await isFeatureReady("subscription_billing"))) {
    return NextResponse.json({ error: "Billing is not ready" }, { status: 503 });
  }
  const settings = billingReconcileSettings();
  const result = await runScheduledJob("billing-reconcile", settings, () => reconcileDueSubscriptions(settings));
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
