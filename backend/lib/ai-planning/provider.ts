import { aiBuilderStatus } from "@/lib/ai-builder/provider";
import { planningPrompt } from "@/lib/ai-builder/prompts";
import { executeAiTask } from "@/lib/ai-providers/execute";
import { DEFAULT_AI_ROUTING } from "@/lib/ai-providers/settings";
import { websitePlanSchema, type WebsitePlan, type WebsitePlanningProviderRequest } from "./plan";
import { HttpError } from "@/lib/api";

export interface WebsitePlanningProvider {
  generatePlan(request: WebsitePlanningProviderRequest): Promise<unknown>;
}

export class PlanningProviderUnavailableError extends Error {
  constructor() {
    super("AI planning is not configured. Prepare a manual review draft instead.");
    this.name = "PlanningProviderUnavailableError";
  }
}

/**
 * Whether planning could run, and the plan contract over the shared provider layer. No route
 * generates a plan through this: `planning/generate` uses `runAiRequest`, like every AI task, for
 * consent, the allowance and the claims check. It has no provider call of its own.
 */
export function getWebsitePlanningProvider(): WebsitePlanningProvider | null {
  // Paused unless explicitly enabled: a key alone must never send data out.
  if (!aiBuilderStatus().available) return null;
  return {
    generatePlan: async (request: WebsitePlanningProviderRequest): Promise<unknown> => {
      const { system, prompt } = planningPrompt({ ...request, knownContact: [] });
      const result = await executeAiTask({
        task: "planning",
        operation: "structured",
        system,
        prompt,
        // Room for a multi-page plan; truncation is still detected.
        maxOutputTokens: 8192,
        logTag: "ai-planning",
        subject: "AI planning",
        advice: "Please try manual planning.",
        routing: DEFAULT_AI_ROUTING,
      });
      return result.text;
    },
  };
}

export async function requestValidatedWebsitePlan(
  provider: WebsitePlanningProvider | null,
  request: WebsitePlanningProviderRequest,
): Promise<WebsitePlan> {
  if (!provider) throw new PlanningProviderUnavailableError();

  const untrustedResponse = await provider.generatePlan(request);
  // The provider returns a raw text string; clean and parse it as JSON before schema validation.
  // Gemini may wrap JSON in markdown fences or add explanatory text despite instructions.
  let parsedResponse: unknown;
  // Length only: enough to tell "short/garbage" from "long but unparseable"
  // without ever recording the generated content itself.
  let responseChars = 0;
  try {
    let cleaned = typeof untrustedResponse === "string" ? untrustedResponse.trim() : JSON.stringify(untrustedResponse);
    responseChars = cleaned.length;
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }
    // If still not valid JSON, try to extract the first JSON object/array from the text
    try {
      parsedResponse = JSON.parse(cleaned);
    } catch {
      // Try to find a JSON object in the text
      const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        parsedResponse = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error("No JSON found");
      }
    }
  } catch (err) {
    console.error(`[ai-planning] response not parseable chars=${responseChars}`);
    throw new HttpError(422, "AI planning returned invalid JSON. Please try manual planning.", "invalid_response");
  }
  try {
    return websitePlanSchema.parse(parsedResponse);
  } catch (err) {
    throw new HttpError(422, "AI planning returned an invalid plan. Please try manual planning.", "invalid_plan");
  }
}
