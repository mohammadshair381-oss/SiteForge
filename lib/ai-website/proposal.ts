import mongoose from "mongoose";
import { HttpError } from "@/lib/api";
import { assertAiConsent } from "@/lib/ai-builder/consent";
import { redactText } from "@/lib/ai-builder/sanitize";
import { dbConnect } from "@/lib/db";
import { PROPOSAL_TTL_MS, WebsiteProposal, type WebsiteProposalDoc } from "@/models/WebsiteProposal";
import { AiConversation } from "@/models/AiConversation";
import { changesBetween, diffWebsite, hasChanges, rebaseWebsiteChanges, stateAfterChanges, websitePreviewOf } from "./build";
import type { ClassicHomepage, WebsiteBase, WebsiteChanges, WebsiteIdentity, WebsiteProposalData, WebsiteState } from "./blueprint";
import { loadWebsiteState, type LoadedWebsite } from "./state";

/**
 * A complete website change as ONE proposal (WebsiteProposal, target "website"): same states, expiry,
 * review and apply routes as every other proposal, with one approval for all of it. It records the draft
 * versions it was prepared against, for what it touches only, so an edit elsewhere does not invalidate it.
 *
 * Every owner and manager can see a proposal, but a conversation is private to the person having it. So a
 * proposal never holds a message, or the assistant's words about one: its description is worked out from
 * what it changes, it has no `request`, and its notes are scrubbed. What it proposes to put on the store is
 * shown, because that is what is being reviewed.
 */

/** Versions of just what these changes touch. */
function baseFor(base: WebsiteBase, changes: WebsiteChanges): WebsiteBase {
  const touched = new Set(changes.updatePages.map((page) => page.id));
  return { ...base, pageVersions: base.pageVersions.filter((entry) => touched.has(entry.pageId)) };
}

const inWords = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const countOf = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** A proposal's shared description, from its changes alone, so nothing anyone typed can reach it. */
export function describeWebsiteChanges(changes: WebsiteChanges): string {
  const areas = [...(changes.config ? ["homepage"] : []), ...(changes.design ? ["design"] : []), ...(changes.navigation ? ["menus"] : [])];
  const parts = [
    ...(areas.length > 0 ? [`changes your ${inWords(areas)}`] : []),
    ...(changes.createPages.length > 0 ? [`adds ${countOf(changes.createPages.length, "new page")}`] : []),
    ...(changes.updatePages.length > 0 ? [`updates ${countOf(changes.updatePages.length, "existing page")}`] : []),
  ];
  return parts.length > 0 ? `Website proposal: ${inWords(parts)}.` : "Website proposal.";
}

export async function createWebsiteProposal(input: {
  businessId: string;
  actorId: string;
  loaded: LoadedWebsite;
  changes: WebsiteChanges;
  notes: string[];
  identity?: WebsiteIdentity;
  conversationId?: string;
  /** Chosen in advance, so an interrupted save can be repeated without making a second proposal. */
  proposalId?: string;
}): Promise<WebsiteProposalDoc> {
  await dbConnect();
  const { loaded, changes } = input;
  const notes = input.notes.map((note) => redactText(note, 200)).filter(Boolean);
  const classic = changes.config ? loaded.classicHomepage : null;
  const after: WebsiteState = stateAfterChanges(loaded.state, changes);
  const website: WebsiteProposalData = {
    changes,
    base: baseFor(loaded.base, changes),
    baseline: {
      ...(changes.config ? { config: loaded.state.config } : {}),
      ...(changes.design ? { design: loaded.state.design } : {}),
      ...(changes.navigation ? { navigation: loaded.state.navigation } : {}),
      pages: loaded.state.pages.filter((page) => changes.updatePages.some((update) => update.id === page.id)),
    },
    ...(input.identity ? { identity: input.identity } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    notes: notes.slice(0, 10),
  };
  const now = new Date();
  const actor = new mongoose.Types.ObjectId(input.actorId);
  const doc = {
    ...(input.proposalId ? { _id: new mongoose.Types.ObjectId(input.proposalId) } : {}),
    business: new mongoose.Types.ObjectId(input.businessId),
    createdBy: actor,
    source: "ai" as const,
    target: "website" as const,
    summary: describeWebsiteChanges(changes).slice(0, 280),
    actions: [],
    pageVersions: website.base.pageVersions.map((entry) => ({ pageId: entry.pageId, expectedVersion: entry.version })),
    diff: withClassicRow(diffWebsite(loaded.state, changes), classic),
    preview: websitePreviewOf(after, changes, classic),
    website,
    status: "pending" as const,
    expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
    history: [{ at: now, action: "created" as const, actor, note: "ai" }],
  };
  try {
    return (await WebsiteProposal.create(doc)).toObject() as WebsiteProposalDoc;
  } catch (error) {
    // The same proposal was saved by an attempt that was cut off before it could report back.
    if (input.proposalId && error && typeof error === "object" && (error as { code?: unknown }).code === 11000) {
      const existing = await WebsiteProposal.findOne({ _id: input.proposalId, business: input.businessId }).lean<WebsiteProposalDoc>();
      if (existing) return existing;
    }
    throw error;
  }
}

/** The owner can see that their current homepage stays, right in the list of changes. */
function withClassicRow(diff: ReturnType<typeof diffWebsite>, classic: ClassicHomepage | null): ReturnType<typeof diffWebsite> {
  if (!classic) return diff;
  return {
    ...diff,
    changes: [{ area: "homepage", kind: "modified", label: "What visitors see on your homepage", before: "Your custom homepage", after: "Stays as it is until you publish from the website editor", live: false }, ...diff.changes],
    summary: { ...diff.summary },
  };
}

/** What this proposal touches that has changed since it was prepared, in the owner's words. Empty: nothing has. */
export async function websiteStaleItems(doc: Pick<WebsiteProposalDoc, "business" | "website">): Promise<string[]> {
  const data = doc.website as WebsiteProposalData | undefined;
  if (!data) return ["your website"];
  const { base, state } = await loadWebsiteState(String(doc.business));
  const items: string[] = [];
  if (data.changes.config && data.base.storefrontVersion !== base.storefrontVersion) items.push("your homepage");
  if (data.changes.design && data.base.designVersion !== base.designVersion) items.push("your design");
  if (data.changes.navigation && data.base.navigationVersion !== base.navigationVersion) items.push("your menus");
  for (const entry of data.base.pageVersions) {
    const page = state.pages.find((candidate) => candidate.id === entry.pageId);
    if (!page) items.push("a page that no longer exists");
    else if (page.version !== entry.version) items.push(`the page "${page.title}"`);
  }
  for (const page of data.changes.createPages) {
    if (state.pages.some((candidate) => candidate.slug === page.slug)) items.push(`the address /${page.slug}`);
  }
  return [...new Set(items)];
}

/** Compared only for what the proposal changes. */
export function baseDiffers(data: WebsiteProposalData, current: WebsiteBase): boolean {
  const { changes, base } = data;
  if (changes.config && base.storefrontVersion !== current.storefrontVersion) return true;
  if (changes.design && base.designVersion !== current.designVersion) return true;
  if (changes.navigation && base.navigationVersion !== current.navigationVersion) return true;
  return base.pageVersions.some((entry) => current.pageVersions.find((page) => page.pageId === entry.pageId)?.version !== entry.version);
}

/** A newer version of a waiting proposal replaces it. Its review history says why. */
export async function supersedeProposal(businessId: string, proposalId: unknown, actorId: string): Promise<void> {
  await WebsiteProposal.updateOne(
    { _id: new mongoose.Types.ObjectId(String(proposalId)), business: businessId, status: "pending" },
    { $set: { status: "rejected", reviewedAt: new Date() }, $push: { history: { at: new Date(), action: "rejected", actor: new mongoose.Types.ObjectId(actorId), note: "superseded" } } },
  );
}

/**
 * Brings a stale proposal up to date with the drafts as they are now, asking no provider and using no
 * allowance. The owner's newer edits always stay. If an edit and the proposal changed the same thing, the
 * proposal is left as it is and the conflict is named, so the owner can ask the assistant again. The result
 * is a new proposal, reviewed like any other: optimistic concurrency is not relaxed by this.
 */
export async function refreshWebsiteProposal(input: { businessId: string; proposalId: string; actorId: string }): Promise<{ proposal: WebsiteProposalDoc | null; conflicts: string[]; unchanged: boolean }> {
  await dbConnect();
  const doc = await WebsiteProposal.findOne({ _id: new mongoose.Types.ObjectId(input.proposalId), business: new mongoose.Types.ObjectId(input.businessId), target: "website" }).lean<WebsiteProposalDoc>();
  if (!doc) throw new HttpError(404, "Proposal not found", "not_found");
  const data = doc.website as WebsiteProposalData | undefined;
  const open = doc.status === "pending" || doc.status === "approved" || (doc.status === "failed" && doc.failureCode === "version_conflict");
  if (!data || !open || doc.expiresAt.getTime() <= Date.now()) throw new HttpError(409, "This proposal can no longer be refreshed. Ask the assistant again.", "proposal_not_refreshable");
  if (!data.baseline) return { proposal: null, conflicts: ["this proposal, which is too old to refresh"], unchanged: false };
  await assertAiConsent(input.businessId);
  // Nothing has changed since it was made, for example a second click: it is still good as it is.
  if ((await websiteStaleItems(doc)).length === 0) return { proposal: doc, conflicts: [], unchanged: false };

  const loaded = await loadWebsiteState(input.businessId);
  const { state, conflicts } = rebaseWebsiteChanges(data.baseline, data.changes, loaded.state);
  if (conflicts.length > 0) return { proposal: null, conflicts, unchanged: false };
  const changes = changesBetween(loaded.state, state);
  if (!hasChanges(changes)) return { proposal: null, conflicts: [], unchanged: true };

  const proposal = await createWebsiteProposal({
    businessId: input.businessId,
    actorId: input.actorId,
    loaded,
    changes,
    // Described afresh: whatever an older proposal stored about its request is not carried over.
    notes: data.notes,
    ...(data.identity ? { identity: data.identity } : {}),
    ...(data.conversationId ? { conversationId: data.conversationId } : {}),
  });
  await WebsiteProposal.updateOne(
    { _id: doc._id, business: doc.business, status: { $in: ["pending", "approved"] } },
    { $set: { status: "rejected", reviewedAt: new Date() }, $push: { history: { at: new Date(), action: "rejected", actor: new mongoose.Types.ObjectId(input.actorId), note: "refreshed" } } },
  );
  // A conversation following the old proposal follows the new one. No one's messages are read or shown.
  await AiConversation.updateMany({ business: doc.business, proposalId: doc._id }, { $set: { proposalId: proposal._id } });
  return { proposal, conflicts: [], unchanged: false };
}
