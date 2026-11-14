import { liveDesign } from "@/lib/design-service";
import { readDesignDraft, type DesignDraft } from "@/lib/design-settings";
import crypto from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { z } from "zod";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { readStorefrontConfig, type StorefrontConfig } from "@/lib/storefront-config";
import { saveStorefrontDraft } from "@/lib/storefront-settings";
import { assertProposalActor } from "@/lib/ai-planning/apply-approved-proposal";
import { Business } from "@/models/Business";
import { PROPOSAL_TTL_MS, WebsiteProposal, type WebsiteProposalDoc } from "@/models/WebsiteProposal";
import { explainClaims, findUnsupportedClaims } from "./claims";
import { redactText } from "./sanitize";
import {
  FONTS,
  StorefrontChangeError,
  applyStorefrontChanges,
  changeSetTexts,
  storefrontChangeSetSchema,
  type BrandState,
  type StorefrontDiffEntry,
} from "./storefront-changes";

/**
 * Store homepage proposals (WebsiteProposal with target "storefront").
 *
 * Same lifecycle and guarantees as page proposals
 * (lib/ai-planning/proposal-service.ts): created pending, explicitly approved,
 * then explicitly applied by an owner or manager, in ONE transaction with the
 * status claim. Applying writes the DRAFT homepage through the editor's own
 * write path (`saveStorefrontDraft`, same validation), never the published
 * homepage; the brand (colours, font) is a store-wide business setting and
 * changes with it, which the review screen states before applying.
 *
 * A proposal records a hash of the draft homepage and brand it was prepared
 * against: any later edit makes it stale, and a stale proposal is refused at
 * approval and again at apply.
 */

const brandSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/),
  font: z.enum(FONTS),
});

/** The brand a homepage proposal builds on: the design draft when there is one, else the live settings. */
export function readBrand(themeSettings: unknown): BrandState {
  const settings = (themeSettings && typeof themeSettings === "object" ? themeSettings : {}) as Record<string, unknown>;
  const draft = readDesignDraft(settings.designDraft);
  const ts = draft
    ? {
        ...settings,
        ...(draft.useThemeColors ? {} : { primaryColor: draft.primaryColor, accentColor: draft.accentColor }),
        font: draft.displayFont === draft.bodyFont && (draft.displayFont === "serif" || draft.displayFont === "mono") ? draft.displayFont : "sans",
      }
    : settings;
  const hex = (value: unknown, fallback: string) => (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback);
  const font = (FONTS as readonly string[]).includes(ts.font as string) ? (ts.font as BrandState["font"]) : "sans";
  return { primaryColor: hex(ts.primaryColor, "#4f46e5"), accentColor: hex(ts.accentColor, "#0ea5e9"), font };
}

export function storefrontStateHash(config: StorefrontConfig, brand: BrandState): string {
  return crypto.createHash("sha256").update(JSON.stringify({ config, brand })).digest("hex");
}

/** The draft homepage and brand right now (read inside `session` when given). */
export async function currentStorefrontState(businessId: string, session?: ClientSession) {
  await dbConnect();
  const business = await Business.findById(businessId)
    .select("themeSettings category")
    .session(session ?? null)
    .lean<{ themeSettings?: unknown; category?: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  const settings = (business.themeSettings ?? {}) as Record<string, unknown>;
  const config = readStorefrontConfig(settings.storefront, business.category);
  const brand = readBrand(settings);
  return { config, brand, hash: storefrontStateHash(config, brand) };
}

export type StorefrontState = Awaited<ReturnType<typeof currentStorefrontState>>;

export interface StorefrontProposalPreview {
  config: StorefrontConfig;
  brand: BrandState;
}

/**
 * Validates a change set against the current draft and stores it as a
 * PENDING proposal (nothing on the store changes). Generated text that states
 * facts the store has not provided is refused and nothing is saved.
 */
export async function createStorefrontProposal(input: {
  businessId: string;
  actorId: string;
  source: "ai" | "manual";
  request: string;
  changeSet: unknown;
  /** The owner's own data the text may restate (business, products, request). */
  facts: string;
  base?: StorefrontState;
}): Promise<WebsiteProposalDoc> {
  const changeSet = storefrontChangeSetSchema.parse(input.changeSet);
  if (changeSet.changes.length === 0) {
    throw new HttpError(422, "These suggestions would not change anything.", "no_changes");
  }
  const flagged = findUnsupportedClaims(changeSetTexts(changeSet.changes), input.facts);
  if (flagged.length > 0) {
    const examples = flagged.slice(0, 3).map((f) => `“${f}”`).join(", ");
    throw new HttpError(
      422,
      `The suggestion stated facts your store has not provided (${examples}), so it was not saved. ${explainClaims(flagged)} Or ask again.`,
      "unsupported_claims",
    );
  }
  const base = input.base ?? (await currentStorefrontState(input.businessId));
  let result: { config: StorefrontConfig; brand: BrandState; diff: StorefrontDiffEntry[] };
  try {
    result = applyStorefrontChanges(base.config, base.brand, changeSet.changes);
  } catch (error) {
    if (error instanceof StorefrontChangeError) throw new HttpError(422, error.message, error.code);
    throw error;
  }

  const now = new Date();
  const actor = new mongoose.Types.ObjectId(input.actorId);
  const doc = await WebsiteProposal.create({
    business: new mongoose.Types.ObjectId(input.businessId),
    createdBy: actor,
    source: input.source,
    target: "storefront",
    summary: redactText(changeSet.summary, 280),
    request: redactText(input.request, 500),
    actions: [],
    pageVersions: [],
    diff: { changes: result.diff, live: result.diff.some((d) => d.live) },
    preview: { config: result.config, brand: result.brand } satisfies StorefrontProposalPreview,
    storefront: { baseHash: base.hash, changes: changeSet.changes, notes: changeSet.notes },
    status: "pending",
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    history: [{ at: now, action: "created", actor, note: input.source }],
  });
  return doc.toObject() as WebsiteProposalDoc;
}

/** Whether the draft homepage or brand changed since the proposal was prepared. */
export async function storefrontProposalIsStale(doc: Pick<WebsiteProposalDoc, "business" | "storefront">): Promise<boolean> {
  const state = await currentStorefrontState(String(doc.business));
  return state.hash !== doc.storefront?.baseHash;
}

/**
 * Applies an APPROVED storefront proposal that the caller has just claimed
 * inside `session` (lib/ai-planning/proposal-service.ts applyProposal). Never
 * publishes: the draft homepage is saved through `saveStorefrontDraft`, and
 * the brand goes to the design draft.
 */
export async function applyApprovedStorefrontProposal(
  businessId: string,
  doc: Pick<WebsiteProposalDoc, "storefront" | "preview" | "status">,
  options: { session: ClientSession; actorUserId: string },
): Promise<{ brandChanged: boolean }> {
  if (doc.status !== "applied" && doc.status !== "approved") {
    throw new HttpError(409, "Only approved proposals can be applied.", "proposal_not_approved");
  }
  await assertProposalActor(businessId, options.actorUserId);
  const state = await currentStorefrontState(businessId, options.session);
  if (!doc.storefront || state.hash !== doc.storefront.baseHash) {
    throw new HttpError(409, "Your homepage changed after this suggestion was prepared. Ask again for a fresh suggestion.", "version_conflict");
  }
  const preview = doc.preview as StorefrontProposalPreview;
  await saveStorefrontDraft(businessId, preview.config, { session: options.session });
  const brand = brandSchema.parse(preview.brand);
  const brandChanged = JSON.stringify(brand) !== JSON.stringify(state.brand);
  if (brandChanged) {
    // Colours and fonts are store-wide, so they wait in the design draft like any
    // other design change. A proposal never changes what visitors see.
    const business = await Business.findById(businessId)
      .select("themeId themeSettings")
      .session(options.session)
      .lean<{ themeId: string; themeSettings?: Record<string, unknown> }>();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    const current = readDesignDraft(business.themeSettings?.designDraft) ?? liveDesign(business);
    const colorsChanged = brand.primaryColor !== state.brand.primaryColor || brand.accentColor !== state.brand.accentColor;
    const font = brand.font === "sans" ? "theme" : brand.font;
    const draft: DesignDraft = {
      ...current,
      ...(colorsChanged ? { useThemeColors: false, primaryColor: brand.primaryColor, accentColor: brand.accentColor } : {}),
      ...(brand.font !== state.brand.font ? { displayFont: font, bodyFont: font } : {}),
    };
    await Business.updateOne({ _id: new mongoose.Types.ObjectId(businessId) }, { $set: { "themeSettings.designDraft": draft }, $inc: { designDraftVersion: 1 } }, { session: options.session });
  }
  return { brandChanged };
}
