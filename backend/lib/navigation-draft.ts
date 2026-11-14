import type { ClientSession } from "mongoose";
import { HttpError } from "@/lib/api";
import { dbConnect } from "@/lib/db";
import { draftConflict, draftVersionFilter } from "@/lib/draft-version";
import type { StoredNavigation } from "@/lib/navigation";
import { Business } from "@/models/Business";

/**
 * Saves the draft menus (server-only; callers authorise and check page references first).
 * Every writer of `themeSettings.navigation` moves `Business.navigationDraftVersion` on, so a
 * save naming an older version is refused with `409 draft_conflict` and changes nothing.
 * Returns the new version. Stores saved before versions existed count as version 0.
 */
export async function saveNavigationDraft(businessId: string, navigation: StoredNavigation, options: { expectedVersion?: number; session?: ClientSession } = {}): Promise<number> {
  await dbConnect();
  const stored = await Business.findById(businessId)
    .select("themeSettings.navigation themeSettings.publishedNavigation themeSettings.navigationDraftOnly navigationDraftVersion")
    .session(options.session ?? null)
    .lean<{ navigationDraftVersion?: number; themeSettings?: { navigation?: unknown; publishedNavigation?: unknown; navigationDraftOnly?: boolean } }>();
  if (!stored) throw new HttpError(404, "Business not found", "not_found");
  if (options.expectedVersion !== undefined && (stored.navigationDraftVersion ?? 0) !== options.expectedVersion) throw draftConflict();

  // The first menu draft freezes what visitors see now: a store without a published copy
  // shows its saved menus, unless those are known to be an unpublished draft.
  const settings = stored.themeSettings;
  if (!settings?.publishedNavigation) {
    const live = (settings?.navigationDraftOnly ? null : settings?.navigation) ?? { header: [], footer: [] };
    await Business.updateOne({ _id: businessId, "themeSettings.publishedNavigation": null }, { $set: { "themeSettings.publishedNavigation": live } }, { session: options.session });
  }

  const saved = await Business.findOneAndUpdate(
    { _id: businessId, ...draftVersionFilter("navigationDraftVersion", options.expectedVersion) },
    { $set: { "themeSettings.navigation": navigation }, $inc: { navigationDraftVersion: 1 } },
    { new: true, projection: { navigationDraftVersion: 1 }, session: options.session },
  ).lean<{ navigationDraftVersion?: number }>();
  if (!saved) {
    if (options.expectedVersion !== undefined) throw draftConflict();
    throw new HttpError(404, "Business not found", "not_found");
  }
  return saved.navigationDraftVersion ?? 0;
}
