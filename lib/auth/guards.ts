import { dbConnect } from "../db";
import { HttpError } from "../api";
import { assertObjectId } from "../ids";
import { getSession } from "./session";
import { headers } from "next/headers";
import { recordRevokedPlatformSession } from "../security-events";
import { User, type UserDoc } from "@/models/User";
import { Membership, type MembershipDoc } from "@/models/Membership";
import { Business } from "@/models/Business";
import type { MembershipRole } from "../constants";
import type { HydratedDocument } from "mongoose";

export type UserDocument = HydratedDocument<UserDoc>;

/** The current request headers, or null outside a request (never throws). */
async function currentRequestHeaders(): Promise<Headers | null> {
  try {
    return (await headers()) as unknown as Headers;
  } catch {
    return null;
  }
}

/**
 * Resolves the current authenticated user or throws 401.
 * The super admin account is never hidden: it is a normal user with a
 * platform role, created through explicit tooling (see scripts/create-admin.ts).
 */
export async function requireUser(): Promise<UserDocument> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Authentication required", "unauthenticated");
  await dbConnect();
  const user = await User.findById(session.userId);
  if (!user || !user.active || session.tokenVersion !== user.tokenVersion) {
    // A correctly signed session that is no longer valid: recorded (throttled,
    // after the response) without changing the 401 below.
    recordRevokedPlatformSession({
      userId: String(session.userId),
      reason: !user ? "account_missing" : !user.active ? "inactive_account" : "token_version_mismatch",
      requestHeaders: await currentRequestHeaders(),
    });
  }
  if (!user || !user.active) {
    throw new HttpError(401, "Account is not available", "unauthenticated");
  }
  if (session.tokenVersion !== user.tokenVersion) {
    throw new HttpError(401, "Session is no longer valid", "session_revoked");
  }
  return user;
}

/**
 * Page-level variant of `requireSuperAdmin` for server components: instead of
 * throwing (which renders an error page), it reports where to send the
 * visitor. Uses exactly the same checks: valid session, active user, current
 * `tokenVersion`, and `platformRole === "super_admin"` read from the database.
 */
export async function resolveSuperAdminPageAccess(): Promise<
  | { kind: "allowed"; user: UserDocument }
  | { kind: "login" }
  | { kind: "forbidden" }
> {
  let user: UserDocument;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return { kind: "login" };
    throw error;
  }
  if (user.platformRole !== "super_admin") return { kind: "forbidden" };
  return { kind: "allowed", user };
}

export async function requireSuperAdmin(): Promise<UserDocument> {
  const user = await requireUser();
  if (user.platformRole !== "super_admin") {
    throw new HttpError(403, "Super admin access required", "forbidden");
  }
  return user;
}

/**
 * Email verification policy (see models/User.ts):
 *   - `null`      -> unverified;
 *   - `Date`      -> verified;
 *   - `undefined` -> legacy account, grandfathered as verified.
 * Only an explicit `null` is rejected.
 */
export function isEmailVerified(user: { emailVerifiedAt?: Date | null }): boolean {
  return user.emailVerifiedAt !== null;
}

/**
 * Resolves the authenticated user and rejects only accounts whose email is
 * explicitly unverified. Reads are never gated by this guard; apply it to the
 * specific privileged writes listed in Phase 4.16C.
 */
/** The signed-in user, or null: for pages that work either way. */
export async function getOptionalUser(): Promise<UserDocument | null> {
  try {
    return await requireUser();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}

export async function requireVerifiedEmail(): Promise<UserDocument> {
  const user = await requireUser();
  if (!isEmailVerified(user)) {
    throw new HttpError(
      403,
      "Verify your email address to continue",
      "email_unverified",
    );
  }
  return user;
}

export interface BusinessContext {
  user: UserDocument;
  membership: MembershipDoc;
}

/**
 * Verifies that the current user has one of the allowed roles for a business.
 * This is the single source of truth for tenant access; never trust a
 * business id coming from the browser without calling this.
 */
export async function requireBusinessRole(
  businessId: string,
  roles: MembershipRole[] = ["owner", "staff"],
): Promise<BusinessContext> {
  const user = await requireUser();
  const id = assertObjectId(businessId, "business id");
  await dbConnect();
  const membership = await Membership.findOne({
    business: id,
    user: user._id,
  });
  if (!membership || membership.status !== "active") {
    throw new HttpError(403, "You do not have access to this business", "forbidden");
  }
  if (!roles.includes(membership.role)) {
    throw new HttpError(403, "Insufficient permissions for this action", "forbidden");
  }
  return { user, membership };
}

export async function getMembershipsForUser(userId: string) {
  await dbConnect();
  return Membership.find({ user: userId })
    .populate({ path: "business", model: Business })
    .sort({ createdAt: 1 })
    .lean();
}
