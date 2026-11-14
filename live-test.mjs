import { getWebsitePlanningProvider, requestValidatedWebsitePlan } from "./backend/lib/ai-planning/provider";

async function main() {
  const provider = getWebsitePlanningProvider();
  if (!provider) {
    console.log("RESULT: Provider unavailable - GEMINI_API_KEY not configured");
    return;
  }

  const request = {
    businessSummary: "A test business.",
    targetAudience: "Test audience.",
    requestedPageCount: 1,
    pages: [{ title: "Home", purpose: "Home page.", requiredContent: "Welcome." }],
    preferredTheme: "studio" as const,
    designPreferences: { notes: "" },
    productIds: [],
    specialRequirements: "",
  };

  try {
    const plan = await requestValidatedWebsitePlan(provider, request);
    console.log("RESULT: Success");
    console.log("Model: GEMINI_MODEL in lib/ai-planning/gemini-http.ts");
    console.log("Plan structure: { businessSummary, targetAudience, recommendedTheme, requestedPageCount, designPreferences, specialRequirements, productIds, pages, navigation, assumptions, unansweredQuestions, summary }");
    console.log("Pages count:", plan.pages.length);
    console.log("Summary length:", plan.summary.length, "characters (generated text is not printed)");
  } catch (error) {
    if (error instanceof Error) {
      // Sanitize error - don't expose API key
      const message = error.message.replace(/key=[^&]+/, "key=[REDACTED]");
      console.log("RESULT: Error -", message);
    } else {
      console.log("RESULT: Unknown error");
    }
  }
}

main().catch((err) => {
  console.error("RESULT: Unhandled error -", err instanceof Error ? err.message : String(err));
  process.exit(1);
});