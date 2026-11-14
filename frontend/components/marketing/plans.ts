import { dbConnect } from "@/lib/db";
import { DEFAULT_AI_REQUESTS_PER_MONTH } from "@/lib/billing";
import { cheapestPlanFor, planThemes } from "@/lib/theme-tiers";
import type { ThemeId } from "@/lib/constants";
import { Plan } from "@/models/Plan";

export interface PublicPlan {
  key: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  interval: string;
  productLimit: number;
  staffLimit: number;
  customDomain: boolean;
  removeBranding: boolean;
  aiRequestsPerMonth: number;
  themes: ThemeId[];
}

/** The active plans as configured in the plan manager: public pages never hard-code limits or prices. */
export async function loadPublicPlans(): Promise<PublicPlan[]> {
  try {
    await dbConnect();
    const plans = await Plan.find({ active: true }).sort({ sort: 1 }).lean();
    return plans.map((plan) => ({
      key: plan.key,
      name: plan.name,
      description: plan.description,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      productLimit: plan.features.productLimit,
      staffLimit: plan.features.staffLimit,
      customDomain: plan.features.customDomain,
      removeBranding: plan.features.removeBranding,
      aiRequestsPerMonth: plan.features.aiRequestsPerMonth ?? DEFAULT_AI_REQUESTS_PER_MONTH,
      themes: planThemes(plan),
    }));
  } catch {
    return [];
  }
}

/** The name of the cheapest plan including each theme (null: no plans configured). */
export function themePlanNames(plans: PublicPlan[]): Record<string, { name: string; free: boolean } | null> {
  const cheapest = cheapestPlanFor(plans);
  return Object.fromEntries(Object.entries(cheapest).map(([id, plan]) => [id, plan ? { name: plan.name, free: plan.price === 0 } : null]));
}
