import { isAiProviderEnabled } from "@/lib/env";
import { HttpError } from "@/lib/api";
import { geminiGenerateJson } from "./gemini-http";

/**
 * Low-level Gemini call kept for compatibility (no route uses it). It is a
 * thin wrapper over the ONE Gemini implementation, `gemini-http.ts`, so it
 * follows the same rules: the kill switch, the key in a header only, one
 * timeout including the body, fixed error messages and scalar-only logs.
 */
export class GeminiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

const MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9.-]{0,62}$/;

export async function generateGeminiContent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!isAiProviderEnabled()) {
    throw new GeminiProviderError("AI provider is disabled.");
  }
  if (!apiKey || apiKey.trim().length === 0) {
    throw new GeminiProviderError("GEMINI_API_KEY is not configured.");
  }
  if (!MODEL_PATTERN.test(model)) {
    throw new GeminiProviderError("Invalid model name.");
  }
  try {
    const result = await geminiGenerateJson({
      apiKey,
      model,
      system: systemPrompt.slice(0, 20000),
      prompt: userPrompt.slice(0, 10000),
      maxOutputTokens: 2048,
      logTag: "ai-provider",
      subject: "AI request",
      advice: "Please try again later.",
    });
    return result.text;
  } catch (error) {
    // Fixed messages only (never Google's text, the key or the prompt).
    throw new GeminiProviderError(error instanceof HttpError ? error.message : "AI request failed.");
  }
}
