import { NextResponse } from "next/server";
import { checkDueDomains } from "@/lib/domains/activation";
import { domainHealthSettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <DOMAIN_HEALTH_SECRET>`
 * (docs/scheduled-jobs.md). Runs the same check as the owner's button on up to 50 domains,
 * which also asks a certificate integration to renew if one that can is configured. Off
 * until the secret is set, and a call during another run does nothing. Counts only.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "DOMAIN_HEALTH_SECRET");
  if (denied) return denied;
  const settings = domainHealthSettings();
  const result = await runScheduledJob("domain-health", settings, () => checkDueDomains(settings));
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
