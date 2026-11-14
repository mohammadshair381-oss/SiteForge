import type { ClientSession } from "mongoose";
import { dbConnect } from "./db";
import { HttpError } from "./api";
import { env } from "./env";
import { Subscription, type SubscriptionDoc } from "@/models/Subscription";
import { Product } from "@/models/Product";
import { Membership } from "@/models/Membership";
import { Plan, type PlanDoc } from "@/models/Plan";
import type { SubscriptionStatus, ThemeId } from "./constants";
import { FREE_THEMES, cheapestPlanFor, planThemes, type ThemeAccess } from "./theme-tiers";
import { getThemeMeta } from "./themes";
import { Business } from "@/models/Business";

/**
 * Whether server-authoritative manual plan activation is permitted.
 *
 * - Outside production: always allowed, so local sandbox flows keep working.
 * - In production: allowed only when ALLOW_MANUAL_BILLING=true. Otherwise
 *   billing fails closed, because activating paid plans manually would grant
 *   paid subscriptions for free.
 */
export function isManualBillingAllowed(): boolean {
  const config = env();
  if (config.NODE_ENV !== "production") return true;
  return config.ALLOW_MANUAL_BILLING;
}

export interface Entitlements {
  planKey: string | null;
  planName: string;
  status: SubscriptionStatus;
  active: boolean;
  /** A failed renewal is being retried, and access continues until this time. */
  graceUntil?: Date | null;
  /**
   * Derived, display-only flag: the stored status is still active/trialing but
   * a paid plan's `currentPeriodEnd` has passed, so the subscription no longer
   * grants access. Only distinguishes the expired case; past_due, canceled and
   * other statuses keep their own `status` value.
   */
  expired: boolean;
  productLimit: number;
  staffLimit: number;
  customDomain: boolean;
  removeBranding: boolean;
  /** AI suggestions per calendar month (0 without an active plan). */
  aiRequestsPerMonth: number;
  /**
   * Storefront themes the business may switch to (lib/theme-tiers.ts). Without
   * an active plan: the Free tier. The current theme always stays usable
   * (see `assertCanUseTheme`).
   */
  themes: ThemeId[];
  /** Pages besides the homepage, media storage and monthly orders. null = no limit (lib/usage-limits.ts). */
  pageLimit: number | null;
  storageBytes: number | null;
  monthlyOrderLimit: number | null;
}

/**
 * What a member who is not the owner may be told: the plan, its limits and whether it is in force, which
 * they need to know what the store can do. Why a plan lapsed, or that a payment failed, is billing state.
 */
export type MemberEntitlements = Omit<Entitlements, "status" | "graceUntil" | "expired">;

/** Billing is owner-only. Call this wherever entitlements leave the server for a member's role. */
export function entitlementsForRole(entitlements: Entitlements, role: string): Entitlements | MemberEntitlements {
  if (role === "owner") return entitlements;
  const { status: _status, graceUntil: _graceUntil, expired: _expired, ...rest } = entitlements;
  return rest;
}

/**
 * AI requests per business per month for plans that do not set
 * `features.aiRequestsPerMonth` (owner-approved initial allowance; set per
 * plan in the Super Admin plan manager). AI itself also needs the platform
 * kill switch and each owner's consent (docs/ai-website-builder-plan.md).
 */
export const DEFAULT_AI_REQUESTS_PER_MONTH = 30;

export const NO_PLAN_ENTITLEMENTS: Entitlements = {
  planKey: null,
  planName: "No plan",
  status: "incomplete",
  active: false,
  expired: false,
  productLimit: 0,
  staffLimit: 1,
  customDomain: false,
  removeBranding: false,
  aiRequestsPerMonth: 0,
  themes: [...FREE_THEMES],
  pageLimit: null,
  storageBytes: null,
  monthlyOrderLimit: null,
};

const PROVIDER_RENEWAL_MARGIN_MS = 24 * 60 * 60 * 1000;

function isActiveStatus(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing";
}

/**
 * Centralized effective-active evaluation for a subscription.
 *
 * A paid subscription in an active/trialing status only grants entitlements
 * while its `currentPeriodEnd` is null (non-expiring) or strictly in the
 * future. Free plans (price === 0) keep their access regardless of
 * `currentPeriodEnd`, so the baseline subscription created at business signup
 * never silently expires. Non-active statuses remain inactive.
 *
 * When the plan price is unknown the subscription is treated as paid
 * (conservatively), which can only narrow access, never widen it.
 *
 * This is a pure, read-only check: it never mutates the subscription document.
 */
export function isEntitlingSubscription(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null | undefined,
  planPrice: number | null | undefined,
  now: Date,
  billing: { provider?: string | null; graceUntil?: Date | null } = {},
): boolean {
  // A failed renewal is being retried: access continues for the grace period.
  if (status === "past_due") return Boolean(billing.graceUntil && billing.graceUntil.getTime() > now.getTime());
  if (!isActiveStatus(status)) return false;
  // A provider charges at the period end and reports it shortly after, so a store
  // does not lose access in that gap; a failed charge moves it to past_due.
  if (billing.provider === "razorpay" && currentPeriodEnd) {
    return currentPeriodEnd.getTime() + PROVIDER_RENEWAL_MARGIN_MS > now.getTime();
  }
  if (planPrice === 0) return true;
  if (!currentPeriodEnd) return true;
  return currentPeriodEnd.getTime() > now.getTime();
}

/**
 * Whether an active/trialing paid subscription has passed its period end.
 *
 * Free plans are never reported as expired (they keep access), and a null
 * period end is non-expiring, so both return false. This is a pure, read-only
 * check used only to distinguish the display of an expired subscription.
 */
export function isExpiredPaidSubscription(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null | undefined,
  planPrice: number | null | undefined,
  now: Date,
): boolean {
  return (
    isActiveStatus(status) &&
    planPrice !== 0 &&
    currentPeriodEnd != null &&
    currentPeriodEnd.getTime() <= now.getTime()
  );
}

export async function getEntitlements(businessId: string): Promise<Entitlements> {
  await dbConnect();
  const subscription = await Subscription.findOne({ business: businessId })
    .sort({ createdAt: -1 })
    .populate<{ plan: PlanDoc }>({ path: "plan", model: Plan });

  if (!subscription || !subscription.plan) {
    return { ...NO_PLAN_ENTITLEMENTS, status: subscription?.status ?? "incomplete" };
  }

  const plan = subscription.plan;
  const now = new Date();
  const active = isEntitlingSubscription(subscription.status, subscription.currentPeriodEnd, plan.price, now, subscription);
  return {
    planKey: plan.key,
    planName: plan.name,
    status: subscription.status,
    active,
    graceUntil: subscription.status === "past_due" && active ? subscription.graceUntil ?? null : null,
    expired: isExpiredPaidSubscription(
      subscription.status,
      subscription.currentPeriodEnd,
      plan.price,
      now,
    ),
    productLimit: plan.features.productLimit,
    staffLimit: plan.features.staffLimit,
    customDomain: plan.features.customDomain,
    removeBranding: plan.features.removeBranding,
    // AI usage needs an entitling subscription, like publishing.
    aiRequestsPerMonth: active ? (typeof plan.features.aiRequestsPerMonth === "number" ? plan.features.aiRequestsPerMonth : DEFAULT_AI_REQUESTS_PER_MONTH) : 0,
    // Like every paid feature, themes need an entitling subscription.
    themes: active ? planThemes(plan) : [...FREE_THEMES],
    pageLimit: typeof plan.features.pageLimit === "number" ? plan.features.pageLimit : null,
    storageBytes: typeof plan.features.storageMb === "number" ? plan.features.storageMb * 1024 * 1024 : null,
    monthlyOrderLimit: typeof plan.features.monthlyOrderLimit === "number" ? plan.features.monthlyOrderLimit : null,
  };
}

/** Active plans with the themes each includes (upgrade information). */
async function activePlanTiers() {
  await dbConnect();
  const plans = await Plan.find({ active: true }).select("key name price currency interval features").lean<PlanDoc[]>();
  return plans.map((plan) => ({
    key: plan.key,
    name: plan.name,
    price: plan.price,
    currency: plan.currency,
    interval: plan.interval,
    themes: planThemes(plan),
  }));
}

/**
 * What the business may do with each theme, for every theme picker (theme
 * gallery, website editor, setup wizard). The server enforces the same rule
 * in `assertCanUseTheme`.
 */
export async function getThemeAccess(businessId: string): Promise<ThemeAccess> {
  const [entitlements, business, tiers] = await Promise.all([
    getEntitlements(businessId),
    Business.findById(businessId).select("themeId").lean<{ themeId: ThemeId }>(),
    activePlanTiers(),
  ]);
  const current = (business?.themeId ?? FREE_THEMES[0]) as ThemeId;
  const cheapest = cheapestPlanFor(tiers);
  return {
    current,
    allowed: entitlements.themes,
    planName: entitlements.planName,
    requiredPlan: Object.fromEntries(
      Object.entries(cheapest).map(([id, plan]) => [id, plan ? { key: plan.key, name: plan.name } : null]),
    ) as ThemeAccess["requiredPlan"],
    grandfathered: !entitlements.themes.includes(current),
  };
}

/**
 * Server-side theme permission (every route that writes `themeId` calls it).
 * Keeping the CURRENT theme is always allowed, so a downgraded or expired
 * plan never changes a live store; switching to another theme needs a plan
 * that includes it.
 */
export async function assertCanUseTheme(businessId: string, themeId: ThemeId, currentThemeId: string | null | undefined): Promise<void> {
  if (themeId === currentThemeId) return;
  const entitlements = await getEntitlements(businessId);
  if (entitlements.themes.includes(themeId)) return;
  const tiers = await activePlanTiers();
  const required = cheapestPlanFor(tiers)[themeId];
  const name = getThemeMeta(themeId).name;
  throw new HttpError(
    402,
    required
      ? `The ${name} theme is available on the ${required.name} plan. Upgrade to use it.`
      : `The ${name} theme is not available on your plan.`,
    "theme_not_in_plan",
  );
}

export async function getActiveSubscription(
  businessId: string,
): Promise<SubscriptionDoc | null> {
  await dbConnect();
  const subscription = await Subscription.findOne({ business: businessId })
    .sort({ createdAt: -1 })
    .lean<SubscriptionDoc>();
  if (!subscription) return null;
  if (!isActiveStatus(subscription.status) && subscription.status !== "past_due") return null;

  // `plan` is an unpopulated reference here, so resolve its price explicitly to
  // decide whether the period-end expiry applies (free plans are exempt).
  const plan = await Plan.findById(subscription.plan).lean<PlanDoc>();
  const entitled = isEntitlingSubscription(
    subscription.status,
    subscription.currentPeriodEnd,
    plan?.price,
    new Date(),
    subscription,
  );
  return entitled ? subscription : null;
}

/**
 * Makes limit checks safe when requests arrive together. Called inside a transaction, before
 * counting: two transactions that both reach this conflict on the store's document, MongoDB
 * retries the later one (`withTransaction`), and its count then includes what the earlier one
 * added. It uses no index, and a transaction that is refused rolls it back with everything else.
 */
export async function takeUsageTurn(businessId: string, session: ClientSession): Promise<void> {
  const turn = await Business.updateOne({ _id: businessId }, { $inc: { usageTurn: 1 } }, { session, timestamps: false });
  if (turn.matchedCount !== 1) throw new HttpError(404, "Business not found", "not_found");
}

export const countBillableProducts = (businessId: string, session?: ClientSession) =>
  Product.countDocuments({ business: businessId, status: { $ne: "archived" } }).session(session ?? null);

/** With a session, it takes the store's turn first, so requests at the same moment cannot both pass. */
export async function assertCanAddProduct(businessId: string, session?: ClientSession): Promise<void> {
  const entitlements = await getEntitlements(businessId);
  if (!entitlements.active) {
    throw new HttpError(
      402,
      "An active subscription is required to add products",
      "payment_required",
    );
  }
  if (session) await takeUsageTurn(businessId, session);
  const count = await countBillableProducts(businessId, session);
  if (count >= entitlements.productLimit) {
    throw new HttpError(
      402,
      `Your ${entitlements.planName} plan allows up to ${entitlements.productLimit} products. Upgrade to add more.`,
      "limit_reached",
    );
  }
}

export async function assertCanPublish(businessId: string): Promise<void> {
  const entitlements = await getEntitlements(businessId);
  if (!entitlements.active) {
    throw new HttpError(
      402,
      "An active subscription is required to publish your website",
      "payment_required",
    );
  }
}

/** With a session, it takes the store's turn first, as `assertCanAddProduct` does. */
export async function assertCanAddStaff(businessId: string, session?: ClientSession): Promise<void> {
  const entitlements = await getEntitlements(businessId);
  if (!entitlements.active) {
    throw new HttpError(
      402,
      "An active subscription is required to add staff members",
      "payment_required",
    );
  }
  if (session) await takeUsageTurn(businessId, session);
  const count = await Membership.countDocuments({ business: businessId }).session(session ?? null);
  if (count >= entitlements.staffLimit + 1) {
    throw new HttpError(
      402,
      `Your ${entitlements.planName} plan allows up to ${entitlements.staffLimit} staff member(s).`,
      "limit_reached",
    );
  }
}

/**
 * Ensures a business's active subscription entitlement includes the custom
 * domain feature. Rechecked on every domain assignment or verification
 * operation so an expired or downgraded plan can never grant a domain.
 */
export async function assertCanAddCustomDomain(businessId: string): Promise<void> {
  const entitlements = await getEntitlements(businessId);
  if (!entitlements.active) {
    throw new HttpError(
      402,
      "An active subscription is required to use a custom domain",
      "payment_required",
    );
  }
  if (!entitlements.customDomain) {
    throw new HttpError(
      402,
      "Your plan does not include custom domains. Upgrade to add one.",
      "limit_reached",
    );
  }
}
