import { z } from "zod";
import { pageSlugSchema } from "@/lib/validation";
import {
  LOCAL_MEDIA_PATH,
  sectionsArraySchema,
  sectionSchema,
  type Section,
} from "@/lib/sections";
import { MAX_WEBSITE_PLAN_PAGES } from "./plan";

export const MAX_EDITING_ACTIONS = 100;
export const MAX_EDITING_CONTEXT_PAGES = MAX_WEBSITE_PLAN_PAGES;

const actionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i);
const pageIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i);
const sectionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i);

function containsOnlySchemaKeys(input: unknown, parsed: unknown): boolean {
  if (Array.isArray(input)) {
    return (
      Array.isArray(parsed) &&
      input.length === parsed.length &&
      input.every((value, index) =>
        containsOnlySchemaKeys(value, parsed[index]),
      )
    );
  }
  if (!input || typeof input !== "object") return true;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;

  const parsedRecord = parsed as Record<string, unknown>;
  return Object.entries(input).every(
    ([key, value]) =>
      Object.hasOwn(parsedRecord, key) &&
      containsOnlySchemaKeys(value, parsedRecord[key]),
  );
}

function containsHtmlMarkup(value: unknown): boolean {
  if (typeof value === "string") return /<\/?[a-z][^>]*>/i.test(value);
  if (Array.isArray(value)) return value.some(containsHtmlMarkup);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsHtmlMarkup);
}

const validatedSectionSchema = z.unknown().transform((value, ctx): Section => {
  const result = sectionSchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: "custom",
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }
  if (!containsOnlySchemaKeys(value, result.data)) {
    ctx.addIssue({
      code: "custom",
      message: "Section contains unsupported fields.",
    });
    return z.NEVER;
  }
  if (containsHtmlMarkup(result.data.settings)) {
    ctx.addIssue({
      code: "custom",
      message: "HTML markup is not supported in editing actions.",
    });
    return z.NEVER;
  }
  return result.data;
});

const validatedSectionsArraySchema = z
  .unknown()
  .transform((value, ctx): Section[] => {
    const result = sectionsArraySchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
      return z.NEVER;
    }
    if (!containsOnlySchemaKeys(value, result.data)) {
      ctx.addIssue({
        code: "custom",
        message: "Section contains unsupported fields.",
      });
      return z.NEVER;
    }
    if (containsHtmlMarkup(result.data)) {
      ctx.addIssue({
        code: "custom",
        message: "HTML markup is not supported in editing actions.",
      });
      return z.NEVER;
    }
    return result.data;
  });

const baseAction = {
  actionId: actionIdSchema,
};

const updateSectionActionSchema = z
  .object({
    ...baseAction,
    kind: z.literal("update-section"),
    pageId: pageIdSchema,
    expectedVersion: z.number().int().min(0),
    section: validatedSectionSchema,
  })
  .strict();

const addSectionActionSchema = z
  .object({
    ...baseAction,
    kind: z.literal("add-section"),
    pageId: pageIdSchema,
    expectedVersion: z.number().int().min(0),
    index: z.number().int().min(0).max(50),
    section: validatedSectionSchema,
  })
  .strict();

const removeSectionActionSchema = z
  .object({
    ...baseAction,
    kind: z.literal("remove-section"),
    pageId: pageIdSchema,
    expectedVersion: z.number().int().min(0),
    sectionId: sectionIdSchema,
  })
  .strict();

const reorderSectionsActionSchema = z
  .object({
    ...baseAction,
    kind: z.literal("reorder-sections"),
    pageId: pageIdSchema,
    expectedVersion: z.number().int().min(0),
    sectionId: sectionIdSchema,
    toIndex: z.number().int().min(0).max(49),
  })
  .strict();

const createPageActionSchema = z
  .object({
    ...baseAction,
    kind: z.literal("create-page"),
    title: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .refine((value) => !containsHtmlMarkup(value), {
        message: "HTML markup is not supported in editing actions.",
      }),
    slug: pageSlugSchema,
    sections: validatedSectionsArraySchema
      .refine((sections) => sections.length > 0, {
        message: "A new page must contain at least one section.",
      }),
  })
  .strict();

/**
 * One validated editing operation. Existing-page operations include both a
 * page identifier and expectedVersion so a future apply route can recheck
 * authorization, ownership, draft status, and concurrency at write time.
 * Section objects are validated by the existing CMS schema; only update
 * operations may change an existing section's settings.
 */
export const editingActionSchema = z.discriminatedUnion("kind", [
  updateSectionActionSchema,
  addSectionActionSchema,
  removeSectionActionSchema,
  reorderSectionsActionSchema,
  createPageActionSchema,
]);

export const editingActionsSchema = z
  .array(editingActionSchema)
  .min(1)
  .max(MAX_EDITING_ACTIONS)
  .superRefine((actions, ctx) => {
    const actionIds = new Set<string>();
    actions.forEach((action, index) => {
      if (actionIds.has(action.actionId)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate action id: ${action.actionId}`,
          path: [index, "actionId"],
        });
      }
      actionIds.add(action.actionId);
    });
  });

const httpsMediaUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  })
  .or(z.string().regex(LOCAL_MEDIA_PATH));

export const editingContextSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            id: pageIdSchema,
            title: z.string().trim().min(1).max(140),
            slug: pageSlugSchema,
            status: z.enum(["draft", "published"]),
            version: z.number().int().min(0),
            sections: validatedSectionsArraySchema,
          })
          .strict(),
      )
      .max(MAX_EDITING_CONTEXT_PAGES),
    /**
     * Trusted, already-approved media URLs for this business. A server-side
     * context loader must populate this from validated existing references and
     * platform-media ownership checks; this schema only verifies URL shape.
     */
    allowedMediaUrls: z
      .array(httpsMediaUrlSchema)
      .max(1000)
      .refine((urls) => new Set(urls).size === urls.length, {
        message: "Media URLs must be unique.",
      }),
  })
  .strict()
  .superRefine((context, ctx) => {
    const pageIds = new Set<string>();
    const slugs = new Set<string>();
    for (let index = 0; index < context.pages.length; index += 1) {
      const page = context.pages[index];
      if (pageIds.has(page.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate page id: ${page.id}`,
          path: ["pages", index, "id"],
        });
      }
      pageIds.add(page.id);
      if (slugs.has(page.slug)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate page slug: ${page.slug}`,
          path: ["pages", index, "slug"],
        });
      }
      slugs.add(page.slug);
    }
  });

export type EditingAction = z.infer<typeof editingActionSchema>;
export type EditingActions = z.infer<typeof editingActionsSchema>;
export type EditingPage = z.infer<typeof editingContextSchema>["pages"][number];
export type EditingContext = z.infer<typeof editingContextSchema>;