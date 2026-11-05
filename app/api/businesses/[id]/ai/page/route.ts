import mongoose from "mongoose";
import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { runAiRequest } from "@/lib/ai-builder/request";
import { explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { instructionSchema, pagePrompt } from "@/lib/ai-builder/prompts";
import { pageTypeOf } from "@/lib/ai-builder/intent";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import {
  PageBuildError,
  aiNewPageSchema,
  aiPageEditSchema,
  aiPageTexts,
  buildDraftCopyAction,
  buildNewPageAction,
  buildPageEditActions,
} from "@/lib/ai-builder/page-builder";
import { approvedMediaUrls } from "@/lib/ai-planning/context";
import { createProposal } from "@/lib/ai-planning/proposal-service";
import { getSectionImageUrls } from "@/lib/media-references";
import { sectionSchema, type Section } from "@/lib/sections";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    instruction: instructionSchema,
    /** The page to change; omitted = write a new page. */
    pageId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid page").optional(),
    /** For a published page: put the improved version in a NEW draft page. */
    asNewDraft: z.boolean().optional(),
  })
  .strict();

function unsupported(flagged: string[]): HttpError {
  const examples = flagged.slice(0, 3).map((f) => `“${f}”`).join(", ");
  return new HttpError(422, `The suggestion stated facts your store has not provided (${examples}), so it was not saved. ${explainClaims(flagged)} Or ask again.`, "unsupported_claims");
}

/** Stored sections as validated CMS sections (anything invalid is refused, never passed on). */
function storedSections(value: unknown): Section[] {
  return (Array.isArray(value) ? value : []).map((section) => {
    const parsed = sectionSchema.safeParse(section);
    if (!parsed.success) throw new HttpError(409, "This page has content the assistant cannot work with. Edit it in the website editor.", "page_not_supported");
    return parsed.data;
  });
}

/**
 * `POST /api/businesses/[id]/ai/page { instruction, pageId?, asNewDraft? }` —
 * asks Google Gemini to write a new page, or to change a draft page, and
 * stores the answer as a PENDING page proposal (the existing proposal
 * lifecycle). Nothing on the store changes: the owner previews it, approves
 * and applies it to DRAFT pages through the proposal routes, and publishes
 * separately. Published pages are never changed by a proposal; with
 * `asNewDraft` the improved version becomes a new draft page instead.
 *
 * Guards: lib/ai-builder/guard.ts, then lib/ai-builder/request.ts. Only
 * sanitized, approved data is sent. Text stating facts the store has not
 * provided is refused; unknown details become visible [[placeholders]], which
 * block publishing. Contact details come from the business settings only.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await guardAiRequest(request, id, "page");
    const body = bodySchema.parse(await readJson(request));
    const store = await loadAiStoreContext(id);

    const page = body.pageId ? store.pages.find((p) => String(p._id) === new mongoose.Types.ObjectId(body.pageId).toHexString()) : null;
    if (body.pageId && !page) throw new HttpError(404, "Page not found", "not_found");
    if (page?.isHome) {
      throw new HttpError(409, "The homepage is changed with the homepage assistant. Choose Homepage instead.", "page_is_home");
    }
    if (page?.status === "published" && !body.asNewDraft) {
      throw new HttpError(409, "This page is live, so the assistant does not change it directly. Ask for a new draft version, review it, then replace the old page when you are ready.", "page_published");
    }
    const existingSlugs = new Set(store.pages.map((p) => p.slug));
    const buildContext = { contact: store.contact, categories: store.prompt.categories, links: store.prompt.links };
    const facts = store.factsWith(body.instruction);
    const current = page ? { id: String(page._id), version: page.version, title: page.title, slug: page.slug, sections: storedSections(page.sections) } : null;
    // Proposals only reference the store's own media. Checked before the
    // provider call, so a page that cannot work never uses up a request.
    const approvedMedia = current ? await approvedMediaUrls(id, current.sections) : [];
    if (current && getSectionImageUrls(current.sections).some((url) => !approvedMedia.includes(url))) {
      throw new HttpError(409, "This page uses an image from outside your media library, so the assistant cannot change it. Replace that image in the website editor, then ask again.", "page_media_not_supported");
    }

    const { system, prompt } = pagePrompt({
      instruction: body.instruction,
      ...store.prompt,
      pageType: pageTypeOf(body.instruction),
      current: current ? { title: current.title, slug: current.slug, sections: current.sections } : null,
      knownContact: store.knownContact,
    });

    const result = await runAiRequest({
      businessId: id,
      task: "page",
      limit: store.limit,
      system,
      prompt,
      maxOutputTokens: 6144,
      accept: async (value) => {
        const proposalFor = (summary: string, actions: unknown) =>
          createProposal({ businessId: id, actorId: String(user._id), source: "ai", summary, actions, request: body.instruction, approvedMedia });
        try {
          if (!current) {
            const parsed = aiNewPageSchema.safeParse(value);
            if (!parsed.success) throw new HttpError(422, "The AI suggestion did not match what a page supports. Try rephrasing your request.", "invalid_suggestion");
            const flagged = findUnsupportedClaims(aiPageTexts(parsed.data), facts);
            if (flagged.length > 0) throw unsupported(flagged);
            const proposal = await proposalFor(parsed.data.summary, [buildNewPageAction(parsed.data, { ...buildContext, existingSlugs })]);
            return { proposal, message: null, notes: parsed.data.notes };
          }
          const parsed = aiPageEditSchema.safeParse(value);
          if (!parsed.success) throw new HttpError(422, "The AI suggestion did not match what this page supports. Try rephrasing your request.", "invalid_suggestion");
          if (parsed.data.changes.length === 0) return { proposal: null, message: parsed.data.summary, notes: parsed.data.notes };
          const flagged = findUnsupportedClaims(aiPageTexts(parsed.data), facts);
          if (flagged.length > 0) throw unsupported(flagged);
          const actions = page?.status === "published" ? [buildDraftCopyAction(current, parsed.data, { ...buildContext, existingSlugs })] : buildPageEditActions(current, parsed.data, buildContext);
          return { proposal: await proposalFor(parsed.data.summary, actions), message: null, notes: parsed.data.notes };
        } catch (error) {
          if (error instanceof PageBuildError) throw new HttpError(422, error.message, error.code);
          throw error;
        }
      },
    });
    return ok(result, { status: result.proposal ? 201 : 200 });
  });
}
