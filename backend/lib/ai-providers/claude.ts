import Anthropic from "@anthropic-ai/sdk";
import { aiProviderTimeoutMs } from "@/lib/env";
import { assertProviderPayloadSafe } from "@/lib/ai-builder/sanitize";
import { aiProviderKey } from "./credentials";
import { AiProviderError, type AiErrorKind } from "./errors";
import type { AiCapability, AiGeneration, AiModelInfo, AiProviderAdapter, AiProviderRequest } from "./types";

/**
 * Anthropic Claude as one provider adapter (owner decision, 2026-11-17), through the official
 * Anthropic SDK. Same rules as Gemini: the key (the Super Admin's, else ANTHROPIC_API_KEY) goes
 * only to the SDK, one timeout per call, no retries of its own (`executeAiTask` decides), fixed
 * messages, and logs hold status numbers only, never Anthropic's text, the prompt or the answer.
 */
const PROVIDER_ID = "claude";
const KEY_ENV = "ANTHROPIC_API_KEY";
const DEFAULT_MODEL = "claude-opus-5-5";
/** Current models a Super Admin may route to. More come from `CLAUDE_MODELS`. */
const KNOWN_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9.-]{0,62}$/;
/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/;
const GENERATION: readonly AiCapability[] = ["text", "structured_json", "conversation", "system_instructions", "usage_metadata"];
/** Room for the model's thinking as well as the answer: thinking counts towards `max_tokens`. */
const MIN_MAX_TOKENS = 16000;
const MAX_MAX_TOKENS = 64000;

function claudeModel(): string | null {
  const raw = process.env.CLAUDE_MODEL?.trim();
  if (!raw) return DEFAULT_MODEL;
  return MODEL_PATTERN.test(raw) ? raw : null;
}

function claudeModels(): string[] {
  const extra = (process.env.CLAUDE_MODELS ?? "").split(",").map((value) => value.trim()).filter((value) => MODEL_PATTERN.test(value));
  const main = claudeModel();
  return [...new Set([...(main ? [main] : []), ...KNOWN_MODELS, ...extra])];
}

function modelInfo(id: string): AiModelInfo {
  // JSON comes from the instructions and is parsed and validated by the shared parser, as with Gemini.
  return { id, displayName: id, capabilities: GENERATION, structuredOutput: "json_mode", maxInputTokens: null, maxOutputTokens: null };
}

const safeStatus = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : 0);

async function call(request: AiProviderRequest): Promise<AiGeneration> {
  const { subject, advice } = request;
  const fail = (status: number, message: string, code: string, kind: AiErrorKind, reachedProvider = true) =>
    new AiProviderError({ status, message, code, kind, reachedProvider, providerId: PROVIDER_ID, model: request.model });

  const apiKey = aiProviderKey(PROVIDER_ID, KEY_ENV);
  if (!apiKey) throw fail(503, `${subject} is not configured. ${advice}`, "provider_not_configured", "not_configured", false);
  if (!MODEL_PATTERN.test(request.model)) throw fail(503, `${subject} is not configured correctly. ${advice}`, "provider_not_configured", "not_configured", false);

  // Central data check before ANY provider request (lib/ai-builder/sanitize.ts).
  assertProviderPayloadSafe(request.system ?? "", request.prompt, ...(request.history ?? []).map((message) => message.text));

  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: request.timeoutMs ?? aiProviderTimeoutMs() });
  try {
    const stream = client.beta.messages.stream(
      {
        model: request.model,
        max_tokens: Math.min(Math.max(request.maxOutputTokens * 2, MIN_MAX_TOKENS), MAX_MAX_TOKENS),
        ...(request.system ? { system: request.system } : {}),
        messages: [...(request.history ?? []).map((message) => ({ role: message.role, content: message.text })), { role: "user" as const, content: request.prompt }],
        output_config: { effort: "medium" },
        ...(FALLBACK_MODELS.test(request.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    );
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      console.error(`[${request.logTag}] response stop=refusal`);
      throw fail(422, `${subject} could not answer this request. ${advice}`, "provider_blocked", "blocked");
    }
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (message.stop_reason === "max_tokens") {
      console.error(`[${request.logTag}] response stop=max_tokens chars=${text.length}`);
      throw fail(422, `${subject} response was cut off before it finished. ${advice}`, "output_truncated", "truncated");
    }
    if (text.trim().length === 0) {
      console.error(`[${request.logTag}] response empty stop=${message.stop_reason ?? "none"}`);
      throw fail(502, `${subject} returned empty content. ${advice}`, "provider_error", "invalid_output");
    }
    const input = message.usage.input_tokens ?? null;
    const output = message.usage.output_tokens ?? null;
    return { providerId: PROVIDER_ID, model: request.model, text: text.trim(), usage: { promptTokens: input, outputTokens: output, totalTokens: input !== null && output !== null ? input + output : null } };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Anthropic.APIUserAbortError) {
      if (request.signal?.aborted) throw fail(499, `${subject} request was cancelled.`, "cancelled", "cancelled");
      throw fail(504, `${subject} request timed out. ${advice}`, "timeout", "timeout");
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) throw fail(504, `${subject} request timed out. ${advice}`, "timeout", "timeout");
    if (error instanceof Anthropic.APIConnectionError) {
      console.error(`[${request.logTag}] provider unreachable`);
      throw fail(502, `${subject} request failed. ${advice}`, "provider_unreachable", "unreachable", false);
    }
    if (error instanceof Anthropic.APIError) {
      const status = safeStatus(error.status);
      // Only the number, never Anthropic's message.
      console.error(`[${request.logTag}] upstream failure http=${status}`);
      if (error instanceof Anthropic.RateLimitError) throw fail(429, `${subject} rate limit exceeded. Please try again later.`, "rate_limit_exceeded", "rate_limited");
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw fail(503, `${subject} is not available. ${advice}`, "provider_unavailable", "authentication");
      if (error instanceof Anthropic.NotFoundError) throw fail(502, `${subject} request failed. ${advice}`, "provider_error", "model_unavailable");
      if (status === 529 || status === 503) throw fail(503, `${subject} is temporarily unavailable. ${advice}`, "provider_unavailable", "temporary");
      throw fail(502, `${subject} request failed. ${advice}`, "provider_error", status === 502 || status === 504 ? "temporary" : status >= 500 ? "server_error" : "rejected_request");
    }
    // The provider answered, but the answer could not be read.
    throw fail(502, `${subject} request failed. ${advice}`, "provider_error", "invalid_output");
  }
}

export const claudeAdapter: AiProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "Anthropic Claude",
  keyEnvName: KEY_ENV,
  requiredConfig: ["AI_PROVIDER_ENABLED", KEY_ENV],
  optionalConfig: ["CLAUDE_MODEL", "CLAUDE_MODELS", "AI_PROVIDER_TIMEOUT_MS"],
  isConfigured: () => Boolean(aiProviderKey(PROVIDER_ID, KEY_ENV)) && claudeModel() !== null,
  defaultModel: () => claudeModel(),
  models: () => claudeModels().map(modelInfo),
  generateText: (request) => call(request),
  generateStructured: (request) => call(request),
  converse: (request) => call(request),
};
