import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { claimAdvice, claimNeedsRealData } from "@/lib/ai-builder/claims";
import { redactText } from "@/lib/ai-builder/sanitize";
import { dbConnect } from "@/lib/db";
import { AiConversation, type AiConversationDoc } from "@/models/AiConversation";
import { WebsiteProposal } from "@/models/WebsiteProposal";
import type { WebsiteBrief } from "./answers";
import type { PlannedPage } from "./build";

/**
 * Website conversations (server-only). Every read and write names the business AND the person, so
 * nobody can reach another store's or another member's conversation, and a conversation stops at
 * `expiresAt`. Callers authorize with `requireBusinessRole` / `guardAiRequest` first.
 *
 * A conversation is deliberately private to the person having it: an owner does not read a manager's, or
 * the reverse. People may say things while thinking aloud that they would not put in front of colleagues.
 * The team works together through proposals, which every owner and manager can see. Sharing a conversation
 * would need the person's explicit choice to share it, and nothing here offers that.
 */
const LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
/** Kept in the record. Fewer are sent to a provider (lib/ai-website/prompts.ts). */
const MAX_STORED_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 2000;

export type ConversationPhase = "discovery" | "generating" | "proposal" | "applied";

export interface ConversationView {
  id: string;
  phase: ConversationPhase;
  messages: Array<{ role: "owner" | "assistant"; text: string; at: string }>;
  brief: WebsiteBrief;
  readyToGenerate: boolean;
  questions: string[];
  /** Wording refused by the claims check, and what to do about each. */
  flagged: Array<{ phrase: string; advice: string; canConfirm: boolean }>;
  /** The last step chose something this store does not have. Finished steps are kept, and only that step runs again. */
  needsCorrection: boolean;
  proposalId: string | null;
  /** The newest proposal's state, in case it was rejected or ran out. */
  proposalStatus: string | null;
  generation: { started: boolean; done: number; total: number; notes: string[] };
}

const ids = (businessId: string, userId: string) => ({ business: new mongoose.Types.ObjectId(businessId), createdBy: new mongoose.Types.ObjectId(userId) });

/** The person's open conversation with this store. `expired` means one ran out, so the screen can say so. */
export async function loadActiveConversation(businessId: string, userId: string): Promise<{ doc: AiConversationDoc | null; expired: boolean }> {
  await dbConnect();
  const doc = await AiConversation.findOne({ ...ids(businessId, userId), status: "active" }).sort({ createdAt: -1 }).lean<AiConversationDoc>();
  if (!doc) return { doc: null, expired: false };
  if (doc.expiresAt.getTime() > Date.now()) return { doc, expired: false };
  // What the consent disclosure promises: nothing is kept past its time.
  await AiConversation.deleteOne({ _id: doc._id, ...ids(businessId, userId) });
  return { doc: null, expired: true };
}

export async function startConversation(businessId: string, userId: string): Promise<AiConversationDoc> {
  await dbConnect();
  await AiConversation.deleteMany({ ...ids(businessId, userId) });
  // Anyone's conversation in this store that has run out goes too, unread.
  await AiConversation.deleteMany({ business: new mongoose.Types.ObjectId(businessId), expiresAt: { $lte: new Date() } });
  const doc = await AiConversation.create({ ...ids(businessId, userId), expiresAt: new Date(Date.now() + LIFETIME_MS) });
  return doc.toObject() as AiConversationDoc;
}

export async function activeOrNewConversation(businessId: string, userId: string): Promise<AiConversationDoc> {
  const { doc } = await loadActiveConversation(businessId, userId);
  return doc ?? startConversation(businessId, userId);
}

/** Removes the person's conversation. Its proposals stay, with their own state. */
export async function closeConversation(businessId: string, userId: string): Promise<void> {
  await dbConnect();
  await AiConversation.deleteMany({ ...ids(businessId, userId) });
}

export const CONVERSATION_PURGE_BATCH = 500;

/**
 * For the scheduled cleanup: deletes conversations past their 14 days, and any left closed by earlier code.
 * Runs across stores with no person involved, so it reads ids only: never a message, and nothing is returned
 * but a count. Checked again on deleting, so a message that arrives meanwhile keeps its conversation.
 */
export async function purgeExpiredConversations(): Promise<number> {
  await dbConnect();
  const due = () => ({ $or: [{ expiresAt: { $lte: new Date() } }, { status: "closed" as const }] });
  const found = await AiConversation.find(due()).select("_id").limit(CONVERSATION_PURGE_BATCH).lean<Array<{ _id: mongoose.Types.ObjectId }>>();
  if (found.length === 0) return 0;
  const { deletedCount } = await AiConversation.deleteMany({ _id: { $in: found.map((doc) => doc._id) }, ...due() });
  return deletedCount ?? 0;
}

/** Stores a message, scrubbed. Sending the same words again after a failure does not repeat them. */
export async function appendMessage(doc: AiConversationDoc, role: "owner" | "assistant", text: string): Promise<AiConversationDoc> {
  const clean = redactText(text, MAX_MESSAGE_CHARS).trim();
  const last = doc.messages[doc.messages.length - 1];
  if (!clean || (last && last.role === role && last.text === clean)) return doc;
  const message = { role, text: clean, at: new Date() };
  const updated = await AiConversation.findOneAndUpdate(
    { _id: doc._id, business: doc.business, createdBy: doc.createdBy },
    { $push: { messages: { $each: [message], $slice: -MAX_STORED_MESSAGES } }, $set: { expiresAt: new Date(Date.now() + LIFETIME_MS) } },
    { new: true },
  ).lean<AiConversationDoc>();
  if (!updated) throw new HttpError(404, "This conversation no longer exists. Start a new one.", "conversation_not_found");
  return updated;
}

/** Only one request at a time, so two tabs cannot generate the same step or spend the allowance twice. */
export async function claimConversation(doc: AiConversationDoc, forMs: number): Promise<void> {
  const now = new Date();
  const claimed = await AiConversation.findOneAndUpdate(
    { _id: doc._id, business: doc.business, createdBy: doc.createdBy, status: "active", $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(now.getTime() + forMs) } },
  )
    .select("_id")
    .lean();
  if (!claimed) throw new HttpError(409, "The assistant is still working on this conversation. Please wait a moment.", "conversation_busy");
}

export async function releaseConversation(doc: AiConversationDoc): Promise<void> {
  await AiConversation.updateOne({ _id: doc._id, business: doc.business, createdBy: doc.createdBy }, { $set: { leaseUntil: null } }).catch(() => {
    console.error("[ai-website] conversation lease not released; it runs out by itself");
  });
}

export async function updateConversation(doc: AiConversationDoc, set: Record<string, unknown>): Promise<void> {
  await AiConversation.updateOne({ _id: doc._id, business: doc.business, createdBy: doc.createdBy }, { $set: set });
}

export async function proposalStatusOf(doc: Pick<AiConversationDoc, "business" | "proposalId">): Promise<string | null> {
  if (!doc.proposalId) return null;
  const proposal = await WebsiteProposal.findOne({ _id: doc.proposalId, business: doc.business }).select("status expiresAt").lean<{ status: string; expiresAt: Date }>();
  if (!proposal) return null;
  return (proposal.status === "pending" || proposal.status === "approved") && proposal.expiresAt.getTime() <= Date.now() ? "failed" : proposal.status;
}

/** Decided by what has happened, never by the provider. A refused or expired proposal goes back to talking. */
export function phaseOf(doc: Pick<AiConversationDoc, "generation">, proposalStatus: string | null): ConversationPhase {
  if (proposalStatus === "pending" || proposalStatus === "approved") return "proposal";
  if (proposalStatus === "applied") return "applied";
  if (proposalStatus) return "discovery";
  return doc.generation?.plan ? "generating" : "discovery";
}

export async function conversationView(doc: AiConversationDoc): Promise<ConversationView> {
  const proposalStatus = await proposalStatusOf(doc);
  const pages = (doc.generation?.pages ?? []) as PlannedPage[];
  const contents = doc.generation?.contents ?? {};
  const planned = Boolean(doc.generation?.plan) && !proposalStatus;
  return {
    id: String(doc._id),
    phase: phaseOf(doc, proposalStatus),
    messages: doc.messages.map((message) => ({ role: message.role, text: message.text, at: new Date(message.at).toISOString() })),
    brief: (doc.brief ?? {}) as WebsiteBrief,
    readyToGenerate: doc.readyToGenerate === true,
    questions: doc.questions ?? [],
    flagged: (doc.flaggedClaims ?? []).map((phrase) => ({ phrase, advice: claimAdvice(phrase), canConfirm: !claimNeedsRealData(phrase) })),
    needsCorrection: (doc.answerCorrections ?? []).length > 0,
    proposalId: doc.proposalId ? String(doc.proposalId) : null,
    proposalStatus,
    generation: {
      started: planned,
      // The plan and homepage are one step, and each page is one more.
      done: planned ? 1 + pages.filter((page) => contents[page.key]).length : 0,
      total: planned ? 1 + pages.length : 0,
      notes: doc.generation?.notes ?? [],
    },
  };
}
