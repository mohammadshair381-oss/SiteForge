import crypto from "node:crypto";
import { Types } from "mongoose";
import { HttpError } from "@/lib/api";
import { isEmailVerified } from "@/lib/auth/guards";
import { assertCanPublish, getEntitlements } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { PREVIEW_LINK_DURATIONS, type PreviewLinkDuration, type PreviewLinkSummary } from "@/lib/preview-link-options";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { PreviewLink, type PreviewLinkScope } from "@/models/PreviewLink";
import { User } from "@/models/User";

/**
 * Draft preview links (server-only). The raw token is 256 random bits, returned
 * once to the person who creates the link, and never stored, logged or returned
 * again: only its SHA-256 hash is kept. Every failure looks the same to a visitor.
 * A link needs no account to open, so it only ever shows what the storefront
 * shows, with drafts; see app/preview/view/page.tsx.
 */
const MAX_ACTIVE_LINKS = 20;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export async function listPreviewLinks(businessId: string): Promise<PreviewLinkSummary[]> {
  await dbConnect();
  const links = await PreviewLink.find({ business: businessId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  const pageIds = links.flatMap((link) => (link.page ? [link.page] : []));
  const pages = pageIds.length > 0 ? await Page.find({ _id: { $in: pageIds }, business: businessId }).select("title").lean() : [];
  const titles = new Map(pages.map((page) => [String(page._id), page.title]));
  return links.map((link) => ({
    id: String(link._id),
    scope: link.scope,
    pageId: link.page ? String(link.page) : null,
    pageTitle: link.page ? titles.get(String(link.page)) ?? null : null,
    createdAt: new Date(link.createdAt).toISOString(),
    expiresAt: new Date(link.expiresAt).toISOString(),
  }));
}

/** Callers authorise first. Returns the raw token: this is the only time it exists. */
export async function createPreviewLink(input: {
  businessId: string;
  createdBy: unknown;
  scope: PreviewLinkScope;
  pageId?: string;
  duration: PreviewLinkDuration;
}): Promise<{ token: string; link: PreviewLinkSummary }> {
  await dbConnect();
  const business = await Business.findById(input.businessId).select("status").lean<{ status: string }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  // A shared draft is a page anyone with the link can open, so it needs the same
  // active plan as publishing: otherwise it would be free public hosting.
  await assertCanPublish(input.businessId);
  let page: Types.ObjectId | null = null;
  let pageTitle: string | null = null;
  if (input.scope === "page") {
    if (!input.pageId || !Types.ObjectId.isValid(input.pageId)) throw new HttpError(400, "Choose a page to preview.", "invalid_page");
    const found = await Page.findOne({ _id: input.pageId, business: input.businessId }).select("title").lean();
    if (!found) throw new HttpError(404, "Page not found", "not_found");
    page = found._id as Types.ObjectId;
    pageTitle = found.title;
  }

  const now = new Date();
  // Finished links are of no further use (the TTL index is only eventual cleanup).
  await PreviewLink.deleteMany({ business: input.businessId, $or: [{ expiresAt: { $lte: now } }, { revokedAt: { $ne: null } }] });
  if ((await PreviewLink.countDocuments({ business: input.businessId })) >= MAX_ACTIVE_LINKS) {
    throw new HttpError(409, `You can have up to ${MAX_ACTIVE_LINKS} preview links. Remove one first.`, "too_many_preview_links");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const created = await PreviewLink.create({
    business: input.businessId,
    tokenHash: hashToken(token),
    scope: input.scope,
    page,
    createdBy: input.createdBy,
    expiresAt: new Date(now.getTime() + PREVIEW_LINK_DURATIONS[input.duration].ms),
  });
  return {
    token,
    link: {
      id: String(created._id),
      scope: created.scope,
      pageId: page ? String(page) : null,
      pageTitle,
      createdAt: created.createdAt.toISOString(),
      expiresAt: created.expiresAt.toISOString(),
    },
  };
}

export async function revokePreviewLink(businessId: string, linkId: string): Promise<void> {
  if (!Types.ObjectId.isValid(linkId)) throw new HttpError(404, "Preview link not found", "not_found");
  await dbConnect();
  const result = await PreviewLink.updateOne({ _id: linkId, business: businessId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (result.matchedCount === 0) throw new HttpError(404, "Preview link not found", "not_found");
}

export interface PreviewAccess {
  businessId: string;
  scope: PreviewLinkScope;
  pageId: string | null;
  expiresAt: Date;
}

/**
 * What a token may show, or null. Checked on every view: the link exists, has not
 * expired or been revoked, the business is not suspended, and whoever created the
 * link can still manage this business with a verified email, so leaving the team
 * ends their links, and the business still has an active plan.
 */
export async function resolvePreviewLink(token: unknown): Promise<PreviewAccess | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  await dbConnect();
  const now = new Date();
  const link = await PreviewLink.findOne({ tokenHash: hashToken(token), revokedAt: null, expiresAt: { $gt: now } }).lean();
  if (!link || new Date(link.expiresAt).getTime() <= now.getTime()) return null;

  const [business, membership, creator, entitlements] = await Promise.all([
    Business.findById(link.business).select("status").lean<{ status: string }>(),
    Membership.findOne({ business: link.business, user: link.createdBy, role: { $in: ["owner", "manager"] }, status: "active" }).select("_id").lean(),
    User.findById(link.createdBy).select("active emailVerifiedAt").lean<{ active?: boolean; emailVerifiedAt?: Date | null }>(),
    getEntitlements(String(link.business)),
  ]);
  if (!business || business.status === "suspended" || !membership || !entitlements.active) return null;
  if (!creator || creator.active === false || !isEmailVerified(creator)) return null;
  return { businessId: String(link.business), scope: link.scope, pageId: link.page ? String(link.page) : null, expiresAt: new Date(link.expiresAt) };
}
