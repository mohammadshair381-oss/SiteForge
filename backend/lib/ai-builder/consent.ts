import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import { Business } from "@/models/Business";
import { AiConsentEvent } from "@/models/AiConsentEvent";
import { getEntitlements } from "@/lib/billing";
import { aiPlatformStatus, type AiPlatformStatus } from "./provider";
import type { AiTask } from "./usage";

/**
 * Business-owner consent to AI suggestions.
 *
 * Turning the provider on for the platform never means every business has
 * agreed: each business's OWNER must consent to the current disclosure
 * version before any AI request for that business, and can revoke at any
 * time. Revocation takes effect on the very next request (the consent is read
 * from the database on every AI request, and again right before the
 * provider is called). A new disclosure version requires consent again.
 */

/**
 * Change this when the disclosure below changes in substance (owners consent again). Sending store
 * data to another provider is such a change: name it here and add it to `AI_DISCLOSED_PROVIDER_IDS`
 * (lib/ai-providers/registry.ts), which is what lets requests be routed to it.
 */
export const AI_CONSENT_VERSION = "2026-11-17.1";
/** Every provider store data may go to (`AI_DISCLOSED_PROVIDER_IDS`); the platform chooses which one handles a request. */
export const AI_PROVIDER_NAMES = ["Google Gemini", "Anthropic Claude", "OpenAI"] as const;
/** Shown when no single provider is in use yet. */
export const AI_PROVIDER_NAME = "Google Gemini, Anthropic Claude or OpenAI";

/** What this version adds, shown to an owner whose consent is for an older one. */
export const AI_CONSENT_CHANGES = "New in this version: besides Google Gemini, the platform may now send AI requests to Anthropic Claude or OpenAI. The same store details are sent, whichever one handles a request.";

export const AI_CONSENT_DISCLOSURE: readonly string[] = [
  "AI providers: each AI request is handled by one of Google Gemini, Anthropic Claude or OpenAI, chosen by the platform. Whichever one it is receives the details listed here, and only for that request.",
  "The AI provider processes the store content sent with each AI request: your business name, type and description, your selected theme, your homepage settings and sections, the titles and text of your website pages, and product titles, descriptions, categories and options.",
  "Website page content: the titles of this store's pages, and the description and section text of the page you ask about, are sent to the AI provider. Only this store's pages are used and images are never sent. Email addresses, phone numbers and your saved contact details are removed from everything sent; please keep other private details, and differently worded addresses, out of your pages and products.",
  "Website conversations: when you build your website with the assistant, your messages in that conversation, what it has noted about your business, your design and menu choices, and the text of your pages are sent to the AI provider. Your messages are kept with this store for 14 days after the last one, or until you start again. After that they are never used again, and they are deleted the next time cleanup runs.",
  "Product and media details: product names, product categories and media file names may be sent to the AI provider so the assistant can choose products and pictures for your website. So may the descriptions of your media. A picture's file name is used when it has no description, so keep private details out of your file names. Picture addresses, product ids, prices and stock levels are not sent.",
  "Customer information, orders, payment information, and account or login data are never sent. Contact details, prices and stock levels are not sent either.",
  "AI suggestions can be wrong. Nothing changes until you review a suggestion and approve it.",
  "Approved changes are saved as drafts. Publishing stays a separate action.",
  "You can turn AI suggestions off at any time; it takes effect immediately.",
];

export interface AiConsentState {
  /** Consented to the CURRENT disclosure version and not revoked. */
  granted: boolean;
  /** The version last agreed to (may be outdated). */
  version: string | null;
  grantedAt: Date | null;
  revokedAt: Date | null;
  /** A consent exists but for an older disclosure version. */
  outdated: boolean;
}

export function readAiConsent(value: unknown): AiConsentState {
  const v = (value && typeof value === "object" ? value : {}) as { version?: unknown; grantedAt?: unknown; revokedAt?: unknown };
  const version = typeof v.version === "string" ? v.version : null;
  const grantedAt = v.grantedAt instanceof Date ? v.grantedAt : null;
  const revokedAt = v.revokedAt instanceof Date ? v.revokedAt : null;
  const active = Boolean(version && grantedAt && !revokedAt);
  return { granted: active && version === AI_CONSENT_VERSION, version, grantedAt, revokedAt, outdated: active && version !== AI_CONSENT_VERSION };
}

export async function getAiConsent(businessId: string): Promise<AiConsentState> {
  await dbConnect();
  const business = await Business.findById(businessId).select("aiConsent").lean<{ aiConsent?: unknown }>();
  return readAiConsent(business?.aiConsent);
}

/** Refuses an AI request unless this business's owner has consented to the current disclosure. */
export async function assertAiConsent(businessId: string): Promise<void> {
  const consent = await getAiConsent(businessId);
  if (!consent.granted) {
    throw new HttpError(
      403,
      consent.outdated
        ? "The AI disclosure has changed. The store owner needs to review it and turn AI suggestions on again."
        : "AI suggestions are not turned on for this store. The store owner can turn them on after reviewing what is shared.",
      "ai_consent_required",
    );
  }
}

/** Why AI cannot be used for a store. "platform" and "task" say nothing about providers or settings: that is not a store owner's concern. */
export type AiUnavailableReason = "platform" | "task" | "suspended" | "not_in_plan" | "consent_required" | "consent_outdated";

const UNAVAILABLE_MESSAGES: Record<AiUnavailableReason, string> = {
  platform: "AI suggestions are not available on this platform right now. You can still make every change yourself.",
  task: "This kind of AI suggestion is not available right now. You can still make this change yourself.",
  suspended: "This business is suspended. Contact a platform administrator.",
  not_in_plan: "AI suggestions need an active plan that includes them.",
  consent_required: "AI suggestions are not turned on for this store. The store owner can turn them on after reviewing what is shared.",
  consent_outdated: "The AI disclosure has changed. The store owner needs to review it and turn AI suggestions on again.",
};

export interface AiReadiness {
  status: AiPlatformStatus;
  consent: AiConsentState;
  /** Null when requests can be made. */
  reason: AiUnavailableReason | null;
  /** A plain explanation for the person looking at the page; null when ready. */
  message: string | null;
  ready: boolean;
}

/**
 * The one answer to "can this store use AI?", for pages, panels and the API, in the same order as the
 * checks a request goes through. The server still checks each request, whatever a page was told.
 * With `task`, it is about that kind of request; without, about any.
 */
export async function aiReadiness(businessId: string, task?: AiTask): Promise<AiReadiness> {
  await dbConnect();
  const [status, consent, entitlements, business] = await Promise.all([
    aiPlatformStatus(),
    getAiConsent(businessId),
    getEntitlements(businessId),
    Business.findById(businessId).select("status").lean<{ status?: string }>(),
  ]);
  const reason: AiUnavailableReason | null = !status.available
    ? "platform"
    : task && !status.tasks[task]
      ? "task"
      : business?.status === "suspended"
        ? "suspended"
        : entitlements.aiRequestsPerMonth <= 0
          ? "not_in_plan"
          : !consent.granted
            ? consent.outdated
              ? "consent_outdated"
              : "consent_required"
            : null;
  return { status, consent, reason, message: reason ? UNAVAILABLE_MESSAGES[reason] : null, ready: reason === null };
}

/** The three states of the small writing helpers. */
export function aiStateOf(readiness: Pick<AiReadiness, "reason">): "on" | "needs_consent" | "off" {
  if (readiness.reason === null) return "on";
  return readiness.reason === "consent_required" || readiness.reason === "consent_outdated" ? "needs_consent" : "off";
}

/**
 * Records the owner's consent to `version` (must be the current disclosure,
 * i.e. the text they were shown). Current state and history are written in
 * one transaction.
 */
export async function grantAiConsent(input: { businessId: string; actorId: string; version: string }): Promise<AiConsentState> {
  if (input.version !== AI_CONSENT_VERSION) {
    throw new HttpError(409, "The AI disclosure has changed. Reload the page and review it again.", "consent_version_mismatch");
  }
  return writeConsent(input.businessId, input.actorId, "granted");
}

export async function revokeAiConsent(input: { businessId: string; actorId: string }): Promise<AiConsentState> {
  return writeConsent(input.businessId, input.actorId, "revoked");
}

async function writeConsent(businessId: string, actorId: string, action: "granted" | "revoked"): Promise<AiConsentState> {
  await dbConnect();
  const business = new mongoose.Types.ObjectId(businessId);
  const actor = new mongoose.Types.ObjectId(actorId);
  const now = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await Business.findById(business).select("aiConsent").session(session).lean<{ aiConsent?: { version?: string } }>();
      if (!current) throw new HttpError(404, "Business not found", "not_found");
      const set =
        action === "granted"
          ? { aiConsent: { version: AI_CONSENT_VERSION, grantedAt: now, grantedBy: actor, revokedAt: null, revokedBy: null } }
          : { "aiConsent.revokedAt": now, "aiConsent.revokedBy": actor };
      if (action === "revoked" && !current.aiConsent) return; // nothing to revoke
      await Business.updateOne({ _id: business }, { $set: set }, { session });
      await AiConsentEvent.create([{ business, actor, action, version: action === "granted" ? AI_CONSENT_VERSION : (current.aiConsent?.version ?? AI_CONSENT_VERSION) }], { session });
    });
  } finally {
    await session.endSession();
  }
  return getAiConsent(businessId);
}

export async function listAiConsentEvents(businessId: string) {
  await dbConnect();
  const events = await AiConsentEvent.find({ business: new mongoose.Types.ObjectId(businessId) })
    .sort({ createdAt: -1 })
    .limit(20)
    .populate<{ actor: { name?: string } | null }>("actor", "name")
    .lean();
  return events.map((e) => ({ action: e.action, version: e.version, at: e.createdAt, actor: e.actor && typeof e.actor === "object" ? (e.actor.name ?? "") : "" }));
}

/** Everything the consent card shows (plain, serializable values). */
export async function loadAiConsentView(businessId: string, isOwner: boolean) {
  const readiness = await aiReadiness(businessId);
  const { status, consent, reason } = readiness;
  return {
    provider: { name: status.providerName ?? AI_PROVIDER_NAME, available: status.available },
    /** Kinds of request the platform can handle now. */
    tasks: status.tasks,
    /** Why this store cannot use AI, whatever the owner's consent: its plan or a suspension. */
    blockedMessage: reason === "suspended" || reason === "not_in_plan" ? readiness.message : null,
    disclosure: { version: AI_CONSENT_VERSION, points: [...AI_CONSENT_DISCLOSURE], changes: AI_CONSENT_CHANGES },
    consent: {
      granted: consent.granted,
      outdated: consent.outdated,
      version: consent.version,
      grantedAt: consent.grantedAt?.toISOString() ?? null,
      revokedAt: consent.revokedAt?.toISOString() ?? null,
    },
    canManage: isOwner,
    history: isOwner ? (await listAiConsentEvents(businessId)).map((h) => ({ ...h, at: h.at.toISOString() })) : [],
    /** AI requests can be made for this business right now. */
    ready: readiness.ready,
  };
}
