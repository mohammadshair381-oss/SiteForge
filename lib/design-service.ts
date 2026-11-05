import mongoose, { type ClientSession } from "mongoose";
import { HttpError } from "@/lib/api";
import { assertCanPublish, assertCanUseTheme } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { designDraftChangesSchema, designDraftSchema, pickStoreDesign, readDesignDraft, readStoreDesign, type DesignDraft } from "@/lib/design-settings";
import { draftConflict, draftVersionFilter } from "@/lib/draft-version";
import { DEFAULT_THEME_SETTINGS, themeBrandColors } from "@/lib/storefront";
import { recordRevision } from "@/lib/website-revisions";
import { Business } from "@/models/Business";

/**
 * Draft and published store design (server-only). Callers authorise with
 * `requireBusinessRole` first. The draft lives in `themeSettings.designDraft`
 * and is never read for the public store; publishing copies it to the live
 * fields with the same plan gates as choosing a theme and publishing a store.
 */
type BusinessLike = { themeId: string; themeSettings?: unknown };

export function liveDesign(business: BusinessLike): DesignDraft {
  const settings = (business.themeSettings ?? {}) as Record<string, unknown>;
  const colors = themeBrandColors(business.themeId as DesignDraft["themeId"], { ...DEFAULT_THEME_SETTINGS, ...settings });
  const stored = readStoreDesign(settings.design);
  // The older serif/mono choice carries over until a typeface is chosen here.
  const legacy = settings.font === "serif" || settings.font === "mono" ? settings.font : null;
  return {
    ...stored,
    displayFont: stored.displayFont === "theme" && legacy ? legacy : stored.displayFont,
    bodyFont: stored.bodyFont === "theme" && legacy ? legacy : stored.bodyFont,
    themeId: business.themeId as DesignDraft["themeId"],
    useThemeColors: colors.usesThemeColors,
    primaryColor: colors.primaryColor,
    accentColor: colors.accentColor,
  };
}

async function loadBusiness(businessId: string, session?: ClientSession) {
  await dbConnect();
  const business = await Business.findById(businessId).select("themeId themeSettings status designDraftVersion").session(session ?? null).lean<BusinessLike & { status: string; designDraftVersion?: number }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  return business;
}

const sameDesign = (a: DesignDraft, b: DesignDraft) => {
  const key = (d: DesignDraft) => JSON.stringify([d.themeId, d.useThemeColors, d.useThemeColors ? "" : d.primaryColor.toLowerCase(), d.useThemeColors ? "" : d.accentColor.toLowerCase(), pickStoreDesign(d)]);
  return key(a) === key(b);
};

export async function getDesignState(businessId: string): Promise<{ draft: DesignDraft; live: DesignDraft; hasUnpublishedChanges: boolean; version: number }> {
  const business = await loadBusiness(businessId);
  const live = liveDesign(business);
  const draft = readDesignDraft((business.themeSettings as Record<string, unknown> | undefined)?.designDraft) ?? live;
  return { draft, live, hasUnpublishedChanges: !sameDesign(draft, live), version: business.designDraftVersion ?? 0 };
}

/** Stores the draft. A locked theme is refused here too, not only at publish time. */
export async function saveDesignDraft(businessId: string, input: unknown, options: { expectedVersion?: number; session?: ClientSession } = {}): Promise<DesignDraft> {
  const draft = designDraftSchema.parse(input);
  const business = await loadBusiness(businessId, options.session);
  await assertCanUseTheme(businessId, draft.themeId, business.themeId);
  const saved = await Business.updateOne({ _id: businessId, ...draftVersionFilter("designDraftVersion", options.expectedVersion) }, { $set: { "themeSettings.designDraft": draft }, $inc: { designDraftVersion: 1 } }, { session: options.session });
  if (saved.matchedCount === 0) throw draftConflict();
  return draft;
}

/**
 * Changes part of the draft (choosing a theme, say) and keeps everything else, so
 * the owner's colours, fonts and other draft choices are never overwritten.
 */
export async function updateDesignDraft(businessId: string, input: unknown): Promise<DesignDraft> {
  const changes = designDraftChangesSchema.parse(input);
  const business = await loadBusiness(businessId);
  const current = readDesignDraft((business.themeSettings as Record<string, unknown> | undefined)?.designDraft) ?? liveDesign(business);
  const draft = { ...current, ...changes };
  await assertCanUseTheme(businessId, draft.themeId, business.themeId);
  await Business.updateOne({ _id: businessId }, { $set: { "themeSettings.designDraft": draft }, $inc: { designDraftVersion: 1 } });
  return draft;
}

export async function discardDesignDraft(businessId: string): Promise<void> {
  await dbConnect();
  await Business.updateOne({ _id: businessId }, { $unset: { "themeSettings.designDraft": "" }, $inc: { designDraftVersion: 1 } });
}

/**
 * Applies the draft to the live store. `requirePlan: false` is for the store
 * publish route, which has already checked the same gates. Never while suspended
 * (the write itself is conditional, so a suspension landing in between wins).
 */
export async function publishDesignDraft(businessId: string, options: { createdBy?: unknown; requirePlan?: boolean } = {}): Promise<DesignDraft | null> {
  const business = await loadBusiness(businessId);
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  const draft = readDesignDraft((business.themeSettings as Record<string, unknown> | undefined)?.designDraft);
  if (!draft) return null;
  if (options.requirePlan !== false) await assertCanPublish(businessId);
  // Re-checked: the plan may have changed since the draft was saved.
  await assertCanUseTheme(businessId, draft.themeId, business.themeId);

  await recordRevision({ businessId, target: "design", reason: "published", label: "Design before publishing", snapshot: liveDesign(business), createdBy: options.createdBy });

  const { displayFont, bodyFont } = draft;
  const result = await Business.updateOne(
    { _id: new mongoose.Types.ObjectId(businessId), status: { $ne: "suspended" } },
    {
      $set: {
        themeId: draft.themeId,
        // The starting pair means "follow the theme's palette" (lib/storefront.ts).
        "themeSettings.primaryColor": draft.useThemeColors ? DEFAULT_THEME_SETTINGS.primaryColor : draft.primaryColor,
        "themeSettings.accentColor": draft.useThemeColors ? DEFAULT_THEME_SETTINGS.accentColor : draft.accentColor,
        "themeSettings.font": displayFont === bodyFont && (displayFont === "serif" || displayFont === "mono") ? displayFont : "sans",
        "themeSettings.design": pickStoreDesign(draft),
      },
      $unset: { "themeSettings.designDraft": "" },
    },
  );
  if (result.matchedCount === 0) {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  return draft;
}
