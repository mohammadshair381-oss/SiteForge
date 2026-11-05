import { z } from "zod";
import { THEME_IDS } from "@/lib/constants";
import { pageSlugSchema } from "@/lib/validation";
import { sectionsArraySchema } from "@/lib/sections";

export const MAX_WEBSITE_PLAN_PAGES = 50;

const HTML_TAG = /<\/?[a-z][^>]*>/i;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
/** A plan is edited in the browser, so all its text is untrusted: plain text only, in every field. */
const plainText = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !HTML_TAG.test(value) && !CONTROL_CHARACTER.test(value), "Use plain text, without HTML or control characters.");
const hasMarkup = (value: unknown): boolean => {
  if (typeof value === "string") return HTML_TAG.test(value);
  if (Array.isArray(value)) return value.some(hasMarkup);
  return Boolean(value) && typeof value === "object" ? Object.values(value as object).some(hasMarkup) : false;
};

const planPageSchema = z
  .object({
    existingPageId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
    expectedVersion: z.number().int().min(0).optional(),
    title: plainText(140, 1),
    slug: pageSlugSchema,
    purpose: plainText(600, 1),
    proposedContent: plainText(4000).prefault(""),
    isHome: z.boolean(),
    sections: sectionsArraySchema,
  })
  .strict();

export const websitePlanSchema = z
  .object({
    businessSummary: plainText(2000, 1),
    targetAudience: plainText(500, 1),
    recommendedTheme: z.enum(THEME_IDS),
    requestedPageCount: z.number().int().min(1).max(MAX_WEBSITE_PLAN_PAGES),
    designPreferences: z
      .object({
        notes: plainText(1000).prefault(""),
        primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        font: z.enum(["sans", "serif", "mono"]).optional(),
      })
      .strict(),
    specialRequirements: plainText(2000).prefault(""),
    productIds: z
      .array(z.string().regex(/^[a-f0-9]{24}$/i))
      .max(100)
      .prefault([])
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: "Products can only be selected once",
      }),
    pages: z.array(planPageSchema).min(1).max(MAX_WEBSITE_PLAN_PAGES),
    navigation: z
      .array(
        z
          .object({
            pageSlug: pageSlugSchema,
            label: plainText(60, 1),
          })
          .strict(),
      )
      .max(MAX_WEBSITE_PLAN_PAGES)
      .prefault([]),
    assumptions: z.array(plainText(500, 1)).max(20).prefault([]),
    unansweredQuestions: z
      .array(plainText(500, 1))
      .max(20)
      .prefault([]),
    summary: plainText(2000, 1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.requestedPageCount !== plan.pages.length) {
      ctx.addIssue({
        code: "custom",
        message: "Requested page count must match the pages in the plan",
        path: ["requestedPageCount"],
      });
    }

    const slugs = new Set<string>();
    const existingPageIds = new Set<string>();
    let homeCount = 0;
    for (let index = 0; index < plan.pages.length; index += 1) {
      const page = plan.pages[index];
      if (slugs.has(page.slug)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate page slug: ${page.slug}`,
          path: ["pages", index, "slug"],
        });
      }
      slugs.add(page.slug);
      if (page.existingPageId) {
        const existingPageId = page.existingPageId.toLowerCase();
        if (page.expectedVersion === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "A current version is required when replacing an existing page",
            path: ["pages", index, "expectedVersion"],
          });
        }
        if (existingPageIds.has(existingPageId)) {
          ctx.addIssue({
            code: "custom",
            message: "An existing page can only be selected once",
            path: ["pages", index, "existingPageId"],
          });
        }
        existingPageIds.add(existingPageId);
      } else if (page.expectedVersion !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "A page version can only be supplied when replacing an existing page",
          path: ["pages", index, "expectedVersion"],
        });
      }
      if (page.isHome) homeCount += 1;
      page.sections.forEach((section, sectionIndex) => {
        if (hasMarkup(section.settings)) {
          ctx.addIssue({
            code: "custom",
            message: "Use plain text in sections, without HTML.",
            path: ["pages", index, "sections", sectionIndex, "settings"],
          });
        }
      });
    }

    if (homeCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Choose exactly one homepage",
        path: ["pages"],
      });
    }

    const navigationSlugs = new Set<string>();
    for (let index = 0; index < plan.navigation.length; index += 1) {
      const item = plan.navigation[index];
      if (navigationSlugs.has(item.pageSlug)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate navigation reference: ${item.pageSlug}`,
          path: ["navigation", index, "pageSlug"],
        });
      }
      if (!slugs.has(item.pageSlug)) {
        ctx.addIssue({
          code: "custom",
          message: `Navigation references an unknown page: ${item.pageSlug}`,
          path: ["navigation", index, "pageSlug"],
        });
      }
      navigationSlugs.add(item.pageSlug);
    }
  });

export type WebsitePlan = z.infer<typeof websitePlanSchema>;

export interface WebsitePlanningProviderRequest {
  businessSummary: string;
  targetAudience: string;
  requestedPageCount: number;
  pages: Array<{
    title: string;
    purpose: string;
    requiredContent: string;
  }>;
  preferredTheme: WebsitePlan["recommendedTheme"];
  designPreferences: WebsitePlan["designPreferences"];
  productIds: string[];
  specialRequirements: string;
}
