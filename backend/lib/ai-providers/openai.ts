import { aiProviderTimeoutMs } from "@/lib/env";
import { HttpError } from "@/lib/api";
import { assertProviderPayloadSafe } from "@/lib/ai-builder/sanitize";
import { aiProviderKey } from "./credentials";
import { AiProviderError, type AiErrorKind } from "./errors";
import type { AiCapability, AiGeneration, AiModelInfo, AiProviderAdapter, AiProviderRequest } from "./types";

/**
 * OpenAI as one provider adapter (owner decision, 2026-11-17), over its Chat Completions HTTP API
 * with native `fetch`, like the Gemini adapter: the key (the Super Admin's, else OPENAI_API_KEY) in
 * the Authorization header only, one timeout including the body, no retries of its own, fixed
 * messages, and logs holding status numbers only, never OpenAI's text, the prompt or the answer.
 */
const PROVIDER_ID = "openai";
const KEY_ENV = "OPENAI_API_KEY";
const API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-5";
const MODEL_PATTERN = /^(gpt-|o)[a-z0-9][a-z0-9.-]{0,62}$/;
const GENERATION: readonly AiCapability[] = ["text", "structured_json", "conversation", "system_instructions", "usage_metadata"];

function openaiModel(): string | null {
  const raw = process.env.OPENAI_MODEL?.trim();
  if (!raw) return DEFAULT_MODEL;
  return MODEL_PATTERN.test(raw) ? raw : null;
}

function openaiModels(): string[] {
  const extra = (process.env.OPENAI_MODELS ?? "").split(",").map((value) => value.trim()).filter((value) => MODEL_PATTERN.test(value));
  const main = openaiModel();
  return [...new Set([...(main ? [main] : []), ...extra])];
}

const modelInfo = (id: string): AiModelInfo => ({ id, displayName: id, capabilities: GENERATION, structuredOutput: "json_mode", maxInputTokens: null, maxOutputTokens: null });
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
const safeStatus = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? value : 0);

async function call(request: AiProviderRequest, json: boolean): Promise<AiGeneration> {
  const { subject, advice, logTag } = request;
  const fail = (status: number, message: string, code: string, kind: AiErrorKind, reachedProvider = true) =>
    new AiProviderError({ status, message, code, kind, reachedProvider, providerId: PROVIDER_ID, model: request.model });

  const apiKey = aiProviderKey(PROVIDER_ID, KEY_ENV);
  if (!apiKey) throw fail(503, `${subject} is not configured. ${advice}`, "provider_not_configured", "not_configured", false);
  if (!MODEL_PATTERN.test(request.model)) throw fail(503, `${subject} is not configured correctly. ${advice}`, "provider_not_configured", "not_configured", false);

  // Central data check before ANY provider request (lib/ai-builder/sanitize.ts).
  assertProviderPayloadSafe(request.system ?? "", request.prompt, ...(request.history ?? []).map((message) => message.text));

  const body = {
    model: request.model,
    messages: [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
      ...(request.history ?? []).map((message) => ({ role: message.role, content: message.text })),
      { role: "user", content: request.prompt },
    ],
    // Reasoning models count their reasoning here too, so leave room for it.
    max_completion_tokens: Math.min(request.maxOutputTokens * 2, 64000),
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };

  const abort = new AbortController();
  const timeoutId = setTimeout(() => abort.abort(), request.timeoutMs ?? aiProviderTimeoutMs());
  const onCancel = () => abort.abort();
  if (request.signal?.aborted) abort.abort();
  else request.signal?.addEventListener("abort", onCancel, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: abort.signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      console.error(`[${logTag}] provider unreachable`);
      throw fail(502, `${subject} request failed. ${advice}`, "provider_unreachable", "unreachable", false);
    }
    if (!response.ok) {
      const status = safeStatus(response.status);
      console.error(`[${logTag}] upstream failure http=${status}`);
      if (status === 429) throw fail(429, `${subject} rate limit exceeded. Please try again later.`, "rate_limit_exceeded", "rate_limited");
      if (status === 401 || status === 403) throw fail(503, `${subject} is not available. ${advice}`, "provider_unavailable", "authentication");
      if (status === 503) throw fail(503, `${subject} is temporarily unavailable. ${advice}`, "provider_unavailable", "temporary");
      throw fail(502, `${subject} request failed. ${advice}`, "provider_error", status === 404 ? "model_unavailable" : status === 502 || status === 504 ? "temporary" : status >= 500 ? "server_error" : "rejected_request");
    }
    const data = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const choice = data.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
      console.error(`[${logTag}] response blocked`);
      throw fail(422, `${subject} could not answer this request. ${advice}`, "provider_blocked", "blocked");
    }
    if (choice?.finish_reason === "length") {
      console.error(`[${logTag}] response finish=length chars=${text.length}`);
      throw fail(422, `${subject} response was cut off before it finished. ${advice}`, "output_truncated", "truncated");
    }
    if (text.trim().length === 0) {
      console.error(`[${logTag}] response empty`);
      throw fail(502, `${subject} returned empty content. ${advice}`, "provider_error", "invalid_output");
    }
    return { providerId: PROVIDER_ID, model: request.model, text: text.trim(), usage: { promptTokens: count(data.usage?.prompt_tokens), outputTokens: count(data.usage?.completion_tokens), totalTokens: count(data.usage?.total_tokens) } };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      if (request.signal?.aborted) throw fail(499, `${subject} request was cancelled.`, "cancelled", "cancelled");
      throw fail(504, `${subject} request timed out. ${advice}`, "timeout", "timeout");
    }
    throw fail(502, `${subject} request failed. ${advice}`, "provider_error", "invalid_output");
  } finally {
    clearTimeout(timeoutId);
    request.signal?.removeEventListener("abort", onCancel);
  }
}

export const openaiAdapter: AiProviderAdapter = {
  id: PROVIDER_ID,
  displayName: "OpenAI",
  keyEnvName: KEY_ENV,
  requiredConfig: ["AI_PROVIDER_ENABLED", KEY_ENV],
  optionalConfig: ["OPENAI_MODEL", "OPENAI_MODELS", "AI_PROVIDER_TIMEOUT_MS"],
  isConfigured: () => Boolean(aiProviderKey(PROVIDER_ID, KEY_ENV)) && openaiModel() !== null,
  defaultModel: () => openaiModel(),
  models: () => openaiModels().map(modelInfo),
  generateText: (request) => call(request, false),
  generateStructured: (request) => call(request, true),
  converse: (request) => call(request, false),
};
