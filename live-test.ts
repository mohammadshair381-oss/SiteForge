/**
 * Manual, opt-in connectivity check for the AI provider (never run by tests
 * or the app). It respects the same rules as the app:
 * - it does nothing unless AI_PROVIDER_ENABLED is exactly "true" (the kill
 *   switch; a key alone never sends anything);
 * - it uses the shared Gemini call (lib/ai-planning/gemini-http.ts): the key
 *   travels only in a request header, never in a URL;
 * - it prints only success or the fixed error code, never the key, Google's
 *   error text or generated content.
 *
 * It sends a fixed prompt only (no business data). For the full staging
 * verification use `npm run test:staging-ai` (docs/ai-website-builder-plan.md).
 *
 * Usage (staging; the key in the process environment):
 *   AI_PROVIDER_ENABLED=true GEMINI_API_KEY=... node --import tsx live-test.ts
 */
import { isAiProviderEnabled } from "./lib/env";
import { geminiGenerateJson } from "./lib/ai-planning/gemini-http";
import { HttpError } from "./lib/api";

async function main() {
  if (!isAiProviderEnabled()) {
    console.log("RESULT: Skipped - AI_PROVIDER_ENABLED is not exactly \"true\" (kill switch on).");
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("RESULT: Skipped - GEMINI_API_KEY is not set.");
    return;
  }
  try {
    const result = await geminiGenerateJson({
      apiKey,
      system: "Reply with a JSON object.",
      prompt: 'Return {"ok": true}.',
      maxOutputTokens: 64,
      logTag: "live-test",
      subject: "Live test",
      advice: "Check the provider configuration.",
    });
    console.log(`RESULT: Success with ${result.model} (${result.text.length} characters, tokens: ${result.usage.totalTokens ?? "not reported"})`);
  } catch (error) {
    console.log(`RESULT: Failed - ${error instanceof HttpError ? `${error.status} ${error.code}` : "unexpected error"}`);
    process.exitCode = 1;
  }
}

void main();
