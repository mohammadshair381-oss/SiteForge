import { HttpError } from "@/lib/api";
import { DEFAULT_GEMINI_MODEL, aiProviderTimeoutMs, geminiModel } from "@/lib/env";
import { assertProviderPayloadSafe } from "@/lib/ai-builder/sanitize";
import { AiProviderError, type AiErrorKind } from "@/lib/ai-providers/errors";
import type { AiMessage, AiUsageCounts } from "@/lib/ai-providers/types";

/**
 * The one HTTP call to Gemini, reached through the Gemini adapter (lib/ai-providers/gemini.ts).
 * Callers MUST check the kill switch (`isAiProviderEnabled()`) before calling; this module never
 * decides whether AI is allowed. Failures are `AiProviderError`s, with the same status and code
 * for the client and a provider-independent `kind` for retries and fallback.
 *
 * Safety properties (docs/ai-website-builder-plan.md, M0):
 * - the API key travels only in the `x-goog-api-key` header, never in a URL;
 * - one timeout covers the whole exchange, including reading the body;
 * - client-facing errors are fixed messages; Google's free-form error text is
 *   never read, forwarded or logged;
 * - logs carry only bounded scalars (HTTP status, numeric code, enum tokens,
 *   counts), never the prompt, the generated text, the URL or the key;
 * - token counts come only from the provider's own `usageMetadata` (null when
 *   absent): nothing is estimated.
 */

/** Default upper bound for one provider call (connection, response and body); `AI_PROVIDER_TIMEOUT_MS` overrides it. */
export const GEMINI_TIMEOUT_MS = 30_000;
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
/** Default model; `GEMINI_MODEL` (validated, lib/env.ts) selects another Gemini model. */
export const GEMINI_MODEL = DEFAULT_GEMINI_MODEL;

export type GeminiUsage = AiUsageCounts;

export interface GeminiResult {
  text: string;
  model: string;
  usage: GeminiUsage;
}

export interface GeminiCallOptions {
  apiKey: string;
  /** Untrusted content (owner text, store data) belongs here, delimited by the caller. */
  prompt: string;
  /** Fixed instructions, sent separately from the untrusted prompt. */
  system?: string;
  /** Earlier turns of a conversation, oldest first. */
  history?: readonly AiMessage[];
  /** Default "json" (Gemini's JSON-only mode). */
  responseFormat?: "text" | "json";
  /** One limit for the whole exchange; default `aiProviderTimeoutMs()`. */
  timeoutMs?: number;
  /** Cancels the request. */
  signal?: AbortSignal;
  maxOutputTokens: number;
  temperature?: number;
  /** A Gemini model id; defaults to the configured `GEMINI_MODEL`. */
  model?: string;
  /** Log prefix, e.g. "ai-planning". */
  logTag: string;
  /** Client message subject ("AI planning") and advice ("Please try manual planning."). */
  subject: string;
  advice: string;
}

function safeUpstreamHttpStatus(value: unknown): number | "unknown" {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : "unknown";
}

/** Google's enum-like identifiers (`error.status`, `finishReason`, `blockReason`). */
function safeUpstreamStatusToken(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const token = value.trim();
  return /^[A-Z][A-Z0-9_]{0,47}$/.test(token) ? token : "unknown";
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : null;
}

export async function geminiGenerateJson(options: GeminiCallOptions): Promise<GeminiResult> {
  const { subject, advice, logTag } = options;
  const fail = (status: number, message: string, code: string, kind: AiErrorKind, reachedProvider = true) =>
    new AiProviderError({ status, message, code, kind, reachedProvider, providerId: "gemini", model: options.model ?? geminiModel() ?? "" });
  const logUnusable = (finishReason: unknown, blockReason: unknown, partsCount: number, textChars: number) =>
    console.error(`[${logTag}] response finish=${safeUpstreamStatusToken(finishReason)} block=${safeUpstreamStatusToken(blockReason)} parts=${partsCount} chars=${textChars}`);

  const model = options.model ?? geminiModel();
  if (!model || !/^gemini-[a-z0-9][a-z0-9.-]{0,62}$/.test(model)) {
    console.error(`[${logTag}] invalid model configuration`);
    throw fail(503, `${subject} is not configured correctly. ${advice}`, "provider_not_configured", "not_configured", false);
  }
  const url = `${GEMINI_API_URL}/${model}:generateContent`;
  const body = {
    ...(options.system ? { systemInstruction: { parts: [{ text: options.system }] } } : {}),
    contents: [
      ...(options.history ?? []).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.text }] })),
      { role: "user", parts: [{ text: options.prompt }] },
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens,
      topP: 0.8,
      topK: 40,
      ...(options.responseFormat === "text" ? {} : { responseMimeType: "application/json" }),
    },
  };

  // Central data check before ANY provider request (lib/ai-builder/sanitize.ts).
  assertProviderPayloadSafe(options.system ?? "", options.prompt, ...(options.history ?? []).map((message) => message.text));

  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => abortCtrl.abort(), options.timeoutMs ?? aiProviderTimeoutMs());
  const onCancel = () => abortCtrl.abort();
  if (options.signal?.aborted) abortCtrl.abort();
  else options.signal?.addEventListener("abort", onCancel, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
        body: JSON.stringify(body),
        signal: abortCtrl.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err; // a timeout (below)
      // No HTTP response at all (DNS, refused connection, TLS): the provider
      // never received the request, so callers do not charge it.
      console.error(`[${logTag}] provider unreachable`);
      throw fail(502, `${subject} request failed. ${advice}`, "provider_unreachable", "unreachable", false);
    }

    if (!response.ok) {
      // Only the numeric code and enum status are used, never Google's message.
      let statusCode = response.status;
      let errorStatus: unknown;
      try {
        const errorData = await response.json();
        if (errorData?.error?.code) statusCode = errorData.error.code;
        errorStatus = errorData?.error?.status;
      } catch {
        // Not JSON: keep the HTTP status.
      }
      console.error(
        `[${logTag}] upstream failure http=${safeUpstreamHttpStatus(response.status)} code=${safeUpstreamHttpStatus(statusCode)} status=${safeUpstreamStatusToken(errorStatus)}`,
      );
      if (statusCode === 429) throw fail(429, `${subject} rate limit exceeded. Please try again later.`, "rate_limit_exceeded", "rate_limited");
      if (statusCode === 401 || statusCode === 403) throw fail(503, `${subject} is not available. ${advice}`, "provider_unavailable", "authentication");
      if (statusCode === 503) throw fail(503, `${subject} is temporarily unavailable. ${advice}`, "provider_unavailable", "temporary");
      throw fail(502, `${subject} request failed. ${advice}`, "provider_error", statusCode === 404 ? "model_unavailable" : statusCode === 502 || statusCode === 504 ? "temporary" : statusCode >= 500 ? "server_error" : "rejected_request");
    }

    const data = (await response.json()) as {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown };
      error?: { code: number; message: string; status: string };
    };

    if (data.error) {
      console.error(
        `[${logTag}] upstream failure http=${safeUpstreamHttpStatus(response.status)} code=${safeUpstreamHttpStatus(data.error.code)} status=${safeUpstreamStatusToken(data.error.status)}`,
      );
      throw fail(502, `${subject} request failed. ${advice}`, "provider_error", "server_error");
    }

    const candidate = data.candidates?.[0];
    const finishReason: unknown = candidate?.finishReason;
    const blockReason: unknown = data.promptFeedback?.blockReason;
    if (!data.candidates || data.candidates.length === 0) {
      logUnusable(finishReason, blockReason, 0, 0);
      throw fail(502, `${subject} returned no results. ${advice}`, "provider_error", blockReason ? "blocked" : "invalid_output");
    }

    // Parts of one candidate are sequential output; "thought" parts are never output.
    const rawParts = candidate?.content?.parts;
    const parts = Array.isArray(rawParts) ? rawParts : [];
    const text = parts
      .filter((part) => part?.thought !== true && typeof part?.text === "string")
      .map((part) => part.text as string)
      .join("");

    if (finishReason === "MAX_TOKENS") {
      logUnusable(finishReason, blockReason, parts.length, text.length);
      throw fail(422, `${subject} response was cut off before it finished. ${advice}`, "output_truncated", "truncated");
    }
    if (text.trim().length === 0) {
      logUnusable(finishReason, blockReason, parts.length, text.length);
      throw fail(502, `${subject} returned empty content. ${advice}`, "provider_error", "invalid_output");
    }

    const usage = data.usageMetadata;
    return {
      text: text.trim(),
      model,
      usage: { promptTokens: safeCount(usage?.promptTokenCount), outputTokens: safeCount(usage?.candidatesTokenCount), totalTokens: safeCount(usage?.totalTokenCount) },
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      if (options.signal?.aborted) throw fail(499, `${subject} request was cancelled.`, "cancelled", "cancelled");
      throw fail(504, `${subject} request timed out. ${advice}`, "timeout", "timeout");
    }
    // The provider answered, but the answer could not be read.
    throw fail(502, `${subject} request failed. ${advice}`, "provider_error", "invalid_output");
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onCancel);
  }
}

/**
 * Parses provider text as JSON: raw JSON, JSON in a Markdown fence, or the
 * first JSON object/array in the text. Returns undefined when nothing parses
 * (the caller maps that to a fixed error; the text itself is never logged).
 */
export function parseProviderJson(text: unknown): unknown {
  let cleaned = typeof text === "string" ? text.trim() : JSON.stringify(text);
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) cleaned = fence[1].trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[1]);
    } catch {
      return undefined;
    }
  }
}
