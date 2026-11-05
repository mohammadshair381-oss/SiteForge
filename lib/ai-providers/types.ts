/**
 * What every AI provider adapter offers (pure types and constants; server-side use only).
 * Application code talks to `executeAiTask` (./execute.ts) and receives these normalized
 * results, so no feature depends on one provider's request or response format.
 */

export const AI_CAPABILITIES = ["text", "structured_json", "conversation", "system_instructions", "usage_metadata"] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** How a model produces JSON: not at all, a JSON-only mode, or against a supplied schema. */
export type AiStructuredOutputSupport = "none" | "json_mode" | "json_schema";

export interface AiModelInfo {
  id: string;
  displayName: string;
  capabilities: readonly AiCapability[];
  structuredOutput: AiStructuredOutputSupport;
  /** Null when not known: nothing is assumed from a missing limit. */
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
}

export interface AiMessage {
  role: "user" | "assistant";
  text: string;
}

/** Only as the provider reported them (null when absent): nothing is estimated. */
export interface AiUsageCounts {
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AiProviderRequest {
  model: string;
  /** Fixed instructions, sent separately from untrusted content where the provider allows it. */
  system?: string;
  /** The newest user turn. Untrusted content belongs here, delimited by the caller. */
  prompt: string;
  /** Earlier turns of a conversation, oldest first. */
  history?: readonly AiMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** One limit for the whole exchange, including reading the body. */
  timeoutMs?: number;
  /** Cancels the request. A cancelled request is never retried. */
  signal?: AbortSignal;
  /** Log prefix, e.g. "ai-builder". */
  logTag: string;
  /** Fixed client message parts: subject ("AI suggestions") and advice ("You can still ..."). */
  subject: string;
  advice: string;
}

/** A normalized provider answer. `text` is still untrusted: callers validate it. */
export interface AiGeneration {
  providerId: string;
  model: string;
  text: string;
  usage: AiUsageCounts;
}

/**
 * One provider. To add a provider, implement this and register it (./registry.ts), and add it
 * to `AI_DISCLOSED_PROVIDER_IDS` only once the consent disclosure names it. No feature changes.
 */
export interface AiProviderAdapter {
  /** Lowercase letters, digits and dashes; also part of usage records. */
  id: string;
  displayName: string;
  /** Names of the server environment variables it needs, never their values. */
  requiredConfig: readonly string[];
  optionalConfig: readonly string[];
  /** Its credentials and settings are present. Says nothing about whether it may be used. */
  isConfigured(): boolean;
  /** The model used when none is chosen; null when none is valid. */
  defaultModel(): string | null;
  /** What it can call right now. Decided by the adapter, from its own configuration. */
  models(): readonly AiModelInfo[];
  /** Plain text. */
  generateText(request: AiProviderRequest): Promise<AiGeneration>;
  /** `text` holds the JSON answer; the shared service parses and validates it. */
  generateStructured(request: AiProviderRequest): Promise<AiGeneration>;
  /** Plain text, using `history`. */
  converse(request: AiProviderRequest): Promise<AiGeneration>;
}
