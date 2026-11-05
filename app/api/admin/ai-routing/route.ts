import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/api";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { getAiRoutingOverview } from "@/lib/ai-providers/overview";
import { assertAiRoutingValid } from "@/lib/ai-providers/routing";
import { aiRoutingSchema, clearAiRoutingCache, readAiRoutingState } from "@/lib/ai-providers/settings";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { dbConnect } from "@/lib/db";
import { PlatformSettings } from "@/models/PlatformSettings";

const stale = () => new HttpError(409, "Another administrator changed these settings after you opened this page. Load the latest settings, then make your change again.", "settings_changed");

const bodySchema = aiRoutingSchema.extend({
  /** The revision these choices were based on. */
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`).max(ADMIN_REASON_MAX),
});

/** `GET`: provider availability, models and the route each task would use. Names only, never a credential. */
export async function GET() {
  return handle(async () => {
    await requireSuperAdmin();
    return ok(await getAiRoutingOverview(), { headers: { "Cache-Control": "no-store" } });
  });
}

/**
 * `PUT`: which providers and models handle which tasks, audited with the before and after in the
 * same transaction. These choices can only narrow what the server environment allows: no value
 * here can turn AI on, supply a credential or use a provider the consent disclosure does not name.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { reason, expectedRevision, ...next } = bodySchema.parse(await readJson(request));
    assertAiRoutingValid(next);
    await dbConnect();
    const state = await readAiRoutingState();
    if (state.source === "unavailable") throw new HttpError(503, "The current settings could not be read, so nothing was saved. Please try again shortly.", "settings_unavailable");
    if (state.revision !== expectedRevision) throw stale();
    let revision: number;
    try {
      revision = await runAuditedAdminAction(async (session) => {
        const current = await PlatformSettings.findById("platform").select("aiRoutingRevision").session(session).lean();
        const currentRevision = current?.aiRoutingRevision ?? 0;
        if (currentRevision !== expectedRevision) throw stale();
        const nextRevision = currentRevision + 1;
        await PlatformSettings.updateOne({ _id: "platform" }, { $set: { aiRouting: next, aiRoutingRevision: nextRevision } }, { upsert: true, session });
        return {
          result: nextRevision,
          audit: {
            actorId: String(admin._id),
            action: "platform.settings",
            targetType: "platform",
            targetId: "ai-routing",
            targetLabel: "AI provider routing",
            reason,
            before: { ...state.settings, revision: currentRevision },
            after: { ...next, revision: nextRevision },
          },
        };
      });
    } catch (error) {
      // The very first save, twice at once: the other one created the document.
      if (error && typeof error === "object" && (error as { code?: unknown }).code === 11000) throw stale();
      throw error;
    }
    clearAiRoutingCache();
    return ok({ settings: next, revision });
  });
}
