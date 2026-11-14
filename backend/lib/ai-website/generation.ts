import mongoose from "mongoose";
import { ZodError } from "zod";
import { HttpError } from "@/lib/api";
import { claimNeedsRealData, explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { PageBuildError } from "@/lib/ai-builder/page-builder";
import { runAiRequest } from "@/lib/ai-builder/request";
import { redactText } from "@/lib/ai-builder/sanitize";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import { StorefrontChangeError } from "@/lib/ai-builder/storefront-changes";
import { themeCatalog } from "@/lib/ai-builder/theme-advisor";
import { getThemeAccess } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { localMediaServable } from "@/lib/media";
import { mediaUrlFor } from "@/lib/media-storage";
import { LOCAL_MEDIA_PATH } from "@/lib/sections";
import { canSelectTheme } from "@/lib/theme-tiers";
import { getAiUsageSummary } from "@/lib/ai-builder/usage";
import { getPageAllowance } from "@/lib/usage-limits";
import { Media } from "@/models/Media";
import { WebsiteProposal, type WebsiteProposalDoc } from "@/models/WebsiteProposal";
import type { AiConversationDoc } from "@/models/AiConversation";
import { aiDiscoverySchema, aiWebsitePageSchema, aiWebsitePlanSchema, aiWebsiteRevisionSchema, answerVisibleTexts, findUnsupportedChoices, type AiDiscovery, type AiWebsitePageContent, type AiWebsitePlan, type UnsupportedChoices, type WebsiteBrief } from "./answers";
import { CLAIMS_CONFIRMED_PREFIX, MAX_WEBSITE_PAGES, websiteBlueprintSchema, type WebsiteProposalData } from "./blueprint";
import { applyWebsiteRevision, assertPlanBuildable, buildWebsiteBlueprint, changesBetween, hasChanges, plannedPagesFrom, stateAfterChanges, unbuildablePages, type PlannedPage, type WebsiteBuildContext } from "./build";
import { appendMessage, claimConversation, proposalStatusOf, releaseConversation, updateConversation } from "./conversation";
import { discoveryPrompt, websitePagePrompt, websitePlanPrompt, websiteRevisionPrompt, type ConversationTurn, type PromptMedia, type StoreFacts } from "./prompts";
import { createWebsiteProposal, supersedeProposal, websiteStaleItems } from "./proposal";
import { loadWebsiteState, type LoadedWebsite } from "./state";

/**
 * The website workflow's server side: one conversation turn, one generation step, one revision. Every
 * provider call goes through `runAiRequest`, so each passes consent, the data checks, the allowance and
 * the provider layer, and no provider's format reaches this file. An allowance unit is spent only on an
 * answer that was accepted, so a failed or interrupted step costs nothing and can simply run again.
 *
 * Generating is one short request per step, not one long one: the plan and homepage, then each page.
 * The client keeps asking for the next step, and everything done so far is stored in the conversation,
 * so closing the page loses nothing.
 */
const ADVICE = "Your progress is saved, so you can try again.";
/** Longer than one provider call and its retries can take. */
const LEASE_MS = 150 * 1000;

/**
 * Refuses an answer that states facts nobody has provided, and remembers the wording: the owner can confirm
 * what is theirs to confirm, and the next attempt is told to avoid the rest. Nothing refused is ever stored as content.
 */
async function refuseInvented(doc: AiConversationDoc, flagged: string[]): Promise<never> {
  await updateConversation(doc, { flaggedClaims: flagged.slice(0, 10) });
  const examples = flagged.slice(0, 3).map((phrase) => `“${phrase}”`).join(", ");
  throw new HttpError(422, `The assistant wrote things your store has not told it (${examples}). ${explainClaims(flagged)} Nothing was saved, and a refused answer costs nothing.`, "unsupported_claims");
}

const invalidAnswer = () => new HttpError(422, "The assistant's answer did not match what a website supports. Please try again.", "invalid_suggestion");

/** Fixed sentences, sent to the provider on the next attempt. Never a value from an answer or anyone's words. */
const CORRECTION_TEMPLATE = "Your last answer used a section template that does not exist. Use only a KEY from the list of templates, or another type of section.";
const CORRECTION_CATEGORY = "Your last answer used a product category this store does not have. Use only a category from STORE_FACTS, or leave the category out.";
const CORRECTION_OUTDATED = "An earlier answer used a section template or product category this store does not have. Use only the templates and categories you are given.";

/**
 * Refuses an answer that chooses something this store does not have, before anything is kept. It is thrown from
 * inside `accept`, so it is not charged. Finished steps stay, and only this step runs again, knowing what went wrong.
 */
async function refuseUnsupported(doc: AiConversationDoc, found: UnsupportedChoices): Promise<never> {
  await updateConversation(doc, { answerCorrections: [...(found.templates.length > 0 ? [CORRECTION_TEMPLATE] : []), ...(found.categories.length > 0 ? [CORRECTION_CATEGORY] : [])] });
  const names = [...found.templates.map((name) => `the section "${name}"`), ...found.categories.map((name) => `the category "${redactText(name, 80)}"`)].slice(0, 3).join(", ");
  throw new HttpError(422, `The assistant chose ${names}, which your store does not have. Nothing from this step was saved and it costs nothing, and the steps already finished are kept. Carry on to try just this step again, or tell the assistant what to use instead.`, "unsupported_choice");
}

const anyUnsupported = (found: UnsupportedChoices) => found.templates.length > 0 || found.categories.length > 0;

const turnsOf = (doc: AiConversationDoc): ConversationTurn[] => doc.messages.map((message) => ({ role: message.role, text: message.text }));
/** Only what the owner wrote can support a fact. What the assistant said cannot. */
const ownerWords = (doc: AiConversationDoc) => doc.messages.filter((message) => message.role === "owner").map((message) => message.text).join("\n");

async function storeFacts(businessId: string) {
  const store = await loadAiStoreContext(businessId);
  const facts: StoreFacts = { ...store.prompt, knownContact: store.knownContact };
  return { store, facts };
}

export interface WebsiteRefs {
  media: Array<PromptMedia & { url: string; alt: string }>;
  products: Array<{ ref: string; id: string; name: string; category: string }>;
}

/** An address the renderer and previews can really show, or null: then the owner is asked for a picture. */
function usableMediaUrl(storageKey: string, businessId: string): string | null {
  try {
    const url = mediaUrlFor(storageKey, businessId);
    return /^https:\/\//i.test(url) || (LOCAL_MEDIA_PATH.test(url) && localMediaServable()) ? url : null;
  } catch {
    return null;
  }
}

/** A readable description from a file name, when the owner has not written one. */
const fromFileName = (name: string | undefined) => (name ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").trim();

const shapeOf = (width: number | undefined, height: number | undefined): PromptMedia["shape"] => {
  if (!width || !height) return undefined;
  return width > height * 1.2 ? "wide" : height > width * 1.2 ? "tall" : "square";
};

/**
 * This store's own images and active products, by short references. A provider sees a description or a
 * title, never an address or an id. It can only choose from what is listed here, and the server turns a
 * reference back into the real thing. Everything is checked again when the proposal is applied.
 */
async function loadRefs(businessId: string, store: Awaited<ReturnType<typeof loadAiStoreContext>>): Promise<WebsiteRefs> {
  await dbConnect();
  const docs = await Media.find({ business: businessId, deletedAt: null, uploadState: { $nin: ["pending", "failed"] } })
    .select("storageKey altText originalName width height")
    .sort({ createdAt: -1 })
    .limit(40)
    .lean<Array<{ storageKey: string; altText?: string; originalName?: string; width?: number; height?: number }>>();
  const media: WebsiteRefs["media"] = [];
  for (const doc of docs) {
    const url = usableMediaUrl(doc.storageKey, businessId);
    if (!url) continue;
    media.push({ ref: `m${media.length + 1}`, url, alt: doc.altText || fromFileName(doc.originalName) || "A picture", shape: shapeOf(doc.width, doc.height) });
  }
  // `store.products` holds active products of this store only (lib/storefront-preview-data.ts).
  const products = store.products.slice(0, 40).map((product, index) => ({ ref: `p${index + 1}`, id: String(product._id), name: product.name, category: product.category ?? "" }));
  return { media, products };
}

function buildContext(store: Awaited<ReturnType<typeof loadAiStoreContext>>, refs: WebsiteRefs, themeAccess: WebsiteBuildContext["themeAccess"]): WebsiteBuildContext {
  return {
    contact: store.contact,
    categories: store.prompt.categories,
    links: store.prompt.links,
    // References are kept for a whole website, so one this deployment cannot serve is left out here too.
    media: new Map(refs.media.filter((item) => !LOCAL_MEDIA_PATH.test(item.url) || localMediaServable()).map((item) => [item.ref, { url: item.url, alt: item.alt }])),
    products: new Map(refs.products.map((product) => [product.ref, product.id])),
    themeAccess,
    imageRequests: [],
  };
}

/** Failures of turning an answer into website data, as ordinary refusals. */
function asRefusal(error: unknown): never {
  if (error instanceof PageBuildError) throw new HttpError(422, error.message, error.code);
  if (error instanceof StorefrontChangeError) throw new HttpError(422, error.message, error.code);
  if (error instanceof ZodError) throw invalidAnswer();
  throw error;
}

/** Stored as the owner's notes, so scrubbed like their messages. Empty values never replace what is there. */
const cleanBrief = (brief: WebsiteBrief) =>
  Object.fromEntries(
    Object.entries(brief).flatMap(([key, value]): Array<[string, string | string[]]> => {
      if (Array.isArray(value)) return value.length > 0 ? [[key, value.map((item) => redactText(item, 80))]] : [];
      return value ? [[key, redactText(value, 800)]] : [];
    }),
  );

/** One message in the discovery conversation. */
export async function discoveryTurn(input: { businessId: string; doc: AiConversationDoc; message: string }): Promise<{ doc: AiConversationDoc; answer: AiDiscovery }> {
  const { businessId } = input;
  await claimConversation(input.doc, LEASE_MS);
  try {
    let doc = await appendMessage(input.doc, "owner", input.message);
    const { store, facts } = await storeFacts(businessId);
    const { system, prompt } = discoveryPrompt({ facts, brief: (doc.brief ?? {}) as WebsiteBrief, turns: turnsOf(doc) });
    const answer = await runAiRequest({
      businessId,
      task: "discovery",
      limit: store.limit,
      system,
      prompt,
      maxOutputTokens: 2048,
      subject: "The website assistant",
      advice: "Your message is saved, so you can try again.",
      chargeOnlyAccepted: true,
      accept: (value) => {
        const parsed = aiDiscoverySchema.safeParse(value);
        if (!parsed.success) throw invalidAnswer();
        return parsed.data;
      },
    });
    const brief = { ...(doc.brief ?? {}), ...cleanBrief(answer.brief) };
    // The owner has moved the conversation on, so an earlier refusal is no longer the question.
    await updateConversation(doc, { brief, readyToGenerate: answer.readyToGenerate, questions: answer.questions, flaggedClaims: [] });
    doc = await appendMessage({ ...doc, brief, readyToGenerate: answer.readyToGenerate, questions: answer.questions }, "assistant", answer.reply);
    return { doc, answer };
  } finally {
    await releaseConversation(input.doc);
  }
}

export interface GenerationStepResult {
  /** Finished: the proposal is ready to review. */
  proposal: WebsiteProposalDoc | null;
}

/** What is still to do, in allowance units: one for the plan and homepage, one for each page. */
export function generationUnitsLeft(doc: Pick<AiConversationDoc, "generation" | "brief">): number {
  const generation = doc.generation;
  if (!generation?.plan) {
    const wanted = Array.isArray((doc.brief as WebsiteBrief | undefined)?.pages) ? ((doc.brief as WebsiteBrief).pages as string[]).length : 4;
    return 1 + Math.min(wanted, MAX_WEBSITE_PAGES);
  }
  const contents = generation.contents ?? {};
  return ((generation.pages ?? []) as PlannedPage[]).filter((page) => !contents[page.key]).length;
}

/**
 * Does the next step of generating this conversation's website. Safe to call again at any time: a step
 * already done is not repeated, and the finished proposal is only ever saved once.
 */
export async function generationStep(input: { businessId: string; actorId: string; doc: AiConversationDoc }): Promise<GenerationStepResult> {
  const { businessId, actorId } = input;
  await claimConversation(input.doc, LEASE_MS);
  try {
    let doc = input.doc;
    if (!doc.messages.some((message) => message.role === "owner")) {
      throw new HttpError(409, "Tell the assistant about your business first, so it has something to work from.", "conversation_empty");
    }
    const proposalStatus = await proposalStatusOf(doc);
    if (proposalStatus === "pending" || proposalStatus === "approved" || proposalStatus === "applied") {
      throw new HttpError(409, "This conversation already has a website proposal. Ask for a change, or start a new conversation.", "already_generated");
    }
    // A refused or expired proposal: generating starts again, with what the owner has said since.
    if (doc.proposalId) {
      await updateConversation(doc, { generation: null, proposalId: null });
      doc = { ...doc, generation: null, proposalId: null };
    }

    const { store, facts } = await storeFacts(businessId);
    // The same references for every step of one website, even if media is added meanwhile.
    const refs = (doc.generation?.refs as WebsiteRefs | undefined) ?? (await loadRefs(businessId, store));
    const themeAccess = await getThemeAccess(businessId);
    const loaded = await loadWebsiteState(businessId);
    const context = buildContext(store, refs, themeAccess);
    const brief = (doc.brief ?? {}) as WebsiteBrief;
    const refused = doc.flaggedClaims ?? [];
    const corrections = doc.answerCorrections ?? [];
    const factsText = store.factsWith(ownerWords(doc));

    if (!doc.generation?.plan) {
      const usage = await getAiUsageSummary(businessId, store.limit);
      const allowance = await getPageAllowance(businessId);
      const maxPages = Math.min(MAX_WEBSITE_PAGES, Math.max(0, usage.remaining - 1));
      const maxNewPages = Math.min(maxPages, allowance.remaining ?? MAX_WEBSITE_PAGES);
      const { system, prompt } = websitePlanPrompt({
        facts,
        brief,
        turns: turnsOf(doc),
        themes: themeCatalog().map((theme) => ({ id: theme.id, name: theme.name, identity: theme.identity, bestFor: theme.bestFor, available: canSelectTheme(themeAccess, theme.id) })),
        media: refs.media,
        products: refs.products,
        homepage: loaded.state.config,
        limits: { maxPages },
        refused,
        corrections,
      });
      const { plan, planned } = await runAiRequest({
        businessId,
        task: "website",
        limit: store.limit,
        system,
        prompt,
        maxOutputTokens: 8192,
        subject: "Website generation",
        advice: ADVICE,
        chargeOnlyAccepted: true,
        accept: async (value) => {
          const parsed = aiWebsitePlanSchema.safeParse(value);
          if (!parsed.success) throw invalidAnswer();
          const flagged = findUnsupportedClaims(answerVisibleTexts({ home: parsed.data.home, footer: parsed.data.footer, pages: parsed.data.pages.map((page) => ({ title: page.title })) }), factsText);
          if (flagged.length > 0) await refuseInvented(doc, flagged);
          const unsupported = findUnsupportedChoices(parsed.data, store.prompt.categories);
          if (anyUnsupported(unsupported)) await refuseUnsupported(doc, unsupported);
          // Everything that can be decided without a provider is decided here, so a plan that could
          // never become a website is not charged for and not kept.
          try {
            const pagesPlanned = plannedPagesFrom(parsed.data, loaded.state, { maxNewPages, maxPages, lockedPageIds: loaded.lockedPageIds });
            assertPlanBuildable({ current: loaded.state, plan: parsed.data, plannedPages: pagesPlanned.pages }, context);
            return { plan: parsed.data, planned: pagesPlanned };
          } catch (error) {
            return asRefusal(error);
          }
        },
      });
      // A plan made again keeps the pages already written for the same addresses.
      const earlierPages = (doc.generation?.pages ?? []) as PlannedPage[];
      const earlierContents = (doc.generation?.contents ?? {}) as Record<string, AiWebsitePageContent>;
      const keptContents = Object.fromEntries(
        planned.pages.flatMap((page): Array<[string, AiWebsitePageContent]> => {
          const earlier = earlierPages.find((candidate) => candidate.slug === page.slug);
          const content = earlier ? earlierContents[earlier.key] : undefined;
          return content ? [[page.key, content]] : [];
        }),
      );
      await updateConversation(doc, { flaggedClaims: [], answerCorrections: [], generation: { plan, pages: planned.pages, contents: keptContents, notes: planned.notes, refs, startedAt: new Date() } });
      return { proposal: null };
    }

    const plan = doc.generation.plan as AiWebsitePlan;
    const pages = (doc.generation.pages ?? []) as PlannedPage[];
    const contents = (doc.generation.contents ?? {}) as Record<string, AiWebsitePageContent>;
    const next = pages.find((page) => !contents[page.key]);

    if (next) {
      const current = next.existingId ? loaded.state.pages.find((page) => page.id === next.existingId) : null;
      const { system, prompt } = websitePagePrompt({
        facts,
        brief,
        turns: turnsOf(doc),
        website: { summary: plan.summary, personality: plan.identity.personality ?? "", language: plan.identity.language ?? "", pages: pages.map((page) => ({ title: page.title, slug: page.slug, purpose: page.purpose })) },
        page: { title: next.title, slug: next.slug, purpose: next.purpose, currentSections: current ? current.sections : null },
        media: refs.media,
        links: [...store.prompt.links, ...pages.map((page) => `/${page.slug}`)],
        refused,
        corrections,
      });
      const content = await runAiRequest({
        businessId,
        task: "website",
        limit: store.limit,
        system,
        prompt,
        maxOutputTokens: 6144,
        subject: "Website generation",
        advice: ADVICE,
        chargeOnlyAccepted: true,
        accept: async (value) => {
          const parsed = aiWebsitePageSchema.safeParse(value);
          if (!parsed.success) throw invalidAnswer();
          const flagged = findUnsupportedClaims(answerVisibleTexts(parsed.data), factsText);
          if (flagged.length > 0) await refuseInvented(doc, flagged);
          const unsupported = findUnsupportedChoices(parsed.data, store.prompt.categories);
          if (anyUnsupported(unsupported)) await refuseUnsupported(doc, unsupported);
          if (unbuildablePages(pages, { [next.key]: parsed.data }, context).length > 0) throw invalidAnswer();
          return parsed.data;
        },
      });
      await updateConversation(doc, { flaggedClaims: [], answerCorrections: [], [`generation.contents.${next.key}`]: content, ...(content.notes.length > 0 ? { "generation.notes": [...(doc.generation.notes ?? []), ...content.notes].slice(0, 10) } : {}) });
      return { proposal: null };
    }

    // ---- Everything is written: one complete website, as one proposal. No provider is involved.
    // Each step was checked when it was kept, but a category can be removed while a website is being written.
    // Then only that page is written again: the rest stay, and this refusal costs nothing.
    const outdated = unbuildablePages(pages, contents, context);
    if (outdated.length > 0) {
      await updateConversation(doc, { answerCorrections: [CORRECTION_OUTDATED], ...Object.fromEntries(outdated.map((page) => [`generation.contents.${page.key}`, null])) });
      const titles = outdated.slice(0, 3).map((page) => `"${page.title}"`).join(", ");
      throw new HttpError(422, `${titles} used something your store no longer has, such as a category that was removed. The other pages are kept. Carry on generating to write ${outdated.length === 1 ? "just that page" : "just those pages"} again.`, "generation_page_outdated");
    }
    try {
      const built = buildWebsiteBlueprint({ businessName: loaded.business.name, category: loaded.business.category, current: loaded.state, plan, contents, plannedPages: pages }, context);
      websiteBlueprintSchema.parse({ ...built.blueprint, pages: built.blueprint.pages.filter((page) => page.aiWritten) });
      const changes = changesBetween(loaded.state, built.blueprint);
      // Chosen before saving, so a save that is cut off and repeated cannot make a second proposal.
      const proposalId = doc.generation.proposalId ?? String(new mongoose.Types.ObjectId());
      if (!doc.generation.proposalId) await updateConversation(doc, { "generation.proposalId": proposalId });
      // An owner's conversation is private to them, so a proposal holds nothing from it: not their
      // words, and not the assistant's summary of them. It describes itself from what it changes.
      const proposal = await createWebsiteProposal({
        businessId,
        actorId,
        loaded,
        changes,
        notes: [...built.notes, ...(doc.generation.notes ?? [])],
        identity: built.blueprint.identity,
        conversationId: String(doc._id),
        proposalId,
      });
      await updateConversation(doc, { proposalId: proposal._id });
      await appendMessage(doc, "assistant", `${plan.summary} Your website is ready to review. Nothing changes until you approve it.`);
      return { proposal };
    } catch (error) {
      // What is left is the plan itself, from before plans were checked, or a change to the store since.
      // Only the plan is made again, and the pages already written for the same addresses stay.
      if (error instanceof PageBuildError || error instanceof ZodError) {
        await updateConversation(doc, { "generation.plan": null, answerCorrections: [CORRECTION_OUTDATED] });
        throw new HttpError(422, "The plan for this website no longer fits your store. The pages already written are kept. Carry on generating to plan it again.", "generation_plan_outdated");
      }
      return asRefusal(error);
    }
  } finally {
    await releaseConversation(input.doc);
  }
}

/** Page addresses named in a request, so only those pages' text is sent. */
function pagesNamedIn(request: string, loaded: LoadedWebsite): Set<string> {
  const text = request.toLowerCase();
  return new Set(loaded.state.pages.filter((page) => !page.isHome && (text.includes(page.slug.toLowerCase().replace(/-/g, " ")) || text.includes(page.slug.toLowerCase()) || text.includes(page.title.toLowerCase()))).map((page) => page.slug));
}

/**
 * A change to the website in the owner's words, as a proposal holding only that change. While a proposal
 * is waiting, the change builds on it and replaces it, so the owner reviews one proposal with everything
 * in it. After one was applied or refused, the change builds on the current drafts. What was refused is
 * never treated as accepted.
 */
export async function revisionTurn(input: { businessId: string; actorId: string; doc: AiConversationDoc; message: string }): Promise<{ doc: AiConversationDoc; proposal: WebsiteProposalDoc | null; message: string; notes: string[] }> {
  const { businessId, actorId } = input;
  await claimConversation(input.doc, LEASE_MS);
  try {
    let doc = await appendMessage(input.doc, "owner", input.message);
    const { store, facts } = await storeFacts(businessId);
    const refs = await loadRefs(businessId, store);
    const themeAccess = await getThemeAccess(businessId);
    const loaded = await loadWebsiteState(businessId);
    const context = buildContext(store, refs, themeAccess);

    const proposalStatus = await proposalStatusOf(doc);
    let waiting: WebsiteProposalDoc | null = null;
    if (doc.proposalId && proposalStatus === "pending") {
      const found = await WebsiteProposal.findOne({ _id: doc.proposalId, business: businessId }).lean<WebsiteProposalDoc>();
      if (found && (await websiteStaleItems(found)).length === 0) waiting = found;
    }
    const waitingData = waiting?.website as WebsiteProposalData | undefined;
    const base = waitingData ? stateAfterChanges(loaded.state, waitingData.changes) : loaded.state;
    const lastSuggestion = proposalStatus === "rejected" ? "The last suggestion was refused: none of it was accepted." : proposalStatus === "failed" ? "The last suggestion ran out or could not be applied: none of it was accepted." : waiting ? "A suggestion is waiting for review, and the current website below includes it." : null;

    const { system, prompt } = websiteRevisionPrompt({
      facts,
      brief: (doc.brief ?? {}) as WebsiteBrief,
      turns: turnsOf(doc).slice(0, -1),
      request: input.message,
      homepage: base.config,
      design: { ...base.design },
      headerFooter: { header: base.config.header, footer: { layout: base.config.footer.layout, about: base.config.footer.about, copyright: base.config.footer.copyright, columns: base.config.footer.columns } },
      menus: base.navigation,
      pages: base.pages,
      detailedSlugs: pagesNamedIn(input.message, loaded),
      themes: themeCatalog().map((theme) => ({ id: theme.id, name: theme.name, identity: theme.identity, available: canSelectTheme(themeAccess, theme.id) })),
      media: refs.media,
      products: refs.products,
      lastProposal: lastSuggestion,
      refused: doc.flaggedClaims ?? [],
    });
    const factsText = store.factsWith(ownerWords(doc));
    const result = await runAiRequest({
      businessId,
      task: "revision",
      limit: store.limit,
      system,
      prompt,
      maxOutputTokens: 6144,
      subject: "The website assistant",
      advice: "Your message is saved, so you can try again.",
      chargeOnlyAccepted: true,
      accept: async (value) => {
        const parsed = aiWebsiteRevisionSchema.safeParse(value);
        if (!parsed.success) throw invalidAnswer();
        const flagged = findUnsupportedClaims(answerVisibleTexts(parsed.data.changes), factsText);
        if (flagged.length > 0) await refuseInvented(doc, flagged);
        try {
          const applied = applyWebsiteRevision(base, parsed.data, context);
          const changes = changesBetween(loaded.state, applied.state);
          if (!hasChanges(changes)) return { proposal: null, summary: parsed.data.summary, notes: applied.notes };
          if (changes.updatePages.some((page) => loaded.lockedPageIds.includes(page.id ?? ""))) {
            throw new HttpError(409, "That page has content the assistant cannot work with. Edit it in the website editor.", "page_not_supported");
          }
          const proposal = await createWebsiteProposal({
            businessId,
            actorId,
            loaded,
            changes,
            // The owner's message stays in their private conversation. See createWebsiteProposal.
            notes: applied.notes,
            ...(waitingData?.identity ? { identity: waitingData.identity } : {}),
            conversationId: String(doc._id),
          });
          if (waiting) await supersedeProposal(businessId, waiting._id, actorId);
          return { proposal, summary: parsed.data.summary, notes: applied.notes };
        } catch (error) {
          return asRefusal(error);
        }
      },
    });
    await updateConversation(doc, { flaggedClaims: [], ...(result.proposal ? { proposalId: result.proposal._id } : {}) });
    doc = await appendMessage({ ...doc, ...(result.proposal ? { proposalId: result.proposal._id } : {}) }, "assistant", result.summary);
    return { doc, proposal: result.proposal, message: result.summary, notes: result.notes };
  } finally {
    await releaseConversation(input.doc);
  }
}

/**
 * The owner says refused wording is true. Their own words are what the claims check accepts as fact. Prices,
 * ratings, reviews and best sellers are not theirs to vouch for like this: those stay refused.
 */
export async function confirmFlaggedClaims(doc: AiConversationDoc): Promise<AiConversationDoc> {
  const flagged = doc.flaggedClaims ?? [];
  const confirmed = flagged.filter((phrase) => !claimNeedsRealData(phrase));
  if (confirmed.length === 0) return doc;
  const remaining = flagged.filter((phrase) => claimNeedsRealData(phrase));
  const updated = await appendMessage(doc, "owner", `${CLAIMS_CONFIRMED_PREFIX} ${confirmed.join("; ")}.`);
  await updateConversation(updated, { flaggedClaims: remaining });
  return { ...updated, flaggedClaims: remaining };
}

/** A brief the owner wrote elsewhere (the website planner), taken into the conversation. No provider is involved. */
export async function addOwnerBrief(doc: AiConversationDoc, brief: WebsiteBrief, message: string): Promise<AiConversationDoc> {
  const merged = { ...(doc.brief ?? {}), ...cleanBrief(brief) };
  const updated = await appendMessage({ ...doc, brief: merged }, "owner", message);
  await updateConversation(updated, { brief: merged, readyToGenerate: true });
  return { ...updated, brief: merged, readyToGenerate: true };
}
