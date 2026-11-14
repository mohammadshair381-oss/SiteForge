import crypto from "node:crypto";
import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { assertAiConsent } from "@/lib/ai-builder/consent";
import { explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { planPageTexts } from "@/lib/ai-builder/page-builder";
import { redactText } from "@/lib/ai-builder/sanitize";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import { assertBusinessNotSuspended } from "@/lib/publish-gates";
import { dbConnect } from "@/lib/db";
import { AiPlanGeneration, type AiPlanGenerationDoc } from "@/models/AiPlanGeneration";
import type { WebsitePlan } from "./plan";

/**
 * Which pages of a plan came from AI (server-only). A plan travels through the browser and can be
 * edited there, so nothing the browser says about it is believed: when a plan is generated the server
 * keeps fingerprints of it, and when one is saved the server compares.
 *
 * - A page counts as AI-written if any of its text is unchanged from a recent generation, or it has
 *   the same address and title as a generated page.
 * - Text on such a page that differs from what was generated has been edited, and gets the same
 *   invented-claims check as generated text, with the owner's brief and store data as the facts.
 * - A page with none of this (added or wholly rewritten by the owner) is the owner's: it is not
 *   labelled as AI, and is treated like any other text an owner writes.
 *
 * It only reads. It never calls a provider, so saving a plan cannot use AI or the allowance.
 */
const REMEMBER_MS = 24 * 60 * 60 * 1000;
/** Generations compared per store, newest first. */
const MAX_COMPARED = 20;
const MAX_BRIEF_CHARS = 12000;
const MAX_TEXT_HASHES = 5000;

function fingerprint(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 32);
}

/** Called when a generated plan has been accepted, before it is returned. A failure refuses the plan: otherwise it would later pass as the owner's. */
export async function recordAiPlanGeneration(input: { businessId: string; actorId: string; plan: WebsitePlan; brief: string }): Promise<void> {
  await dbConnect();
  const business = new mongoose.Types.ObjectId(input.businessId);
  const now = new Date();
  await AiPlanGeneration.create({
    business,
    createdBy: new mongoose.Types.ObjectId(input.actorId),
    brief: redactText(input.brief, MAX_BRIEF_CHARS),
    pages: input.plan.pages.map((page) => ({ slug: page.slug, titleHash: fingerprint(page.title) })),
    textHashes: [...new Set(input.plan.pages.flatMap(planPageTexts).map(fingerprint))].slice(0, MAX_TEXT_HASHES),
    expiresAt: new Date(now.getTime() + REMEMBER_MS),
  });
  await AiPlanGeneration.deleteMany({ business, expiresAt: { $lte: now } }).catch(() => {
    console.error("[ai-planning] expired plan records not cleared");
  });
}

export interface PlanProvenance {
  /** Addresses of the pages that came from AI. Empty for a plan the owner wrote. */
  aiPageSlugs: string[];
  /** The owner's brief for those pages, shown with the proposal like any AI request. */
  request: string;
}

/**
 * Checks a complete plan just before it is saved: refuses edited text that states facts the store has
 * not provided, and stops AI-written pages being saved once AI is turned off for the store or the store
 * is suspended. Callers authorize the person and validate the plan first.
 */
export async function assessPlanProvenance(businessId: string, plan: WebsitePlan): Promise<PlanProvenance> {
  await dbConnect();
  const records = await AiPlanGeneration.find({ business: new mongoose.Types.ObjectId(businessId), expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .limit(MAX_COMPARED)
    .lean<AiPlanGenerationDoc[]>();
  if (records.length === 0) return { aiPageSlugs: [], request: "" };

  const generatedTexts = new Set(records.flatMap((record) => record.textHashes));
  const fromRecord = (page: WebsitePlan["pages"][number], record: AiPlanGenerationDoc) =>
    record.pages.some((known) => known.slug === page.slug && known.titleHash === fingerprint(page.title)) || planPageTexts(page).some((text) => record.textHashes.includes(fingerprint(text)));
  const aiPages = plan.pages.filter((page) => records.some((record) => fromRecord(page, record)));
  if (aiPages.length === 0) return { aiPageSlugs: [], request: "" };

  await assertAiConsent(businessId);
  await assertBusinessNotSuspended(businessId);

  const usedRecords = records.filter((record) => aiPages.some((page) => fromRecord(page, record)));
  const edited = aiPages.flatMap(planPageTexts).filter((text) => !generatedTexts.has(fingerprint(text)));
  if (edited.length > 0) {
    const store = await loadAiStoreContext(businessId);
    const flagged = findUnsupportedClaims(edited, store.factsWith(usedRecords.map((record) => record.brief).join("\n")));
    if (flagged.length > 0) {
      const examples = flagged.slice(0, 3).map((phrase) => `“${phrase}”`).join(", ");
      throw new HttpError(
        422,
        `This plan states facts your store has not provided (${examples}), so it was not saved. ${explainClaims(flagged)} Or remove them here and add them in the website editor once you have checked them.`,
        "unsupported_claims",
      );
    }
  }
  return { aiPageSlugs: aiPages.map((page) => page.slug), request: (usedRecords[0]?.brief ?? "").slice(0, 500) };
}
