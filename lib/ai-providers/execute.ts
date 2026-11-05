import { aiProviderTimeoutMs } from "@/lib/env";
import { assertProviderPayloadSafe } from "@/lib/ai-builder/sanitize";
import { AiProviderError, canFallBack, retriesSameRoute } from "./errors";
import { resolveAiRoutes } from "./routing";
import { getAiRoutingSettings, type AiRouteTask, type AiRoutingSettings } from "./settings";
import type { AiCapability, AiGeneration, AiMessage } from "./types";

/**
 * The one way application code calls an AI provider (server-only). It chooses the route, makes the
 * attempts and returns a normalized answer. Consent, the monthly allowance and validating the answer
 * belong to `runAiRequest` (lib/ai-builder/request.ts), which calls this once per request: however
 * many attempts happen here, one request is charged and one answer is accepted.
 *
 * Nothing is stored until an answer is accepted, so an attempt that fails leaves nothing behind.
 */
export type AiOperation = "text" | "structured" | "conversation";

const OPERATION_NEEDS: Record<AiOperation, AiCapability> = { text: "text", structured: "structured_json", conversation: "conversation" };
const RETRY_DELAY_MS = 500;
/** Every attempt together stays within this, so a request cannot run on indefinitely. */
const MAX_TOTAL_MS = 120_000;

export interface AiTaskRequest {
  task: AiRouteTask;
  operation: AiOperation;
  system?: string;
  prompt: string;
  history?: readonly AiMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  logTag: string;
  subject: string;
  advice: string;
  /** Skips reading the stored settings. Default: read them. */
  routing?: AiRoutingSettings;
}

export interface AiExecution extends AiGeneration {
  /** How many other routes were tried before the one that answered. */
  fallbacks: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeAiTask(request: AiTaskRequest): Promise<AiExecution> {
  assertProviderPayloadSafe(request.system ?? "", request.prompt, ...(request.history ?? []).map((message) => message.text));

  const settings = request.routing ?? (await getAiRoutingSettings());
  const needs: AiCapability[] = [OPERATION_NEEDS[request.operation], ...(request.system ? (["system_instructions"] as const) : [])];
  const routes = resolveAiRoutes(request.task, needs, settings);
  if (routes.length === 0) {
    throw new AiProviderError({
      status: 503,
      message: `${request.subject} is not available right now. ${request.advice}`,
      code: "provider_not_configured",
      kind: "not_configured",
      providerId: "",
      model: "",
      reachedProvider: false,
    });
  }

  const perCall = aiProviderTimeoutMs();
  const deadline = Date.now() + Math.min(perCall * 2, MAX_TOTAL_MS);
  let lastError: AiProviderError | null = null;
  let reached = false;

  for (let index = 0; index < routes.length; index += 1) {
    const { adapter, model } = routes[index];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const call = {
        model,
        system: request.system,
        prompt: request.prompt,
        history: request.history,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        timeoutMs: Math.min(perCall, remaining),
        signal: request.signal,
        logTag: request.logTag,
        subject: request.subject,
        advice: request.advice,
      };
      try {
        const answer =
          request.operation === "structured" ? await adapter.generateStructured(call) : request.operation === "conversation" ? await adapter.converse(call) : await adapter.generateText(call);
        if (index > 0) console.warn(`[${request.logTag}] answered by fallback provider=${adapter.id} model=${model} task=${request.task} fallbacks=${index}`);
        return { ...answer, fallbacks: index };
      } catch (error) {
        // Anything else (a refused payload, a bug) is not a provider failure: no second try.
        if (!(error instanceof AiProviderError)) throw error;
        lastError = error;
        reached = reached || error.reachedProvider;
        console.error(`[${request.logTag}] attempt failed provider=${adapter.id} model=${model} task=${request.task} kind=${error.kind} try=${attempt + 1}`);
        if (attempt > 0 || !retriesSameRoute(error.kind) || deadline - Date.now() <= RETRY_DELAY_MS) break;
        await wait(RETRY_DELAY_MS);
      }
    }
    if (lastError && !canFallBack(lastError.kind)) break;
  }

  if (!lastError) {
    throw new AiProviderError({ status: 504, message: `${request.subject} request timed out. ${request.advice}`, code: "timeout", kind: "timeout", providerId: routes[0].adapter.id, model: routes[0].model, reachedProvider: false });
  }
  // A later provider being unreachable does not undo an earlier one having received the request.
  lastError.reachedProvider = reached;
  throw lastError;
}
