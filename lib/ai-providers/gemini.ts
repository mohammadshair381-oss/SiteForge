import { geminiExtraModels, geminiModel } from "@/lib/env";
import { geminiGenerateJson } from "@/lib/ai-planning/gemini-http";
import { AiProviderError } from "./errors";
import type { AiCapability, AiGeneration, AiModelInfo, AiProviderAdapter, AiProviderRequest } from "./types";

/**
 * Google Gemini as one provider adapter. The request itself stays in the one Gemini
 * implementation, `lib/ai-planning/gemini-http.ts` (key in a header only, one timeout including
 * the body, fixed messages, scalar-only logs). The key is read here and goes nowhere else.
 */
const GENERATION: readonly AiCapability[] = ["text", "structured_json", "conversation", "system_instructions", "usage_metadata"];

/** Gemini ids that do not generate text, so they are never offered for a text task. */
const NOT_FOR_TEXT = /embedding|imagen|image|veo|tts|audio|live/;

function modelInfo(id: string): AiModelInfo {
  const generates = !NOT_FOR_TEXT.test(id);
  return {
    id,
    displayName: id,
    capabilities: generates ? GENERATION : [],
    structuredOutput: generates ? "json_mode" : "none",
    // Google publishes these per model and they change, so none is assumed here.
    maxInputTokens: null,
    maxOutputTokens: null,
  };
}

async function call(request: AiProviderRequest, responseFormat: "text" | "json"): Promise<AiGeneration> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiProviderError({
      status: 503,
      message: `${request.subject} is not configured. ${request.advice}`,
      code: "provider_not_configured",
      kind: "not_configured",
      providerId: "gemini",
      model: request.model,
      reachedProvider: false,
    });
  }
  const result = await geminiGenerateJson({
    apiKey,
    model: request.model,
    system: request.system,
    prompt: request.prompt,
    history: request.history,
    responseFormat,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    timeoutMs: request.timeoutMs,
    signal: request.signal,
    logTag: request.logTag,
    subject: request.subject,
    advice: request.advice,
  });
  return { providerId: "gemini", model: result.model, text: result.text, usage: result.usage };
}

export const geminiAdapter: AiProviderAdapter = {
  id: "gemini",
  displayName: "Google Gemini",
  requiredConfig: ["AI_PROVIDER_ENABLED", "GEMINI_API_KEY"],
  optionalConfig: ["GEMINI_MODEL", "GEMINI_MODELS", "AI_PROVIDER_TIMEOUT_MS"],
  isConfigured: () => Boolean(process.env.GEMINI_API_KEY) && geminiModel() !== null,
  defaultModel: () => geminiModel(),
  models: () => {
    const main = geminiModel();
    return [...new Set([...(main ? [main] : []), ...geminiExtraModels()])].map(modelInfo);
  },
  generateText: (request) => call(request, "text"),
  generateStructured: (request) => call(request, "json"),
  converse: (request) => call(request, "text"),
};
