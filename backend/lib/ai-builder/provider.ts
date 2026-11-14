import { HttpError } from "@/lib/api";
import { isAiProviderEnabled } from "@/lib/env";
import { parseProviderJson, type GeminiUsage } from "@/lib/ai-planning/gemini-http";
import { executeAiTask } from "@/lib/ai-providers/execute";
import { configuredAiProviders } from "@/lib/ai-providers/registry";
import { resolveAiRoutes } from "@/lib/ai-providers/routing";
import { getAiRoutingSettings, type AiRouteTask } from "@/lib/ai-providers/settings";
import type { AiTask } from "./usage";

/**
 * The AI builder's door to the provider layer (lib/ai-providers). Paused by default: nothing is
 * sent unless AI_PROVIDER_ENABLED is exactly "true" AND a provider named in the consent disclosure
 * has its credentials and a valid model (a key alone never enables it). Even then, each business's
 * owner must consent first (./consent.ts), and every call goes through ./request.ts (consent, data
 * check, allowance, outcome).
 */

export interface AiBuilderStatus {
  /** The platform kill switch is off (AI_PROVIDER_ENABLED === "true"). */
  enabled: boolean;
  /** A provider credential and a valid model name are configured. */
  configured: boolean;
  /** Both: requests can actually be made. */
  available: boolean;
}

/**
 * The server environment alone: what can be decided without reading anything. Whether a request can
 * actually run also depends on the saved routing, so anything shown to a person uses
 * `aiPlatformStatus`, or `aiReadiness` (./consent.ts) when it concerns one store.
 */
export function aiBuilderStatus(): AiBuilderStatus {
  const enabled = isAiProviderEnabled();
  const configured = configuredAiProviders().length > 0;
  return { enabled, configured, available: enabled && configured };
}

/** Fixed message when AI is off (checked before any rate limit, quota or data access). */
export function assertAiAvailable(): void {
  if (!isAiProviderEnabled()) {
    throw new HttpError(503, "AI suggestions are turned off on this platform. You can still make every change yourself.", "provider_not_configured");
  }
  if (configuredAiProviders().length === 0) throw new HttpError(503, "AI suggestions are not configured on this platform.", "provider_not_configured");
}

/** Which route handles each kind of request (lib/ai-providers/routing.ts). */
const AI_TASK_ROUTES: Record<AiTask, AiRouteTask> = {
  storefront: "homepage_editing",
  page: "page_editing",
  product: "rewriting",
  planning: "planning",
  seo: "seo",
  theme: "theme_advice",
  discovery: "discovery",
  website: "generation",
  revision: "website_revision",
};

/** What every AI builder request asks of a model. */
const REQUEST_NEEDS = ["structured_json", "system_instructions"] as const;

export interface AiPlatformStatus extends AiBuilderStatus {
  /** Each kind of request has a provider and model that can handle it. */
  tasks: Record<AiTask, boolean>;
}

/** Whether the platform can serve AI right now: the environment, the saved routing and what each model can do. */
export async function aiPlatformStatus(): Promise<AiPlatformStatus> {
  const status = aiBuilderStatus();
  const settings = status.available ? await getAiRoutingSettings() : null;
  const tasks = Object.fromEntries(
    (Object.keys(AI_TASK_ROUTES) as AiTask[]).map((task) => [task, settings ? resolveAiRoutes(AI_TASK_ROUTES[task], REQUEST_NEEDS, settings).length > 0 : false]),
  ) as Record<AiTask, boolean>;
  return { ...status, available: Object.values(tasks).some(Boolean), tasks };
}

/** Refuses a request no provider can handle, before any rate limit or store data is touched. Never says why: that is the platform's business. */
export async function assertAiTaskAvailable(task: AiTask): Promise<void> {
  if (resolveAiRoutes(AI_TASK_ROUTES[task], REQUEST_NEEDS, await getAiRoutingSettings()).length === 0) {
    throw new HttpError(503, "AI suggestions are not available right now. You can still make every change yourself.", "provider_not_configured");
  }
}

/**
 * Sends one structured-output request. `value` is the parsed JSON (still
 * untrusted: callers validate it with their own schema) or undefined when the
 * output was not JSON; usage is returned either way so it can be recorded.
 * The prompt must keep owner text and store data in delimited blocks
 * (lib/ai-builder/prompts.ts).
 */
export async function generateStructured(
  task: AiTask,
  request: { system: string; prompt: string; maxOutputTokens: number; subject?: string; advice?: string },
): Promise<{ value: unknown; usage: GeminiUsage; model: string; providerId: string; fallbacks: number }> {
  assertAiAvailable();
  const result = await executeAiTask({
    task: AI_TASK_ROUTES[task],
    operation: "structured",
    system: request.system,
    prompt: request.prompt,
    maxOutputTokens: request.maxOutputTokens,
    logTag: "ai-builder",
    subject: request.subject ?? "AI suggestions",
    advice: request.advice ?? "You can still make this change yourself.",
  });
  const value = parseProviderJson(result.text);
  if (value === undefined) console.error(`[ai-builder] response not parseable task=${task} chars=${result.text.length}`);
  return { value, usage: result.usage, model: result.model, providerId: result.providerId, fallbacks: result.fallbacks };
}

export const unreadableSuggestion = () => new HttpError(422, "The AI suggestion could not be read. Please try again.", "invalid_response");
