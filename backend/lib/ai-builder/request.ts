import { HttpError } from "@/lib/api";
import { Business } from "@/models/Business";
import { AiProviderError } from "@/lib/ai-providers/errors";
import { assertAiConsent } from "./consent";
import { generateStructured, unreadableSuggestion } from "./provider";
import { assertNoKnownContact, assertProviderPayloadSafe, knownContactOf } from "./sanitize";
import { recordAiOutcome, reserveAiRequest, type AiTask } from "./usage";

/** Errors raised before anything reached the provider (the request is not charged). */
const NOT_SENT = new Set(["provider_not_configured", "unsafe_content", "ai_consent_required", "provider_unreachable"]);
/** The provider answered, but the answer was refused (e.g. cut off before it finished). */
const REJECTED_OUTPUT = new Set(["output_truncated"]);

/**
 * One AI builder provider call, in this order:
 * 1. consent is read again (a revocation since the request started wins);
 * 2. the complete outgoing text passes the sanitization checks, including one
 *    for this business's saved contact details;
 * 3. one request is reserved in the plan's monthly allowance (atomic);
 * 4. the provider layer is called once (its retries and any configured fallback stay inside
 *    this one reservation, so a request is charged once);
 * 5. `accept` validates the output and turns it into a result, exactly once, so a request can
 *    never create two proposals.
 * The outcome is recorded as success, failed (provider error), rejected (the
 * output was refused) or not sent (refunded). Usage records hold counters
 * and provider-reported token counts only.
 */
export async function runAiRequest<R>(input: {
  businessId: string;
  task: AiTask;
  limit: number;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Fixed message parts for provider failures; default "AI suggestions". */
  subject?: string;
  advice?: string;
  /**
   * Charge only for an accepted answer: for steps of a longer job, where a failure is simply tried
   * again and must not cost twice. The rate limits still bound how often that can happen.
   */
  chargeOnlyAccepted?: boolean;
  accept: (value: unknown) => Promise<R> | R;
}): Promise<R> {
  await assertAiConsent(input.businessId);
  assertProviderPayloadSafe(input.system, input.prompt);
  const contact = await Business.findById(input.businessId).select("contactEmail phone address").lean<{ contactEmail?: string; phone?: string; address?: string }>();
  assertNoKnownContact(input.prompt, knownContactOf(contact ?? {}));
  const period = await reserveAiRequest(input.businessId, input.task, input.limit);

  let generated: Awaited<ReturnType<typeof generateStructured>>;
  try {
    generated = await generateStructured(input.task, { system: input.system, prompt: input.prompt, maxOutputTokens: input.maxOutputTokens, subject: input.subject, advice: input.advice });
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "";
    // An earlier attempt may have reached a provider even if the last one did not.
    const reached = error instanceof AiProviderError && error.reachedProvider;
    await recordAiOutcome(input.businessId, period, {
      result: NOT_SENT.has(code) && !reached ? "not_sent" : REJECTED_OUTPUT.has(code) ? "rejected" : "failed",
      task: input.task,
      refund: input.chargeOnlyAccepted,
      route: reached ? { providerId: (error as AiProviderError).providerId, model: (error as AiProviderError).model } : null,
    });
    throw error;
  }
  const route = { providerId: generated.providerId, model: generated.model };
  if (generated.value === undefined) {
    await recordAiOutcome(input.businessId, period, { result: "rejected", usage: generated.usage, route, fallbacks: generated.fallbacks, task: input.task, refund: input.chargeOnlyAccepted });
    throw unreadableSuggestion();
  }
  try {
    const result = await input.accept(generated.value);
    await recordAiOutcome(input.businessId, period, { result: "success", usage: generated.usage, model: generated.model, route, fallbacks: generated.fallbacks });
    return result;
  } catch (error) {
    await recordAiOutcome(input.businessId, period, { result: error instanceof HttpError && error.status < 500 ? "rejected" : "failed", usage: generated.usage, route, fallbacks: generated.fallbacks, task: input.task, refund: input.chargeOnlyAccepted });
    throw error;
  }
}
