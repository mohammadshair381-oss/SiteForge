import { navigationPageIds, type StoredNavigation } from "@/lib/navigation";
import { dbConnect } from "@/lib/db";
import { expectedDraftVersion } from "@/lib/draft-version";
import { saveNavigationDraft } from "@/lib/navigation-draft";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { businessUpdateSchema, deleteBusinessSchema } from "@/lib/validation";
import { assertSameOriginJsonRequest } from "@/lib/auth/customer-accounts";
import { enforceRateLimit } from "@/lib/rate-limit";
import { deleteBusiness } from "@/lib/business-deletion";
import { assertMediaUrlsOwned, assertSectionMediaOwned } from "@/lib/media-references";
import { assertCanUseTheme, entitlementsForRole, getEntitlements } from "@/lib/billing";
import { getThemeMeta } from "@/lib/themes";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Stored settings a live store shows straight away. */
const LIVE_THEME_SETTINGS = ["primaryColor", "accentColor", "font", "heroHeadline", "heroSubheadline", "about", "showProducts"] as const;

export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner", "manager", "staff"]);
    await dbConnect();

    const business = await Business.findById(id).lean();
    if (!business) throw new HttpError(404, "Business not found", "not_found");

    const [entitlements, productCount, staffCount] = await Promise.all([
      getEntitlements(id),
      Product.countDocuments({ business: id, status: { $ne: "archived" } }),
      Membership.countDocuments({ business: id }),
    ]);

    return ok({
      business,
      role: membership.role,
      entitlements: entitlementsForRole(entitlements, membership.role),
      theme: getThemeMeta(business.themeId),
      counts: { products: productCount, members: staffCount },
    });
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { membership } = await requireBusinessRole(id, ["owner", "manager"]);
    const body = businessUpdateSchema.parse(await readJson(request));
    // Accepting cash on delivery is a payment policy: owner only.
    if ((body.codEnabled !== undefined || body.guestCodEnabled !== undefined) && membership.role !== "owner") {
      throw new HttpError(403, "Only the owner can change payment settings", "forbidden");
    }
    if (body.managersCanInvite !== undefined && membership.role !== "owner") {
      throw new HttpError(403, "Only the owner can change who may invite people", "forbidden");
    }
    await dbConnect();

    const business = await Business.findById(id);
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    if (business.status === "suspended") {
      throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
    }

    const { themeSettings, ...rest } = body;
    // Theme changes need a plan that includes the new theme (keeping the
    // current one is always allowed). Checked before any write.
    if (body.themeId !== undefined) {
      await assertCanUseTheme(id, body.themeId, business.themeId);
    }
    await assertMediaUrlsOwned(id, [body.logoUrl]);
    if (themeSettings?.sections) {
      await assertSectionMediaOwned(id, themeSettings.sections);
    }

    // A live store's look and homepage only change through a draft and publishing.
    // Business details (name, logo, contact details) stay direct settings.
    if (business.status === "published") {
      const stored = business.themeSettings as unknown as Record<string, unknown> | undefined;
      if (themeSettings?.sections && JSON.stringify(themeSettings.sections) !== JSON.stringify(stored?.sections ?? null)) {
        throw new HttpError(409, "A live homepage changes through the website editor, not this request.", "use_website_editor");
      }
      const changesDesign =
        (body.themeId !== undefined && body.themeId !== business.themeId) ||
        LIVE_THEME_SETTINGS.some((key) => themeSettings?.[key] !== undefined && themeSettings[key] !== stored?.[key]);
      if (changesDesign) {
        throw new HttpError(409, "A live store's design changes through a draft: save it in Design, then publish it.", "use_design_draft");
      }
    }

    // Validate navigation page references against this business
    if (themeSettings?.navigation) {
      await assertNavigationPagesOwned(id, themeSettings.navigation);
    }

    // Menus are saved first and on their own: an old tab is refused before anything is
    // written, and a save of other settings can never put older menus back.
    const { navigation, ...otherSettings } = themeSettings ?? {};
    const navigationVersion = navigation ? await saveNavigationDraft(id, navigation, { expectedVersion: expectedDraftVersion(request) }) : undefined;

    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) {
        (business as unknown as Record<string, unknown>)[key] = value;
      }
    }
    await business.save();

    // Each setting is written by itself, so settings this request does not name stay as they are.
    const stored = business.themeSettings;
    // Without a published copy the store shows the saved design tokens.
    const liveTokens =
      otherSettings.designTokens && !stored?.publishedDesignTokens
        ? stored?.designTokens
          ? { publishedDesignTokens: stored.designTokens }
          : { designTokensDraftOnly: true }
        : {};
    const settingsToSet = Object.fromEntries(
      Object.entries({ ...liveTokens, ...otherSettings })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [`themeSettings.${key}`, value]),
    );
    // A theme or colours applied directly (theme gallery, setup) replace what a
    // design draft says about them, so publishing it later cannot undo the choice.
    const storedDraft = (stored as { designDraft?: Record<string, unknown> } | undefined)?.designDraft;
    const dropDesignDraft = Boolean(storedDraft) && (body.themeId !== undefined || otherSettings.primaryColor !== undefined || otherSettings.accentColor !== undefined);
    if (Object.keys(settingsToSet).length > 0 || dropDesignDraft) {
      await Business.updateOne(
        { _id: id },
        {
          ...(Object.keys(settingsToSet).length > 0 ? { $set: settingsToSet } : {}),
          ...(dropDesignDraft ? { $unset: { "themeSettings.designDraft": "" }, $inc: { designDraftVersion: 1 } } : {}),
        },
      );
    }

    const latest = await Business.findById(id);
    return ok({ business: (latest ?? business).toJSON(), ...(navigationVersion !== undefined ? { navigationVersion } : {}) });
  });
}

async function assertNavigationPagesOwned(
  businessId: string,
  navigation: StoredNavigation,
): Promise<void> {
  const pageIds = new Set(navigationPageIds(navigation));

  if (pageIds.size === 0) return;

  // Validate all pageIds are valid ObjectIds and belong to this business
  const { assertObjectId } = await import("@/lib/ids");
  for (const pageId of pageIds) {
    assertObjectId(pageId, "page id");
  }

  const foundPages = await Page.find({
    _id: { $in: Array.from(pageIds) },
    business: businessId,
  })
    .select("_id")
    .lean();

  const foundIds = new Set(foundPages.map((p) => String(p._id)));
  for (const pageId of pageIds) {
    if (!foundIds.has(pageId)) {
      throw new HttpError(
        400,
        `Page ${pageId} does not belong to this business or does not exist.`,
        "invalid_navigation_reference",
      );
    }
  }
}

/**
 * Deletes the business (soft; lib/business-deletion.ts). Only its primary owner, from the same site,
 * after typing its exact name and their password. Refused while orders, refunds or a Razorpay-billed
 * plan still need it. The storefront goes offline and nobody can open the business again.
 */
export async function DELETE(request: Request, context: RouteContext) {
  return handle(async () => {
    assertSameOriginJsonRequest(request);
    const { id } = await context.params;
    const { user } = await requireBusinessRole(id, ["owner"]);
    // Bounds password guesses through this form (the login limits do not cover it).
    await enforceRateLimit({ key: `business-delete:${id}:${user._id.toString()}`, limit: 5, windowMs: 60 * 60 * 1000 });
    const body = deleteBusinessSchema.parse(await readJson(request));
    await deleteBusiness({ businessId: id, userId: user._id, confirmName: body.confirmName, password: body.password });
    return ok({ deleted: true });
  });
}
