import { NextResponse } from "next/server";
import { cleanupMediaStorage } from "@/lib/media-cleanup";
import { mediaCleanupSettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <MEDIA_CLEANUP_SECRET>`
 * (docs/scheduled-jobs.md). Finishes interrupted uploads and unconfirmed deletions, and never
 * removes a file anything still refers to. Off until the secret is set, and safe to repeat.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "MEDIA_CLEANUP_SECRET");
  if (denied) return denied;
  const settings = mediaCleanupSettings();
  const result = await runScheduledJob("media-cleanup", settings, () => cleanupMediaStorage(settings));
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
