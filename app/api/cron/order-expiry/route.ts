import { NextResponse } from "next/server";
import { releaseDueOrdersForScheduler } from "@/lib/orders/lifecycle";
import { orderExpirySettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <ORDER_EXPIRY_SECRET>`
 * (docs/scheduled-jobs.md). Releases the stock and coupon uses of orders whose reservation has
 * run out, using the same rule and transaction as every other release. Answers counts only.
 * Off until the secret is set, and safe to repeat: an order is released once, however often this runs.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "ORDER_EXPIRY_SECRET");
  if (denied) return denied;
  const settings = orderExpirySettings();
  const result = await runScheduledJob("order-expiry", settings, () => releaseDueOrdersForScheduler(settings));
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
