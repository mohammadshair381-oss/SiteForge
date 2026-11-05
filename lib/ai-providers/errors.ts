import { HttpError } from "@/lib/api";

/**
 * Provider failures in one vocabulary. It extends `HttpError`, so a failure reaches the client
 * with its fixed message and code; the provider's own error text is never read into it.
 */
export const AI_ERROR_KINDS = [
  "not_configured",
  "authentication",
  "model_unavailable",
  "rate_limited",
  "temporary",
  "server_error",
  "unreachable",
  "timeout",
  "cancelled",
  "rejected_request",
  "invalid_output",
  "truncated",
  "blocked",
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

export class AiProviderError extends HttpError {
  readonly kind: AiErrorKind;
  readonly providerId: string;
  readonly model: string;
  /** The provider may have received the request. Set across attempts by `executeAiTask`. */
  reachedProvider: boolean;

  constructor(input: { status: number; message: string; code: string; kind: AiErrorKind; providerId: string; model: string; reachedProvider: boolean }) {
    super(input.status, input.message, input.code);
    this.name = "AiProviderError";
    this.kind = input.kind;
    this.providerId = input.providerId;
    this.model = input.model;
    this.reachedProvider = input.reachedProvider;
  }
}

/**
 * Retrying generation changes nothing stored, because nothing is saved until the answer is
 * accepted. Only overload and connection failures are retried: never a timeout or a server error
 * (the provider may have done the work, and may charge for it again), a refused request or an
 * answer that was refused.
 */
export function retriesSameRoute(kind: AiErrorKind): boolean {
  return kind === "temporary" || kind === "unreachable";
}

/**
 * Another configured provider may help with a problem of this provider, but not with the
 * request itself: sending the same request elsewhere would not fix a refused or unusable answer.
 */
export function canFallBack(kind: AiErrorKind): boolean {
  return ["not_configured", "authentication", "model_unavailable", "rate_limited", "temporary", "server_error", "unreachable", "timeout"].includes(kind);
}
