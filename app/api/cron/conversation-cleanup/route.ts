import { NextResponse } from "next/server";
import { CONVERSATION_PURGE_BATCH, purgeExpiredConversations } from "@/lib/ai-website/conversation";
import { conversationCleanupSettings, runScheduledJob } from "@/lib/scheduled-jobs";
import { schedulerDenied } from "@/lib/scheduler-auth";

/**
 * For an external scheduler: `POST` with `Authorization: Bearer <CONVERSATION_CLEANUP_SECRET>`
 * (docs/scheduled-jobs.md). Deletes AI website conversations past their 14 days. Only ever those:
 * proposals keep their own state. Answers counts only. Off until the secret is set, and safe to repeat.
 */
export async function POST(request: Request) {
  const denied = schedulerDenied(request, "CONVERSATION_CLEANUP_SECRET");
  if (denied) return denied;
  const settings = conversationCleanupSettings();
  const result = await runScheduledJob("conversation-cleanup", settings, async () => {
    const deleted = await purgeExpiredConversations();
    // A full batch means more may be waiting: the next run carries on.
    return { checked: deleted, changed: deleted, failed: 0, skipped: 0, stoppedEarly: deleted >= CONVERSATION_PURGE_BATCH };
  });
  if (result.status === "overlap") return NextResponse.json({ outcome: "skipped_overlap" });
  const { outcome, checked, changed, failed, skipped, stoppedEarly } = result.run;
  return NextResponse.json({ outcome, checked, changed, failed, skipped, stoppedEarly }, { status: outcome === "failed" ? 502 : 200 });
}
