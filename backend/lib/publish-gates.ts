import { HttpError } from "@/lib/api";
import { isEmailVerified } from "@/lib/auth/guards";
import { assertCanPublish } from "@/lib/billing";
import type { MembershipRole } from "@/lib/constants";
import { assertObjectId } from "@/lib/ids";
import { navigationPageIds, type StoredNavigation } from "@/lib/navigation";
import { Business } from "@/models/Business";
import { Membership } from "@/models/Membership";
import { Page } from "@/models/Page";
import { User } from "@/models/User";

/**
 * The checks every change to what visitors see must pass, whichever route makes
 * it (server-only). A suspended business is frozen, the person needs a verified
 * email, and a store that is already live needs a plan that allows publishing.
 * A store that is not live yet shows nothing, and is checked when it goes live.
 */
/**
 * A suspended store is frozen: its content stays as it is for the platform's review,
 * so nothing can be taken down or renamed while it is suspended.
 */
export async function assertBusinessNotSuspended(businessId: string): Promise<void> {
  if (await Business.exists({ _id: businessId, status: "suspended" })) {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
}

/** Who may publish a store. The publish route and the Super Admin's view both read this. */
export const PUBLISH_ROLES: MembershipRole[] = ["owner", "manager"];

/** Publishing snapshots the menus, so every page they link to must belong to this store. */
export async function assertPublishNavigationValid(businessId: string, navigation: StoredNavigation | null | undefined): Promise<void> {
  if (!navigation) return;
  const pageIds = new Set(navigationPageIds(navigation));
  for (const pageId of pageIds) assertObjectId(pageId, "page id");
  if (pageIds.size === 0) return;
  const found = await Page.find({ _id: { $in: Array.from(pageIds) }, business: businessId }).select("_id").lean();
  const foundIds = new Set(found.map((page) => String(page._id)));
  for (const pageId of pageIds) {
    if (!foundIds.has(pageId)) throw new HttpError(400, `Page ${pageId} does not belong to this business.`, "invalid_navigation_reference");
  }
}

export interface PublishFacts {
  /** Someone holds a publishing role, with an active membership and account and a verified email. */
  hasEligiblePublisher: boolean;
  navigationValid: boolean;
}

/**
 * For the Super Admin: the same conditions as the guards above and in `requireBusinessRole` and
 * `requireVerifiedEmail`, for many stores at once. It only reads. Plan and suspension come
 * from `getEntitlements`' rule and the store's status (lib/store-access.ts).
 */
export async function getPublishFacts(businesses: ReadonlyArray<{ _id: unknown; themeSettings?: { navigation?: unknown } | null }>): Promise<Map<string, PublishFacts>> {
  const ids = businesses.map((business) => business._id);
  const memberships = await Membership.find({ business: { $in: ids }, role: { $in: PUBLISH_ROLES }, status: "active" }).select("business user").lean();
  const users = await User.find({ _id: { $in: memberships.map((membership) => membership.user) }, active: { $ne: false } }).select("emailVerifiedAt").lean();
  const eligibleUsers = new Set(users.filter((user) => isEmailVerified(user)).map((user) => String(user._id)));
  const withPublisher = new Set(memberships.filter((membership) => eligibleUsers.has(String(membership.user))).map((membership) => String(membership.business)));

  const linked = new Map(businesses.map((business) => [String(business._id), business.themeSettings?.navigation ? navigationPageIds(business.themeSettings.navigation as StoredNavigation) : []]));
  const wellFormed = (id: string) => /^[a-f0-9]{24}$/i.test(id);
  const allPageIds = [...new Set([...linked.values()].flat())].filter(wellFormed);
  const pages = allPageIds.length > 0 ? await Page.find({ _id: { $in: allPageIds }, business: { $in: ids } }).select("business").lean() : [];
  const pageOwner = new Map(pages.map((page) => [String(page._id), String(page.business)]));

  return new Map(
    businesses.map((business) => {
      const id = String(business._id);
      return [id, { hasEligiblePublisher: withPublisher.has(id), navigationValid: (linked.get(id) ?? []).every((pageId) => pageOwner.get(pageId) === id) }];
    }),
  );
}

export async function assertCanChangeLiveWebsite(
  business: { _id: unknown; status: string },
  user: { emailVerifiedAt?: Date | null },
): Promise<void> {
  if (business.status === "suspended") {
    throw new HttpError(403, "This business is suspended. Contact a platform administrator.", "suspended");
  }
  if (!isEmailVerified(user)) {
    throw new HttpError(403, "Verify your email address to continue", "email_unverified");
  }
  if (business.status === "published") await assertCanPublish(String(business._id));
}
