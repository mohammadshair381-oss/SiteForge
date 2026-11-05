import { z } from "zod";
import { HttpError, handle, ok, readJson } from "@/lib/api";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, runAuditedAdminAction } from "@/lib/admin-audit";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { dbConnect } from "@/lib/db";
import { clearPlatformSettingsCache, platformSettingsSchema, readPlatformSettingsState } from "@/lib/platform-settings";
import { PlatformSettings } from "@/models/PlatformSettings";

const stale = () => new HttpError(409, "Another administrator changed these settings after you opened this page. Load the latest settings, then make your change again.", "settings_changed");

const bodySchema = platformSettingsSchema.extend({
  /** The revision this form was opened with. */
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(ADMIN_REASON_MIN, `Give a reason of at least ${ADMIN_REASON_MIN} characters`).max(ADMIN_REASON_MAX),
});

/**
 * `PUT /api/admin/settings`: platform settings, audited with the before and after in the
 * same transaction. Only the fields in the schema can change: integrations, live payments
 * and production AI are environment settings, which nothing here can reach. A save names the
 * revision it was based on, and is refused if another one came first: two transactions at once
 * conflict on this document, so the later one retries and sees the new revision.
 */
export async function PUT(request: Request) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const admin = await requireSuperAdmin();
    const { reason, expectedRevision, ...next } = bodySchema.parse(await readJson(request));
    await dbConnect();
    const state = await readPlatformSettingsState();
    if (state.source === "unavailable") throw new HttpError(503, "The current settings could not be read, so nothing was saved. Please try again shortly.", "settings_unavailable");
    if (state.revision !== expectedRevision) throw stale();
    let revision: number;
    try {
      revision = await runAuditedAdminAction(async (session) => {
        const current = await PlatformSettings.findById("platform").session(session).lean();
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== expectedRevision) throw stale();
        const nextRevision = currentRevision + 1;
        await PlatformSettings.updateOne({ _id: "platform" }, { $set: { ...next, revision: nextRevision } }, { upsert: true, session });
        return {
          result: nextRevision,
          audit: { actorId: String(admin._id), action: "platform.settings", targetType: "platform", targetId: "platform", targetLabel: "Platform settings", reason, before: { ...state.settings, revision: currentRevision }, after: { ...next, revision: nextRevision } },
        };
      });
    } catch (error) {
      // The very first save, twice at once: the other one created the document.
      if (error && typeof error === "object" && (error as { code?: unknown }).code === 11000) throw stale();
      throw error;
    }
    clearPlatformSettingsCache();
    return ok({ settings: next, revision });
  });
}
