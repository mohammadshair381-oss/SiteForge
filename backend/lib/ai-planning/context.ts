import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { assertObjectId } from "@/lib/ids";
import { mediaPublicBaseUrls } from "@/lib/media";
import { pageSlugSchema } from "@/lib/validation";
import {
  assertSectionMediaOwned,
  getSectionImageUrls,
  parseMediaStorageUrlOrLocal,
} from "@/lib/media-references";
import { editingContextSchema, MAX_EDITING_CONTEXT_PAGES } from "./actions";
import type { EditingContext } from "./actions";
import { sectionsArraySchema, type Section } from "@/lib/sections";
import { Business } from "@/models/Business";
import { Media } from "@/models/Media";
import { Page } from "@/models/Page";

const pageSelectionSchema = z
  .array(z.string().regex(/^[a-f0-9]{24}$/i))
  .max(MAX_EDITING_CONTEXT_PAGES)
  .refine(
    (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length,
    { message: "Page IDs must be unique." },
  )
  .optional();

const businessContextSchema = z
  .object({
    name: z.string().trim().min(1).max(140),
    category: z.string().trim().min(1).max(80),
    description: z.string().max(2000),
  })
  .strict();

const pageMetadataSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{24}$/i),
    title: z.string().trim().min(1).max(140),
    slug: pageSlugSchema,
    status: z.enum(["draft", "published"]),
    version: z.number().int().min(0),
    isHome: z.boolean(),
    sections: sectionsArraySchema,
    editable: z.boolean(),
  })
  .strict();

export type WebsiteEditingPageContext = z.infer<typeof pageMetadataSchema>;
export type WebsiteEditingContext = {
  business: z.infer<typeof businessContextSchema>;
  pages: WebsiteEditingPageContext[];
  editingContext: EditingContext;
};

export class WebsiteEditingContextError extends HttpError {
  constructor(status: number, message: string, code: string) {
    super(status, message, code);
    this.name = "WebsiteEditingContextError";
  }
}

function invalidStoredPage(): WebsiteEditingContextError {
  return new WebsiteEditingContextError(
    409,
    "A page contains content that cannot be used for website editing. Review it in the page editor first.",
    "invalid_stored_page_content",
  );
}

function invalidContext(): WebsiteEditingContextError {
  return new WebsiteEditingContextError(
    409,
    "The website context is not valid for editing.",
    "invalid_website_editing_context",
  );
}

/**
 * Loads a minimal, tenant-scoped in-memory website context for draft editing.
 * Owner and manager membership is required. When pageIds is supplied, only
 * those business-owned pages are loaded; only selected drafts are passed to
 * the editing engine. With no selection, business pages are read-only context.
 *
 * This function does not apply actions or write to the database. It must only
 * be called from server code; its authorization and data loading dependencies
 * are server-side modules.
 */
export async function loadWebsiteEditingContext(
  businessId: string,
  pageIds?: readonly string[],
): Promise<WebsiteEditingContext> {
  await requireBusinessRole(businessId, ["owner", "manager"]);
  const selectedPageIds = pageSelectionSchema.parse(pageIds);
  const authorizedBusinessId = assertObjectId(businessId, "business id");
  const selectedIds = selectedPageIds?.map((id) => assertObjectId(id, "page id"));

  await dbConnect();

  const [business, pageDocuments] = await Promise.all([
    Business.findById(authorizedBusinessId)
      .select("name category description")
      .lean(),
    Page.find({
      business: authorizedBusinessId,
      ...(selectedIds === undefined ? {} : { _id: { $in: selectedIds } }),
    })
      .select("_id title slug status version isHome sections publishedSections")
      .sort({ isHome: -1, createdAt: 1 })
      .limit(MAX_EDITING_CONTEXT_PAGES + 1)
      .lean(),
  ]);

  if (!business) {
    throw new WebsiteEditingContextError(404, "Business not found.", "not_found");
  }
  if (selectedIds && pageDocuments.length !== selectedIds.length) {
    throw new WebsiteEditingContextError(
      404,
      "One or more selected pages were not found.",
      "page_not_found",
    );
  }
  if (pageDocuments.length > MAX_EDITING_CONTEXT_PAGES) {
    throw new WebsiteEditingContextError(
      413,
      "Select up to 50 pages to prepare website editing context.",
      "editing_context_too_large",
    );
  }

  const parsedBusiness = businessContextSchema.safeParse({
    name: business.name,
    category: business.category,
    description: business.description,
  });
  if (!parsedBusiness.success) throw invalidContext();

  const selectedDraftIds = new Set(
    (selectedIds ?? []).map((id) => id.toLowerCase()),
  );
  const pages: WebsiteEditingPageContext[] = pageDocuments.map((page) => {
    const storedSections =
      page.status === "published" &&
      Array.isArray(page.publishedSections) &&
      page.publishedSections.length > 0
        ? page.publishedSections
        : page.sections;
    const parsedSections = sectionsArraySchema.safeParse(storedSections);
    if (!parsedSections.success) throw invalidStoredPage();

    const parsedPage = pageMetadataSchema.safeParse({
      id: String(page._id),
      title: page.title,
      slug: page.slug,
      status: page.status,
      version: page.version,
      isHome: page.isHome,
      sections: parsedSections.data,
      editable:
        page.status === "draft" && selectedDraftIds.has(String(page._id).toLowerCase()),
    });
    if (!parsedPage.success) throw invalidStoredPage();
    return parsedPage.data;
  });

  const editablePages = pages.filter((page) => page.editable);
  const editableSections = editablePages.flatMap((page) => page.sections);

  try {
    await assertSectionMediaOwned(authorizedBusinessId, editableSections);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.code === "invalid_media_reference"
    ) {
      throw new WebsiteEditingContextError(
        409,
        "A selected draft references media that is not available to this business.",
        "invalid_stored_media_reference",
      );
    }
    throw error;
  }

  const allowedMediaUrls = await approvedMediaUrls(authorizedBusinessId, editableSections);

  const parsedEditingContext = editingContextSchema.safeParse({
    pages: editablePages.map((page) => ({
      id: page.id,
      title: page.title,
      slug: page.slug,
      status: page.status,
      version: page.version,
      sections: page.sections,
    })),
    allowedMediaUrls,
  });
  if (!parsedEditingContext.success) throw invalidContext();

  return {
    business: parsedBusiness.data,
    pages,
    editingContext: parsedEditingContext.data,
  };
}

/**
 * The image URLs in `sections` that are this business's own, active media:
 * the only media a proposal may reference. Callers authorize first.
 */
export async function approvedMediaUrls(businessId: string, sections: Section[]): Promise<string[]> {
  const referencedMedia = new Map<string, string>();
  for (const url of getSectionImageUrls(sections)) {
    // Same bases as assertMediaUrlsOwned (S3_PUBLIC_URL, legacy AWS_* name,
    // migration base), so owned bucket images are allowlisted consistently.
    const reference = parseMediaStorageUrlOrLocal(url, mediaPublicBaseUrls());
    if (reference && reference.businessId === businessId.toLowerCase()) {
      referencedMedia.set(reference.storageKey, url);
    }
  }
  if (referencedMedia.size === 0) return [];
  const active = await Media.find({ business: businessId, storageKey: { $in: [...referencedMedia.keys()] }, deletedAt: null })
    .select("storageKey")
    .lean();
  return active.map((record) => referencedMedia.get(record.storageKey)).filter((url): url is string => url !== undefined);
}
