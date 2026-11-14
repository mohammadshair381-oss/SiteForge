import { dbConnect } from "@/lib/db";
import { getEntitlements } from "@/lib/billing";
import { parseRouteUsageKey, usagePeriod } from "@/lib/ai-builder/usage";
import { AiUsage, type AiUsageDoc } from "@/models/AiUsage";
import { Business } from "@/models/Business";

/**
 * Super Admin AI usage (read-only; pages authorize with
 * `requireSuperAdminPage`). Only stored counters from `AiUsage`: never
 * prompts, generated text, keys or store content, and no estimated costs.
 * Token totals are exactly what the provider reported, with how many responses
 * reported them, so missing counts stay visible. Allowances come from the
 * central entitlements (configured in the plan manager).
 */

export const APPROACHING_LIMIT_SHARE = 0.8;
/** Businesses read per month (highest usage first). */
export const AI_USAGE_ROW_LIMIT = 200;

export interface AiUsageTotals {
  requests: number;
  successes: number;
  failures: number;
  rejected: number;
}

export interface AiUsageRow extends AiUsageTotals {
  businessId: string;
  name: string;
  subdomain: string;
  planName: string;
  limit: number;
  remaining: number;
  /** Share of the allowance used (0-1); null when the plan includes no AI. */
  share: number | null;
  tasks: Record<string, number>;
}

export interface AiUsageOverview {
  period: string;
  totals: AiUsageTotals & { businesses: number; promptTokens: number; outputTokens: number; totalTokens: number; tokenReports: number };
  byPlan: Array<AiUsageTotals & { planName: string; businesses: number; limitTotal: number; remainingTotal: number }>;
  byTask: Array<{ task: string; requests: number }>;
  /** Per provider and model. Requests from before these were recorded are not in here. */
  byRoute: Array<AiUsageTotals & { providerId: string; model: string }>;
  /** Requests answered only after trying another route first. */
  fallbacks: number;
  rows: AiUsageRow[];
  approaching: AiUsageRow[];
  /** More businesses used AI this month than `rows` holds. */
  truncated: boolean;
  months: Array<AiUsageTotals & { period: string; businesses: number }>;
}

export function isValidUsagePeriod(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The last `count` calendar months, newest first ("YYYY-MM", UTC). */
export function recentPeriods(count: number, now = new Date()): string[] {
  return Array.from({ length: count }, (_, i) => usagePeriod(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
}

const add = (into: AiUsageTotals, doc: Pick<AiUsageDoc, "requests" | "successes" | "failures" | "rejected">) => {
  into.requests += doc.requests ?? 0;
  into.successes += doc.successes ?? 0;
  into.failures += doc.failures ?? 0;
  into.rejected += doc.rejected ?? 0;
};

export async function getAiUsageOverview(period: string, now = new Date()): Promise<AiUsageOverview> {
  await dbConnect();
  const docs = await AiUsage.find({ period }).sort({ requests: -1 }).lean<AiUsageDoc[]>();
  const totals = { requests: 0, successes: 0, failures: 0, rejected: 0, businesses: docs.length, promptTokens: 0, outputTokens: 0, totalTokens: 0, tokenReports: 0 };
  const tasks = new Map<string, number>();
  const routes = new Map<string, AiUsageOverview["byRoute"][number]>();
  let fallbacks = 0;
  for (const doc of docs) {
    fallbacks += doc.fallbacks ?? 0;
    for (const [key, counts] of Object.entries(doc.routes ?? {})) {
      const route = routes.get(key) ?? { ...parseRouteUsageKey(key), requests: 0, successes: 0, failures: 0, rejected: 0 };
      route.requests += counts.requests ?? 0;
      route.successes += counts.successes ?? 0;
      route.failures += counts.failures ?? 0;
      route.rejected += counts.rejected ?? 0;
      routes.set(key, route);
    }
    add(totals, doc);
    totals.promptTokens += doc.promptTokens ?? 0;
    totals.outputTokens += doc.outputTokens ?? 0;
    totals.totalTokens += doc.totalTokens ?? 0;
    totals.tokenReports += doc.tokenReports ?? 0;
    for (const [task, count] of Object.entries(doc.tasks ?? {})) tasks.set(task, (tasks.get(task) ?? 0) + (Number(count) || 0));
  }

  const top = docs.slice(0, AI_USAGE_ROW_LIMIT);
  const businesses = await Business.find({ _id: { $in: top.map((d) => d.business) } }).select("name subdomain").lean<Array<{ _id: unknown; name: string; subdomain: string }>>();
  const byId = new Map(businesses.map((b) => [String(b._id), b]));
  const rows: AiUsageRow[] = await Promise.all(
    top.map(async (doc) => {
      const businessId = String(doc.business);
      const entitlements = await getEntitlements(businessId);
      const limit = entitlements.aiRequestsPerMonth;
      return {
        businessId,
        name: byId.get(businessId)?.name ?? "(deleted business)",
        subdomain: byId.get(businessId)?.subdomain ?? "",
        planName: entitlements.planName,
        requests: doc.requests ?? 0,
        successes: doc.successes ?? 0,
        failures: doc.failures ?? 0,
        rejected: doc.rejected ?? 0,
        limit,
        remaining: Math.max(0, limit - (doc.requests ?? 0)),
        share: limit > 0 ? (doc.requests ?? 0) / limit : null,
        tasks: doc.tasks ?? {},
      };
    }),
  );

  const plans = new Map<string, AiUsageOverview["byPlan"][number]>();
  for (const row of rows) {
    const plan = plans.get(row.planName) ?? { planName: row.planName, businesses: 0, requests: 0, successes: 0, failures: 0, rejected: 0, limitTotal: 0, remainingTotal: 0 };
    plan.businesses += 1;
    add(plan, row);
    plan.limitTotal += row.limit;
    plan.remainingTotal += row.remaining;
    plans.set(row.planName, plan);
  }

  const periods = recentPeriods(6, now);
  const history = await AiUsage.find({ period: { $in: periods } }).select("period requests successes failures rejected").lean<Array<Pick<AiUsageDoc, "period" | "requests" | "successes" | "failures" | "rejected">>>();
  const months = periods.map((month) => {
    const entry = { period: month, businesses: 0, requests: 0, successes: 0, failures: 0, rejected: 0 };
    for (const doc of history) {
      if (doc.period === month) {
        entry.businesses += 1;
        add(entry, doc);
      }
    }
    return entry;
  });

  return {
    period,
    totals,
    byPlan: [...plans.values()].sort((a, b) => b.requests - a.requests),
    byTask: [...tasks.entries()].map(([task, requests]) => ({ task, requests })).sort((a, b) => b.requests - a.requests),
    byRoute: [...routes.values()].sort((a, b) => b.requests - a.requests),
    fallbacks,
    rows,
    approaching: rows.filter((row) => row.share !== null && row.share >= APPROACHING_LIMIT_SHARE).sort((a, b) => (b.share ?? 0) - (a.share ?? 0)),
    truncated: docs.length > top.length,
    months,
  };
}
