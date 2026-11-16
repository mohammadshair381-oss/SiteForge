import crypto from "node:crypto";
import mongoose, { type ClientSession, type Types } from "mongoose";
import { runAfterResponse } from "@/lib/after-response";
import { HttpError } from "@/lib/api";
import { assertCanAddStaff, getEntitlements, takeUsageTurn } from "@/lib/billing";
import { notifyTeamAccepted } from "@/lib/notification-events";
import { withUsageCheck } from "@/lib/usage-limits";
import type { MembershipRole } from "@/lib/constants";
import { dbConnect } from "@/lib/db";
import { isEmailDisabled, sendEmail } from "@/lib/email";
import { renderTeamInvitationEmail } from "@/lib/email-templates";
import { env } from "@/lib/env";
import { assertFeatureReady } from "@/lib/required-indexes";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { TeamInvitation, type TeamInvitationDoc } from "@/models/TeamInvitation";
import { User } from "@/models/User";

/**
 * Team invitations (server-only). Inviting never looks at whether the address has
 * an account, so nothing here can reveal that. Nobody joins until the invited
 * person accepts, signed in with that address; who invited them, the store and the
 * plan are all checked again at that moment. The link's token is 256 random bits,
 * of which only a hash is kept, and the raw value exists only in the email.
 */
export const INVITATION_TTL_DAYS = 7;
const INVITATION_TTL_MS = INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ROLE_LABELS: Record<MembershipRole, string> = { owner: "an owner", manager: "a manager", staff: "a staff member" };

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");
const invalidLink = () => new HttpError(400, "This invitation is no longer valid. Ask for a new one.", "invalid_invitation");

/** `expired` is worked out from the date: the stored status stays `pending`, so it can be sent again. */
export type InvitationState = "pending" | "expired" | "accepted" | "revoked";

export interface InvitationView {
  id: string;
  email: string;
  role: MembershipRole;
  state: InvitationState;
  expiresAt: string;
  lastSentAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  expired: boolean;
}

const isoOrNull = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

function toView(
  invitation: Pick<TeamInvitationDoc, "_id" | "email" | "role" | "expiresAt" | "lastSentAt"> & { status: string; acceptedAt?: Date | null; revokedAt?: Date | null },
  now = new Date(),
): InvitationView {
  const expired = new Date(invitation.expiresAt).getTime() <= now.getTime();
  return {
    id: String(invitation._id),
    email: invitation.email,
    role: invitation.role,
    state: invitation.status === "accepted" || invitation.status === "revoked" ? invitation.status : expired ? "expired" : "pending",
    expiresAt: new Date(invitation.expiresAt).toISOString(),
    lastSentAt: new Date(invitation.lastSentAt).toISOString(),
    acceptedAt: isoOrNull(invitation.acceptedAt),
    revokedAt: isoOrNull(invitation.revokedAt),
    expired,
  };
}

/** Who may invite to which role: owners to any, managers to staff only and only if the owner allows it. */
export function rolesInviterMayGrant(inviterRole: MembershipRole, managersCanInvite: boolean): MembershipRole[] {
  if (inviterRole === "owner") return ["owner", "manager", "staff"];
  if (inviterRole === "manager" && managersCanInvite) return ["staff"];
  return [];
}

async function loadInviteContext(businessId: string, inviterRole: MembershipRole) {
  await dbConnect();
  const business = await Business.findById(businessId).select("name status managersCanInvite").lean<{ name: string; status: string; managersCanInvite?: boolean }>();
  if (!business) throw new HttpError(404, "Business not found", "not_found");
  if (business.status === "suspended") throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  const grantable = rolesInviterMayGrant(inviterRole, business.managersCanInvite === true);
  if (grantable.length === 0) throw new HttpError(403, "Only the store owner can manage the team.", "forbidden");
  return { business, grantable };
}

function queueEmail(input: { to: string; token: string; businessName: string; inviterName: string; role: MembershipRole }): void {
  const acceptUrl = `${env().APP_URL.replace(/\/+$/, "")}/invitations/accept#token=${encodeURIComponent(input.token)}`;
  runAfterResponse(
    async () => {
      await sendEmail({
        to: input.to,
        ...renderTeamInvitationEmail({
          businessName: input.businessName,
          inviterName: input.inviterName,
          roleLabel: ROLE_LABELS[input.role],
          acceptUrl,
          expiresInDays: INVITATION_TTL_DAYS,
        }),
      });
    },
    { operation: "team_invitation", onError: () => console.error("[team-invitation] email could not be sent") },
  );
}

/** Every invitation, newest first, whatever became of it. */
export async function listInvitations(businessId: string): Promise<InvitationView[]> {
  await dbConnect();
  const invitations = await TeamInvitation.find({ business: businessId }).sort({ createdAt: -1 }).limit(100).lean();
  return invitations.map((invitation) => toView(invitation));
}

/** Places already promised count too, or every invitation could be sent and some refused later. */
async function assertPlaceAvailable(businessId: string, email: string, now: Date, session: ClientSession): Promise<void> {
  await takeUsageTurn(businessId, session);
  // One after the other: a transaction runs one operation at a time.
  const { staffLimit } = await getEntitlements(businessId);
  const members = await Membership.countDocuments({ business: businessId }).session(session);
  const promised = await TeamInvitation.countDocuments({ business: businessId, status: "pending", email: { $ne: email }, expiresAt: { $gt: now } }).session(session);
  if (members - 1 + promised >= staffLimit) {
    throw new HttpError(402, "Every team place on your plan is taken or has an invitation waiting. Cancel an invitation, or upgrade your plan.", "limit_reached");
  }
}

/**
 * Callers authorise first and pass the inviter's role. A second invitation to the
 * same address replaces the first, so one person never holds two live links.
 */
export async function createInvitation(input: {
  businessId: string;
  inviter: { _id: unknown; name?: string };
  inviterRole: MembershipRole;
  email: string;
  role: MembershipRole;
}): Promise<InvitationView> {
  await assertFeatureReady("team_invitations");
  assertInvitationEmailAvailable();
  const { business, grantable } = await loadInviteContext(input.businessId, input.inviterRole);
  if (!grantable.includes(input.role)) throw new HttpError(403, "You cannot invite someone to that role.", "forbidden");
  await assertCanAddStaff(input.businessId);

  const token = newToken();
  const now = new Date();
  const email = input.email.trim().toLowerCase();
  // The count and the invitation together, so two at once cannot take the last place.
  const invitation = await withUsageCheck(
    (session) => assertPlaceAvailable(input.businessId, email, now, session),
    (session) =>
      TeamInvitation.findOneAndUpdate(
        { business: input.businessId, email, status: "pending" },
        {
          $set: { role: input.role, tokenHash: hashToken(token), invitedBy: input.inviter._id, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS), lastSentAt: now },
          $setOnInsert: { business: input.businessId, email, status: "pending" },
        },
        { new: true, upsert: true, session },
      ).lean(),
  );
  if (!invitation) throw new HttpError(500, "The invitation could not be saved.", "internal_error");
  queueEmail({ to: email, token, businessName: business.name, inviterName: input.inviter.name || "A store owner", role: input.role });
  return toView(invitation, now);
}

/** An invitation is only a link in an email: with email turned off, none is created or resent. */
function assertInvitationEmailAvailable(): void {
  if (isEmailDisabled()) {
    throw new HttpError(503, "Team invitations are sent by email, which is turned off on this platform right now.", "email_disabled");
  }
}

/** Sends a new link and retires the old one. */
export async function resendInvitation(input: {
  businessId: string;
  invitationId: string;
  inviter: { _id: unknown; name?: string };
  inviterRole: MembershipRole;
}): Promise<InvitationView> {
  await assertFeatureReady("team_invitations");
  assertInvitationEmailAvailable();
  const { business, grantable } = await loadInviteContext(input.businessId, input.inviterRole);
  const token = newToken();
  const now = new Date();
  // An expired invitation holds no place, so sending it again has to find one.
  const current = await TeamInvitation.findOne({ _id: input.invitationId, business: input.businessId, status: "pending", role: { $in: grantable } }).select("email expiresAt").lean<{ email: string; expiresAt: Date }>();
  if (!current) throw new HttpError(404, "Invitation not found", "not_found");
  const expired = new Date(current.expiresAt).getTime() <= now.getTime();
  const invitation = await withUsageCheck(
    async (session) => {
      if (expired) await assertPlaceAvailable(input.businessId, current.email, now, session);
    },
    (session) =>
      TeamInvitation.findOneAndUpdate(
        { _id: input.invitationId, business: input.businessId, status: "pending", role: { $in: grantable } },
        { $set: { tokenHash: hashToken(token), invitedBy: input.inviter._id, expiresAt: new Date(now.getTime() + INVITATION_TTL_MS), lastSentAt: now } },
        { new: true, session },
      ).lean(),
  );
  if (!invitation) throw new HttpError(404, "Invitation not found", "not_found");
  queueEmail({ to: invitation.email, token, businessName: business.name, inviterName: input.inviter.name || "A store owner", role: invitation.role });
  return toView(invitation, now);
}

export async function revokeInvitation(input: { businessId: string; invitationId: string; inviterRole: MembershipRole }): Promise<void> {
  const { grantable } = await loadInviteContext(input.businessId, input.inviterRole);
  const revoked = await TeamInvitation.findOneAndUpdate(
    { _id: input.invitationId, business: input.businessId, status: "pending", role: { $in: grantable } },
    { $set: { status: "revoked", revokedAt: new Date() } },
  ).lean();
  if (!revoked) throw new HttpError(404, "Invitation not found", "not_found");
}

async function loadLive(rawToken: unknown, now: Date): Promise<TeamInvitationDoc | null> {
  if (typeof rawToken !== "string" || !TOKEN_PATTERN.test(rawToken)) return null;
  await dbConnect();
  return TeamInvitation.findOne({ tokenHash: hashToken(rawToken), status: "pending", expiresAt: { $gt: now } }).select("+tokenHash").lean<TeamInvitationDoc>();
}

/** What the link's holder may see before accepting. Every bad link gets the same error. */
export async function inspectInvitation(rawToken: unknown, signedInEmail: string | null) {
  await assertFeatureReady("team_invitations");
  const invitation = await loadLive(rawToken, new Date());
  if (!invitation) throw invalidLink();
  const business = await Business.findById(invitation.business).select("name status").lean<{ name: string; status: string }>();
  if (!business || business.status === "suspended") throw invalidLink();
  return {
    businessName: business.name,
    role: invitation.role,
    email: invitation.email,
    signedIn: signedInEmail !== null,
    sameAccount: signedInEmail !== null && signedInEmail.toLowerCase() === invitation.email,
  };
}

/** Whoever invited must still be allowed to, now. */
async function assertInviterStillAllowed(invitation: TeamInvitationDoc): Promise<void> {
  const [business, membership, inviter] = await Promise.all([
    Business.findById(invitation.business).select("status managersCanInvite").lean<{ status: string; managersCanInvite?: boolean }>(),
    Membership.findOne({ business: invitation.business, user: invitation.invitedBy, status: "active" }).select("role").lean<{ role: MembershipRole }>(),
    User.findById(invitation.invitedBy).select("active").lean<{ active?: boolean }>(),
  ]);
  if (!business || business.status === "suspended") throw invalidLink();
  if (!membership || !inviter || inviter.active === false) throw invalidLink();
  if (!rolesInviterMayGrant(membership.role, business.managersCanInvite === true).includes(invitation.role)) throw invalidLink();
}

/**
 * Accepts in one transaction with the status claim, so a link works once however
 * many requests arrive. Callers pass a signed-in user with a confirmed address.
 */
export async function acceptInvitation(input: { rawToken: unknown; user: { _id: unknown; email: string } }): Promise<{ businessId: string; alreadyMember: boolean }> {
  await assertFeatureReady("team_invitations");
  const now = new Date();
  const invitation = await loadLive(input.rawToken, now);
  if (!invitation) throw invalidLink();
  if (input.user.email.toLowerCase() !== invitation.email) {
    throw new HttpError(403, "This invitation was sent to a different email address. Log in with that address to accept it.", "wrong_account");
  }
  await assertInviterStillAllowed(invitation);
  await assertCanAddStaff(String(invitation.business));

  let alreadyMember = false;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const claimed = await TeamInvitation.findOneAndUpdate(
        { _id: invitation._id, status: "pending", tokenHash: invitation.tokenHash, expiresAt: { $gt: now } },
        { $set: { status: "accepted", acceptedBy: input.user._id as Types.ObjectId, acceptedAt: now } },
        { session },
      );
      if (!claimed) throw invalidLink();
      const existing = await Membership.findOne({ business: invitation.business, user: input.user._id }).session(session);
      // A current member keeps the role they have: an invitation never changes one.
      alreadyMember = Boolean(existing);
      if (!existing) {
        // Exact: counted in the same transaction as the new membership.
        await assertCanAddStaff(String(invitation.business), session);
        await Membership.create([{ business: invitation.business, user: input.user._id, role: invitation.role, status: "active" }], { session });
      }
    });
  } finally {
    await session.endSession();
  }
  notifyTeamAccepted(String(invitation.business), invitation._id);
  return { businessId: String(invitation.business), alreadyMember };
}
