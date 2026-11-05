import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { requireBusinessRole } from "@/lib/auth/guards";
import { getThemeAccess } from "@/lib/billing";
import { dbConnect } from "@/lib/db";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { runAiRequest } from "@/lib/ai-builder/request";
import { instructionSchema, themePrompt } from "@/lib/ai-builder/prompts";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import { fallbackRecommendations, recommendationsWithAccess, themeAdviceSchema, themeCatalog } from "@/lib/ai-builder/theme-advisor";
import { Business } from "@/models/Business";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `GET` — theme recommendations WITHOUT AI (from the business type and the
 * theme catalogue): nothing is sent anywhere, no allowance is used, and it
 * works with AI turned off. Each one states what this plan allows.
 */
export async function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await requireBusinessRole(id, ["owner", "manager"]);
    await dbConnect();
    const business = await Business.findById(id).select("category").lean<{ category?: string }>();
    if (!business) throw new HttpError(404, "Business not found", "not_found");
    return ok({ recommendations: fallbackRecommendations(business.category, await getThemeAccess(id)), source: "catalog" }, { headers: { "Cache-Control": "no-store" } });
  });
}

const bodySchema = z.object({ instruction: instructionSchema }).strict();

/**
 * `POST { instruction }` — asks Google Gemini to compare the nine themes for
 * this store. Nothing is saved. The server decides what the owner may do with
 * each recommendation (a theme the plan does not include is never selectable,
 * and the plan that unlocks it is named); applying one is the normal theme
 * change, which checks the plan again (`assertCanUseTheme`).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await guardAiRequest(request, id, "theme");
    const body = bodySchema.parse(await readJson(request));
    const [store, access] = await Promise.all([loadAiStoreContext(id), getThemeAccess(id)]);
    const { system, prompt } = themePrompt({
      instruction: body.instruction,
      business: store.prompt.business,
      currentTheme: store.prompt.theme,
      categories: store.prompt.categories,
      products: store.prompt.products,
      catalog: themeCatalog(),
      knownContact: store.knownContact,
    });
    const result = await runAiRequest({
      businessId: id,
      task: "theme",
      limit: store.limit,
      system,
      prompt,
      maxOutputTokens: 1024,
      accept: (value) => {
        const parsed = themeAdviceSchema.safeParse(value);
        if (!parsed.success) throw new HttpError(422, "The AI suggestion could not be used. Please try again.", "invalid_suggestion");
        return { summary: parsed.data.summary, notes: parsed.data.notes, recommendations: recommendationsWithAccess(parsed.data, access) };
      },
    });
    return ok({ ...result, source: "ai", applied: false });
  });
}
