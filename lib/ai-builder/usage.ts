import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { HttpError } from "@/lib/api";
import type { GeminiUsage } from "@/lib/ai-planning/gemini-http";
import { AiUsage, type AiUsageDoc } from "@/models/AiUsage";

/**
 * AI usage per business and calendar month, enforced on the server before
 * any provider call. Only counters are stored (models/AiUsage.ts).
 */

export const AI_TASKS = ["storefront", "product", "planning", "page", "seo", "theme", "discovery", "website", "revision"] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** "YYYY-MM" in UTC. */
export function usagePeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function usageId(businessId: string, period: string): string {
  return `${businessId.toLowerCase()}:${period}`;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === 11000;
}

const quotaExceeded = (limit: number) =>
  new HttpError(429, `You have used all ${limit} AI suggestions included in your plan this month. They renew on the 1st.`, "ai_quota_exceeded");

/**
 * Reserves one request in this month's allowance, atomically: the counter only
 * moves while it is below `limit`, so concurrent requests can never exceed it.
 * Throws 402 when the plan includes no AI suggestions, 429 when used up.
 * Returns the period to record the outcome against.
 */
export async function reserveAiRequest(businessId: string, task: AiTask, limit: number, now = new Date()): Promise<string> {
  if (limit <= 0) {
    throw new HttpError(402, "AI suggestions need an active plan that includes them.", "ai_not_in_plan");
  }
  await dbConnect();
  const period = usagePeriod(now);
  const _id = usageId(businessId, period);
  const update = { $inc: { requests: 1, [`tasks.${task}`]: 1 } };
  try {
    // Matches the month's document while under the limit; inserts it the first time.
    await AiUsage.updateOne(
      { _id, requests: { $lt: limit } },
      { ...update, $setOnInsert: { business: new mongoose.Types.ObjectId(businessId), period } },
      { upsert: true },
    );
    return period;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
  // The document exists: either the allowance is used up, or another first
  // request inserted it concurrently. One plain conditional update decides.
  const retried = await AiUsage.updateOne({ _id, requests: { $lt: limit } }, update);
  if (retried.modifiedCount === 1) return period;
  throw quotaExceeded(limit);
}

export type AiOutcome = "success" | "failed" | "rejected" | "not_sent";

/** A key for one provider and model in `AiUsage.routes`. A dot would split the stored path. */
export function routeUsageKey(providerId: string, model: string): string {
  return `${providerId}:${model}`.replace(/\./g, "%2E");
}

export function parseRouteUsageKey(key: string): { providerId: string; model: string } {
  const [providerId, ...model] = key.replace(/%2E/g, ".").split(":");
  return { providerId, model: model.join(":") };
}

/**
 * Records how a reserved request ended (token counts only as the provider
 * reported them). "not_sent" refunds the reservation: a request refused
 * before reaching the provider is never charged.
 */
export async function recordAiOutcome(
  businessId: string,
  period: string,
  outcome: {
    result: AiOutcome;
    task?: AiTask;
    usage?: GeminiUsage | null;
    model?: string | null;
    /** Which provider and model handled it. Names only. */
    route?: { providerId: string; model: string } | null;
    /** Other routes tried before this one. */
    fallbacks?: number;
    /** No answer was accepted, and this kind of request is charged only for accepted answers. */
    refund?: boolean;
  },
): Promise<void> {
  const ok = outcome.result === "success";
  const inc: Record<string, number> =
    outcome.result === "success"
      ? { successes: 1 }
      : outcome.result === "rejected"
        ? { rejected: 1 }
        : outcome.result === "failed"
          ? { failures: 1 }
          : { requests: -1, ...(outcome.task ? { [`tasks.${outcome.task}`]: -1 } : {}) };
  if (outcome.refund && outcome.result !== "success" && outcome.result !== "not_sent") {
    inc.requests = -1;
    if (outcome.task) inc[`tasks.${outcome.task}`] = -1;
  }
  if (outcome.route && outcome.route.providerId && outcome.route.model && outcome.result !== "not_sent") {
    const key = `routes.${routeUsageKey(outcome.route.providerId, outcome.route.model)}`;
    inc[`${key}.requests`] = 1;
    inc[`${key}.${outcome.result === "success" ? "successes" : outcome.result === "rejected" ? "rejected" : "failures"}`] = 1;
  }
  if (outcome.fallbacks) inc.fallbacks = outcome.fallbacks;
  const usage = outcome.usage;
  if (usage && (usage.promptTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null)) {
    inc.tokenReports = 1;
    if (usage.promptTokens !== null) inc.promptTokens = usage.promptTokens;
    if (usage.outputTokens !== null) inc.outputTokens = usage.outputTokens;
    if (usage.totalTokens !== null) inc.totalTokens = usage.totalTokens;
  }
  try {
    await AiUsage.updateOne({ _id: usageId(businessId, period) }, { $inc: inc, ...(ok && outcome.model ? { $set: { model: outcome.model, ...(outcome.route?.providerId ? { provider: outcome.route.providerId } : {}) } } : {}) });
  } catch {
    // Usage records are best-effort after the request: never change the response.
    console.error("[ai-builder] usage outcome not recorded");
  }
}

export interface AiUsageSummary {
  period: string;
  used: number;
  limit: number;
  remaining: number;
}

export async function getAiUsageSummary(businessId: string, limit: number, now = new Date()): Promise<AiUsageSummary> {
  await dbConnect();
  const period = usagePeriod(now);
  const doc = await AiUsage.findById(usageId(businessId, period)).select("requests").lean<Pick<AiUsageDoc, "requests">>();
  const used = doc?.requests ?? 0;
  return { period, used, limit, remaining: Math.max(0, limit - used) };
}
