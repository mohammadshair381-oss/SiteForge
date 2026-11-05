import { publishDesignDraft } from "@/lib/design-service";
import type { StoredNavigation } from "@/lib/navigation";
import { PUBLISH_ROLES, assertPublishNavigationValid } from "@/lib/publish-gates";
import mongoose from "mongoose";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { requireVerifiedEmail, requireBusinessRole } from "@/lib/auth/guards";
import { assertCanPublish } from "@/lib/billing";
import { assertNotInMaintenance } from "@/lib/platform-settings";
import { publishSchema } from "@/lib/validation";
import { Business } from "@/models/Business";
import { Page } from "@/models/Page";
import { assertNoHomePlaceholders, assertNoLegacyHomePlaceholders, storefrontSnapshot } from "@/lib/storefront-settings";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    // Verification is checked before any membership/entitlement work and before
    // any write; the business-role guard still runs afterwards, unchanged.
    await requireVerifiedEmail();
    await requireBusinessRole(id, PUBLISH_ROLES);
    const { publish } = publishSchema.parse(await readJson(request));

    const business = await Business.findById(id);
    if (!business) throw new HttpError(404, "Business not found", "not_found");

    // A suspended business is frozen until a super admin explicitly changes its
    // status. Owners must not be able to publish OR unpublish out of suspension.
    if (business.status === "suspended") {
      throw new HttpError(
        403,
        "This business is suspended. Contact a platform administrator.",
        "suspended",
      );
    }

    if (publish) {
      await assertNotInMaintenance();
      await assertCanPublish(id);
      // Validate navigation page references before publishing
      await assertPublishNavigationValid(id, business.themeSettings?.navigation as StoredNavigation | undefined);
      // A homepage kept in the settings goes live with the store, unless a published Home page replaces it.
      if (!(await Page.exists({ business: id, isHome: true, status: "published" }))) {
        assertNoLegacyHomePlaceholders(business.themeSettings?.sections);
      }
      business.status = "published";
      business.publishedAt = new Date();
      // Snapshot draft navigation and design tokens for the published storefront
      // Create new objects to ensure Mongoose detects the change on Mixed fields
      if (business.themeSettings?.navigation) {
        const ts = business.themeSettings as unknown as Record<string, unknown>;
        ts.publishedNavigation = {
          header: [...(business.themeSettings.navigation.header ?? [])],
          footer: [...(business.themeSettings.navigation.footer ?? [])],
        };
        business.themeSettings = { ...business.themeSettings, ...ts } as any;
      }
      if (business.themeSettings?.designTokens) {
        const ts = business.themeSettings as unknown as Record<string, unknown>;
        ts.publishedDesignTokens = { ...business.themeSettings.designTokens };
        business.themeSettings = { ...business.themeSettings, ...ts } as any;
      }
      // Storefront homepage settings follow the same draft -> published rule.
      const storefront = storefrontSnapshot(business.themeSettings, business.category);
      if (storefront) {
        assertNoHomePlaceholders(storefront);
        business.themeSettings = { ...business.themeSettings, publishedStorefront: storefront } as any;
      }
      business.markModified("themeSettings");
    } else {
      business.status = "draft";
      business.publishedAt = null;
    }

    // The suspension check above ran before the (slower) entitlement and
    // navigation checks. Make the write itself conditional so a suspension that
    // lands in between can never be overwritten by this publish/unpublish.
    business.$where = { status: { $ne: "suspended" } };
    try {
      await business.save();
    } catch (error) {
      if (error instanceof mongoose.Error.DocumentNotFoundError) {
        throw new HttpError(
          403,
          "This business is suspended. Contact a platform administrator.",
          "suspended",
        );
      }
      throw error;
    }

    // Publishing the store also publishes the design draft, like its menus and homepage.
    if (publish) await publishDesignDraft(id, { requirePlan: false });

    // Only report published after the write succeeded.
    return ok({
      status: business.status,
      publishedAt: business.publishedAt,
    });
  });
}
