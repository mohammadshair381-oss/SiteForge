import mongoose from "mongoose";
import { DEFAULT_THEME_SETTINGS } from "@/lib/storefront";
import { presetConfig } from "@/lib/storefront-config";
import { dbConnect } from "@/lib/db";
import { handle, ok, created, HttpError, readJson } from "@/lib/api";
import { requireUser, requireVerifiedEmail, getMembershipsForUser } from "@/lib/auth/guards";
import { businessCreateSchema } from "@/lib/validation";
import { slugify, isValidSubdomain } from "@/lib/slug";
import { getEntitlements } from "@/lib/billing";
import { FREE_THEMES, defaultThemeFor, planThemes } from "@/lib/theme-tiers";
import { getThemeMeta } from "@/lib/themes";
import { generateDefaultPages } from "@/lib/page-generation";
import { addSampleProducts } from "@/lib/sample-products";
import { assertNotInMaintenance } from "@/lib/platform-settings";
import { Business, Membership, Subscription, Plan, Category } from "@/models";

interface ExistenceModel {
  exists(filter: Record<string, unknown>): Promise<unknown>;
}

async function uniqueValue(
  model: ExistenceModel,
  field: "slug" | "subdomain",
  base: string,
): Promise<string> {
  let candidate = base;
  let counter = 1;
  // Bounded loop; slugified names collide rarely.
  while (await model.exists({ [field]: candidate })) {
    counter += 1;
    candidate = `${base}-${counter}`.slice(0, 64);
  }
  return candidate;
}

export async function GET() {
  return handle(async () => {
    const user = await requireUser();
    const memberships = await getMembershipsForUser(user._id.toString());
    return ok({
      businesses: memberships.map((membership) => ({
        id: String(membership._id),
        role: membership.role,
        business: membership.business,
      })),
    });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireVerifiedEmail();
    await assertNotInMaintenance();
    const body = businessCreateSchema.parse(await readJson(request));

    let base = body.subdomain?.trim().toLowerCase() || slugify(body.name);
    if (!isValidSubdomain(base)) {
      base = `biz-${Date.now().toString(36)}`;
    }

    // A new business starts on the free plan (attached below when configured):
    // its theme must be one that plan includes. Without a theme in the request,
    // the best included theme for the business type is used.
    await dbConnect();
    const startingPlan = await Plan.findOne({ key: "free", active: true }).select("key price features").lean();
    const allowedThemes = startingPlan ? planThemes(startingPlan) : [...FREE_THEMES];
    if (body.themeId && !allowedThemes.includes(body.themeId)) {
      throw new HttpError(402, `The ${getThemeMeta(body.themeId).name} theme is not included in the free plan. Choose another theme, then upgrade to switch.`, "theme_not_in_plan");
    }
    const themeId = body.themeId ?? defaultThemeFor(body.category, allowedThemes);

    const slug = await uniqueValue(Business, "slug", base);
    const subdomain = await uniqueValue(Business, "subdomain", base);

    // Onboarding is atomic: the Business, its initial owner Membership and its
    // initial Subscription either all commit or all roll back. Every write is
    // bound to the same session so it participates in the transaction; the
    // session is always ended in `finally`.
    const session = await mongoose.startSession();
    try {
      const business = await session.withTransaction(async () => {
        const [businessDoc] = await Business.create(
          [
            {
              name: body.name,
              slug,
              subdomain,
              category: body.category,
              owner: user._id,
              description: body.description ?? "",
              themeId,
              // Starting homepage for this business type (draft; published
              // with the store). Owners can change every part of it.
              themeSettings: { ...DEFAULT_THEME_SETTINGS, storefront: presetConfig(body.category) },
            },
          ],
          { session },
        );

        await Membership.create(
          [
            {
              business: businessDoc._id,
              user: user._id,
              role: "owner",
              status: "active",
            },
          ],
          { session },
        );

        // Attach the free plan (if configured) so the business has baseline access.
        const freePlan = await Plan.findOne({ key: "free", active: true }).session(session);
        if (freePlan) {
          const now = new Date();
          const periodEnd = new Date(now);
          periodEnd.setDate(periodEnd.getDate() + 30);
          await Subscription.create(
            [
              {
                business: businessDoc._id,
                plan: freePlan._id,
                status: "active",
                provider: "manual",
                currentPeriodStart: now,
                currentPeriodEnd: periodEnd,
              },
            ],
            { session },
          );
        }

        return businessDoc;
      });

      // Default website pages for this business type, as DRAFTS (best effort:
      // after the creation committed, so a failure never blocks onboarding;
      // the owner can prepare them later from Pages).
      try {
        await generateDefaultPages(business._id.toString());
      } catch {
        console.error("[pages] default pages not prepared at business creation");
      }

      // Quick start: a few starter samples, as hidden drafts (best effort, like the pages).
      let samplesAdded = 0;
      if (body.addSamples === true) {
        try {
          samplesAdded = await addSampleProducts(business._id.toString());
        } catch {
          console.error("[products] sample products not prepared at business creation");
        }
      }

      const entitlements = await getEntitlements(business._id.toString());
      return created({ business: business.toJSON(), entitlements, samplesAdded });
    } finally {
      await session.endSession();
    }
  });
}
