import { createUser } from "./fixtures";
import { Business, type BusinessDoc } from "@/models/Business";
import { Membership, type MembershipDoc } from "@/models/Membership";
import { Plan, type PlanDoc } from "@/models/Plan";
import { Subscription, type SubscriptionDoc } from "@/models/Subscription";
import type {
  ThemeId,
  BusinessStatus,
  MembershipRole,
  MembershipStatus,
  SubscriptionStatus,
} from "@/lib/constants";
import type { HydratedDocument, Types } from "mongoose";

/** Unique, lowercase, safe suffix for slugs, subdomains, and plan keys. */
export function tenantSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface PlanOptions {
  key?: string;
  price?: number;
  interval?: "month" | "year";
  productLimit?: number;
  staffLimit?: number;
  customDomain?: boolean;
  removeBranding?: boolean;
  active?: boolean;
  /** Themes the plan includes; omitted = the default tier for the key/price. */
  themes?: ThemeId[];
}

export async function createPlan(
  options: PlanOptions = {},
): Promise<HydratedDocument<PlanDoc>> {
  const key = (options.key ?? `plan-${tenantSuffix()}`).toLowerCase();
  return Plan.create({
    key,
    name: `Plan ${key}`,
    description: `Plan ${key} for integration tests`,
    price: options.price ?? 0,
    currency: "USD",
    interval: options.interval ?? "month",
    features: {
      productLimit: options.productLimit ?? 10,
      staffLimit: options.staffLimit ?? 1,
      customDomain: options.customDomain ?? false,
      removeBranding: options.removeBranding ?? false,
      ...(options.themes ? { themes: options.themes } : {}),
    },
    active: options.active ?? true,
  });
}

export interface BusinessOptions {
  name?: string;
  status?: BusinessStatus;
}

export async function createBusiness(
  ownerId: Types.ObjectId,
  options: BusinessOptions = {},
): Promise<BusinessDoc> {
  const s = tenantSuffix();
  return Business.create({
    name: options.name ?? `Business ${s}`,
    slug: `biz-${s}`,
    subdomain: `biz-${s}`,
    category: "services",
    owner: ownerId,
    status: options.status ?? "draft",
  });
}

export async function createMembership(
  businessId: Types.ObjectId,
  userId: Types.ObjectId,
  role: MembershipRole,
  status: MembershipStatus = "active",
): Promise<MembershipDoc> {
  return Membership.create({ business: businessId, user: userId, role, status });
}

export interface OwnerBusiness {
  owner: Awaited<ReturnType<typeof createUser>>;
  business: BusinessDoc;
  membership: MembershipDoc;
}

/** Creates an owner user, a business, and the owner's active membership. */
export async function createBusinessWithOwner(
  options: BusinessOptions = {},
): Promise<OwnerBusiness> {
  const owner = await createUser();
  const business = await createBusiness(owner._id, options);
  const membership = await createMembership(business._id, owner._id, "owner");
  return { owner, business, membership };
}

export interface SubscriptionOptions {
  status?: SubscriptionStatus;
  provider?: string;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}

export async function createSubscription(
  businessId: Types.ObjectId,
  planId: Types.ObjectId,
  options: SubscriptionOptions = {},
): Promise<SubscriptionDoc> {
  return Subscription.create({
    business: businessId,
    plan: planId,
    status: options.status ?? "active",
    provider: options.provider ?? "manual",
    currentPeriodStart:
      options.currentPeriodStart === undefined ? new Date() : options.currentPeriodStart,
    currentPeriodEnd:
      options.currentPeriodEnd === undefined ? null : options.currentPeriodEnd,
  });
}

/**
 * Gives a storefront business an active free-plan subscription so it passes
 * the public commerce gate (`resolveCommerceBusiness`): published + entitled.
 */
export async function grantActiveFreePlan(
  businessId: Types.ObjectId,
): Promise<SubscriptionDoc> {
  const plan = await createPlan({ price: 0 });
  return createSubscription(businessId, plan._id, {
    status: "active",
    currentPeriodEnd: null,
  });
}
