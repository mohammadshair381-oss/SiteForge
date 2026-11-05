/**
 * What a plan allows, in words and numbers (pure, and safe for client components). `null`
 * means the plan sets no limit. Enforcement lives on the server: lib/billing.ts and
 * lib/usage-limits.ts. Going over a limit after a downgrade never removes anything: it
 * only stops new things being added.
 */
export type UsageKey = "products" | "pages" | "teamMembers" | "storage" | "customDomains" | "monthlyOrders" | "themes" | "aiRequests";

export interface UsageLine {
  key: UsageKey;
  label: string;
  used: number;
  /** null = no limit on this plan. */
  limit: number | null;
  unit: "count" | "bytes";
  /** What reaching the limit stops, in the owner's terms. */
  atLimit: string;
  hint?: string;
}

export interface PlanLimitValues {
  productLimit: number;
  staffLimit: number;
  customDomain: boolean;
  pageLimit?: number | null;
  storageMb?: number | null;
  monthlyOrderLimit?: number | null;
  aiRequestsPerMonth?: number;
  themeCount?: number;
}

export const MB = 1024 * 1024;

export function formatUsageValue(value: number, unit: UsageLine["unit"]): string {
  if (unit === "count") return String(value);
  if (value >= 1024 * MB) return `${(value / (1024 * MB)).toFixed(1)} GB`;
  if (value >= MB) return `${(value / MB).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

export const isOverLimit = (line: Pick<UsageLine, "used" | "limit">) => line.limit !== null && line.used > line.limit;
export const isAtLimit = (line: Pick<UsageLine, "used" | "limit">) => line.limit !== null && line.used >= line.limit;

export interface PlanChangeImpact {
  label: string;
  used: string;
  allowed: string;
}

/** What is already over a plan's limits, for a clear warning before moving to it. */
export function planChangeImpact(lines: readonly UsageLine[], plan: PlanLimitValues): PlanChangeImpact[] {
  const allowedFor = (key: UsageKey): number | null | undefined => {
    switch (key) {
      case "products":
        return plan.productLimit;
      case "teamMembers":
        return plan.staffLimit;
      case "pages":
        return plan.pageLimit ?? null;
      case "storage":
        return typeof plan.storageMb === "number" ? plan.storageMb * MB : null;
      case "customDomains":
        return plan.customDomain ? null : 0;
      default:
        // Monthly orders and AI restart each month, and a store always keeps its current theme.
        return undefined;
    }
  };
  const impact: PlanChangeImpact[] = [];
  for (const line of lines) {
    const allowed = allowedFor(line.key);
    if (allowed === undefined || allowed === null || line.used <= allowed) continue;
    impact.push({ label: line.label, used: formatUsageValue(line.used, line.unit), allowed: formatUsageValue(allowed, line.unit) });
  }
  return impact;
}

/** What stops, and what keeps working, while a store has no active plan. */
export const INACTIVE_PLAN_EFFECTS = {
  stops: ["Your store is offline to shoppers", "New orders", "Publishing", "Adding products and team members", "Custom domains", "AI suggestions", "Switching to a theme your plan does not include"],
  keeps: ["Your products, pages, orders and customers are kept", "You can still sign in, edit and view everything", "Everything comes back when a plan is active again"],
} as const;
