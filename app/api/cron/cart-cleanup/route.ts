import { NextResponse } from "next/server";
import { purgeExpiredCarts } from "@/lib/cart/abandoned";
import { cartCleanupSettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <CART_CLEANUP_SECRET>`
 * (docs/scheduled-jobs.md). Deletes carts nobody has touched for 30 days. Only ever carts:
 * orders and customers are not involved. Off until the secret is set, and safe to repeat.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "CART_CLEANUP_SECRET");
  if (denied) return denied;
  const settings = cartCleanupSettings();
  const result = await runScheduledJob("cart-cleanup", settings, async () => {
    const deleted = await purgeExpiredCarts();
    return { checked: deleted, changed: deleted, failed: 0, skipped: 0, stoppedEarly: false };
  });
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
