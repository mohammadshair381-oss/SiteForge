import { z } from "zod";
import {
  editingActionsSchema,
  editingContextSchema,
  type EditingAction,
  type EditingContext,
  type EditingPage,
} from "./actions";
import type { Section } from "@/lib/sections";

const diffIdSchema = z.string().min(1).max(80);

export const editingChangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      actionId: diffIdSchema,
      kind: z.literal("create-page"),
      pageId: diffIdSchema,
      slug: z.string().min(1).max(80),
      title: z.string().min(1).max(140),
    })
    .strict(),
  z
    .object({
      actionId: diffIdSchema,
      kind: z.enum(["update-section", "add-section", "remove-section"]),
      pageId: diffIdSchema,
      sectionId: diffIdSchema,
    })
    .strict(),
  z
    .object({
      actionId: diffIdSchema,
      kind: z.literal("reorder-sections"),
      pageId: diffIdSchema,
      sectionId: diffIdSchema,
      fromIndex: z.number().int().min(0).max(49),
      toIndex: z.number().int().min(0).max(49),
    })
    .strict(),
]);

export const editingDiffSummarySchema = z
  .object({
    actionsApplied: z.number().int().min(0).max(100),
    pagesCreated: z.number().int().min(0).max(100),
    sectionsAdded: z.number().int().min(0).max(100),
    sectionsUpdated: z.number().int().min(0).max(100),
    sectionsRemoved: z.number().int().min(0).max(100),
    sectionsReordered: z.number().int().min(0).max(100),
  })
  .strict();

export const editingDiffSchema = z
  .object({
    changes: z.array(editingChangeSchema).max(100),
    summary: editingDiffSummarySchema,
  })
  .strict();

export type EditingChange = z.infer<typeof editingChangeSchema>;
export type EditingDiffSummary = z.infer<typeof editingDiffSummarySchema>;

export interface EditingResult {
  draft: EditingContext;
  changes: EditingChange[];
  summary: EditingDiffSummary;
}

export type EditingEngineErrorCode =
  | "page_not_found"
  | "page_not_draft"
  | "version_conflict"
  | "section_not_found"
  | "duplicate_page_id"
  | "duplicate_page_slug"
  | "duplicate_section_id"
  | "section_limit_exceeded"
  | "page_limit_exceeded"
  | "invalid_reorder"
  | "unsupported_section_change"
  | "unapproved_media_reference"
  | "html_not_allowed";

export class EditingEngineError extends Error {
  constructor(
    message: string,
    readonly code: EditingEngineErrorCode,
  ) {
    super(message);
    this.name = "EditingEngineError";
  }
}

const MAX_SECTIONS_PER_PAGE = 50;

function fail(message: string, code: EditingEngineErrorCode): never {
  throw new EditingEngineError(message, code);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function findImageUrls(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findImageUrls);

  const record = value as Record<string, unknown>;
  const urls: string[] = [];
  if (typeof record.imageUrl === "string" && record.imageUrl.length > 0) {
    urls.push(record.imageUrl);
  }
  if (typeof record.url === "string" && record.url.length > 0) {
    urls.push(record.url);
  }
  return urls.concat(
    Object.entries(record)
      .filter(([key]) => key !== "imageUrl" && key !== "url")
      .flatMap(([, nested]) => findImageUrls(nested)),
  );
}

function assertApprovedMedia(
  sections: readonly Section[],
  allowedMediaUrls: ReadonlySet<string>,
): void {
  for (const section of sections) {
    const settings = section.settings as unknown;
    for (const url of findImageUrls(settings)) {
      if (!allowedMediaUrls.has(url)) {
        fail(
          "A section references media that is not in the approved editing context.",
          "unapproved_media_reference",
        );
      }
    }
  }
}

function assertNoHtml(value: unknown): void {
  if (typeof value === "string") {
    if (/<\/?[a-z][^>]*>/i.test(value)) {
      fail("HTML markup is not supported in editing actions.", "html_not_allowed");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoHtml);
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach(assertNoHtml);
  }
}

function orderedSections(sections: readonly Section[]): Section[] {
  return [...sections]
    .sort((left, right) => left.order - right.order)
    .map((section, order) => ({ ...section, order }));
}

function renumberSections(sections: readonly Section[]): Section[] {
  return [...sections]
    .map((section, order) => ({ ...section, order }));
}

function getMutablePage(
  pages: EditingPage[],
  action: Exclude<EditingAction, { kind: "create-page" }>,
  baselineVersions: ReadonlyMap<string, number>,
): EditingPage {
  const page = pages.find((candidate) => candidate.id === action.pageId);
  if (!page) {
    return fail("The target page does not exist in the editing context.", "page_not_found");
  }
  if (page.status !== "draft") {
    return fail("Published pages cannot be changed by editing actions.", "page_not_draft");
  }
  const expectedVersion = baselineVersions.get(page.id);
  if (expectedVersion === undefined || action.expectedVersion !== expectedVersion) {
    return fail("The target page version is stale.", "version_conflict");
  }
  return page;
}

function assertSectionLimit(sections: readonly Section[]): void {
  if (sections.length > MAX_SECTIONS_PER_PAGE) {
    fail("A page cannot contain more than 50 sections.", "section_limit_exceeded");
  }
}

function applyAction(
  pages: EditingPage[],
  action: EditingAction,
  baselineVersions: ReadonlyMap<string, number>,
  allowedMediaUrls: ReadonlySet<string>,
): EditingChange {
  if (action.kind === "create-page") {
    assertNoHtml(action.title);
    if (pages.length >= 50) {
      fail("The editing context cannot contain more than 50 pages.", "page_limit_exceeded");
    }
    const id = `proposal-${action.actionId}`;
    if (pages.some((page) => page.id === id)) {
      fail("The proposed page identifier is already in use.", "duplicate_page_id");
    }
    if (pages.some((page) => page.slug === action.slug)) {
      fail("The proposed page slug is already in use.", "duplicate_page_slug");
    }
    assertNoHtml(action.sections);
    assertSectionLimit(action.sections);
    assertApprovedMedia(action.sections, allowedMediaUrls);
    pages.push({
      id,
      title: action.title,
      slug: action.slug,
      status: "draft",
      version: 0,
      sections: orderedSections(action.sections),
    });
    return {
      actionId: action.actionId,
      kind: action.kind,
      pageId: id,
      slug: action.slug,
      title: action.title,
    };
  }

  const page = getMutablePage(pages, action, baselineVersions);

  if (action.kind === "update-section") {
    assertNoHtml(action.section.settings);
    if (action.section.type === "products" && "productIds" in action.section.settings) {
      fail("Product references are not supported by this editing contract.", "unsupported_section_change");
    }
    const index = page.sections.findIndex(
      (section) => section.id === action.section.id,
    );
    if (index < 0) {
      return fail("The target section does not exist on this page.", "section_not_found");
    }
    const current = page.sections[index];
    if (
      current.type !== action.section.type ||
      current.order !== action.section.order ||
      current.visible !== action.section.visible ||
      JSON.stringify(current.style ?? null) !== JSON.stringify(action.section.style ?? null)
    ) {
      fail(
        "Updating a section may change only its supported settings.",
        "unsupported_section_change",
      );
    }
    assertApprovedMedia([action.section], allowedMediaUrls);
    page.sections[index] = {
      ...current,
      settings: deepClone(action.section.settings),
    } as Section;
    return {
      actionId: action.actionId,
      kind: action.kind,
      pageId: page.id,
      sectionId: current.id,
    };
  }

  if (action.kind === "add-section") {
    assertNoHtml(action.section.settings);
    assertApprovedMedia([action.section], allowedMediaUrls);
    const sections = orderedSections(page.sections);
    if (sections.length >= MAX_SECTIONS_PER_PAGE) {
      fail("A page cannot contain more than 50 sections.", "section_limit_exceeded");
    }
    if (action.index > sections.length) {
      fail("The insertion index is outside the page's section list.", "invalid_reorder");
    }
    if (sections.some((section) => section.id === action.section.id)) {
      fail("The section identifier is already in use on this page.", "duplicate_section_id");
    }
    sections.splice(action.index, 0, deepClone(action.section));
    page.sections = renumberSections(sections);
    return {
      actionId: action.actionId,
      kind: action.kind,
      pageId: page.id,
      sectionId: action.section.id,
    };
  }

  if (action.kind === "remove-section") {
    const sections = orderedSections(page.sections);
    const index = sections.findIndex((section) => section.id === action.sectionId);
    if (index < 0) {
      return fail("The target section does not exist on this page.", "section_not_found");
    }
    sections.splice(index, 1);
    page.sections = renumberSections(sections);
    return {
      actionId: action.actionId,
      kind: action.kind,
      pageId: page.id,
      sectionId: action.sectionId,
    };
  }

  const sections = orderedSections(page.sections);
  const fromIndex = sections.findIndex((section) => section.id === action.sectionId);
  if (fromIndex < 0) {
    return fail("The target section does not exist on this page.", "section_not_found");
  }
  if (action.toIndex >= sections.length || action.toIndex === fromIndex) {
    return fail("The requested section position is invalid.", "invalid_reorder");
  }
  const [moved] = sections.splice(fromIndex, 1);
  sections.splice(action.toIndex, 0, moved);
  page.sections = renumberSections(sections);
  return {
    actionId: action.actionId,
    kind: action.kind,
    pageId: page.id,
    sectionId: action.sectionId,
    fromIndex,
    toIndex: action.toIndex,
  };
}

function summarize(changes: EditingChange[]): EditingDiffSummary {
  const summary: EditingDiffSummary = {
    actionsApplied: changes.length,
    pagesCreated: 0,
    sectionsAdded: 0,
    sectionsUpdated: 0,
    sectionsRemoved: 0,
    sectionsReordered: 0,
  };
  for (const change of changes) {
    switch (change.kind) {
      case "create-page":
        summary.pagesCreated += 1;
        break;
      case "add-section":
        summary.sectionsAdded += 1;
        break;
      case "update-section":
        summary.sectionsUpdated += 1;
        break;
      case "remove-section":
        summary.sectionsRemoved += 1;
        break;
      case "reorder-sections":
        summary.sectionsReordered += 1;
        break;
    }
  }
  return summary;
}

/**
 * Applies validated editing actions to a cloned in-memory draft. The function
 * revalidates all runtime input and returns nothing if any action fails.
 * `allowedMediaUrls` must come from a trusted context loader that validates
 * existing URLs and platform-media ownership; this pure function cannot verify
 * ownership or persist changes.
 */
export function applyEditingActions(
  contextInput: unknown,
  actionsInput: unknown,
): EditingResult {
  const context = editingContextSchema.parse(contextInput);
  const actions = editingActionsSchema.parse(actionsInput);
  const draft = deepClone(context);
  const baselineVersions = new Map(
    context.pages.map((page) => [page.id, page.version]),
  );
  const allowedMediaUrls = new Set(context.allowedMediaUrls);

  const changes = actions.map((action) =>
    applyAction(draft.pages, action, baselineVersions, allowedMediaUrls),
  );

  const verifiedDraft = editingContextSchema.parse(draft);
  return {
    draft: verifiedDraft,
    changes,
    summary: summarize(changes),
  };
}
