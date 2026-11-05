import mongoose from "mongoose";
import { handle, ok, HttpError, readJson } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { planVisibleTexts } from "@/lib/ai-builder/page-builder";
import { planningPrompt } from "@/lib/ai-builder/prompts";
import { runAiRequest } from "@/lib/ai-builder/request";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import { websitePlanSchema } from "@/lib/ai-planning/plan";
import { recordAiPlanGeneration } from "@/lib/ai-planning/plan-provenance";
import { THEME_IDS } from "@/lib/constants";
import { enforceRateLimit, getClientIp } from "@/lib/rate-limit";
import { Product } from "@/models/Product";
import { z } from "zod";

/** Burst limit per business and client address (unchanged). */
const GEMINI_GENERATE_WINDOW_MS = 15 * 60 * 1000;
const GEMINI_GENERATE_MAX_PER_IP = 10;
/** Usage limits: per member, and a daily cap per business across all members. */
const GENERATE_PER_USER_WINDOW_MS = 60 * 60 * 1000;
const GENERATE_PER_USER_MAX = 10;
const GENERATE_PER_BUSINESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const GENERATE_PER_BUSINESS_DAILY_MAX = 20;

const generateRequestSchema = z.object({
  businessSummary: z.string().trim().min(1).max(2000),
  targetAudience: z.string().trim().min(1).max(500),
  requestedPageCount: z.number().int().min(1).max(50),
  pages: z.array(z.object({
    title: z.string().trim().min(1).max(140),
    purpose: z.string().trim().min(1).max(600),
    requiredContent: z.string().trim().max(4000).prefault(""),
  })).min(1).max(50),
  preferredTheme: z.enum(THEME_IDS),
  designPreferences: z.object({
    notes: z.string().trim().max(1000).prefault(""),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    font: z.enum(["sans", "serif", "mono"]).optional(),
  }),
  productIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(100).prefault([]),
  specialRequirements: z.string().trim().max(2000).prefault(""),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * `POST /api/businesses/[id]/planning/generate` asks the AI provider for a website PLAN. The plan
 * is only returned for review: nothing is saved, applied or published here.
 *
 * No screen calls this any more: whole websites come from the AI Builder (lib/ai-website), and the
 * planner hands its brief over to it. Kept for existing API clients. New work belongs there.
 *
 * It takes the same path as every AI task: `guardAiRequest` (same origin, owner or manager, verified
 * email, kill switch, not suspended, the owner's consent, the shared limits), then this route's own
 * limits and the tenant check on products, then `runAiRequest` (consent again, data check, monthly
 * allowance, outcome). The prompt holds only what the owner typed, as delimited data. A plan that
 * does not match the schema, or that states facts the store has not provided, is refused. The server
 * remembers fingerprints of an accepted plan, so edits to it are recognised when it is saved.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await guardAiRequest(request, id, "planning");

    const ip = getClientIp(request);
    await enforceRateLimit({
      key: `planning:generate:${id}:${ip}`,
      windowMs: GEMINI_GENERATE_WINDOW_MS,
      limit: GEMINI_GENERATE_MAX_PER_IP,
    });
    await enforceRateLimit({
      key: `planning:generate:user:${String(user._id)}`,
      windowMs: GENERATE_PER_USER_WINDOW_MS,
      limit: GENERATE_PER_USER_MAX,
    });
    await enforceRateLimit({
      key: `planning:generate:business:${id}`,
      windowMs: GENERATE_PER_BUSINESS_WINDOW_MS,
      limit: GENERATE_PER_BUSINESS_DAILY_MAX,
    });

    const body = generateRequestSchema.parse(await readJson(request));

    // Tenant isolation: a plan may only reference this business's products.
    if (body.productIds.length > 0) {
      const ids = [...new Set(body.productIds)];
      const owned = await Product.countDocuments({
        _id: { $in: ids.map((value) => new mongoose.Types.ObjectId(value)) },
        business: new mongoose.Types.ObjectId(id),
      });
      if (owned !== ids.length) {
        throw new HttpError(422, "One or more products do not belong to this business.", "invalid_product_reference");
      }
    }

    const store = await loadAiStoreContext(id);
    const { system, prompt } = planningPrompt({ ...body, knownContact: store.knownContact });
    const facts = store.factsWith(JSON.stringify(body));

    const plan = await runAiRequest({
      businessId: id,
      task: "planning",
      limit: store.limit,
      system,
      prompt,
      // Room for a multi-page plan; truncation is still detected.
      maxOutputTokens: 8192,
      subject: "AI planning",
      advice: "Please try manual planning.",
      accept: async (value) => {
        const parsed = websitePlanSchema.safeParse(value);
        if (!parsed.success) throw new HttpError(422, "AI planning returned an invalid plan. Please try manual planning.", "invalid_plan");
        const flagged = findUnsupportedClaims(planVisibleTexts(parsed.data), facts);
        if (flagged.length > 0) {
          const examples = flagged.slice(0, 3).map((f) => `“${f}”`).join(", ");
          throw new HttpError(422, `The plan stated facts your store has not provided (${examples}). ${explainClaims(flagged)} Or add those details to your brief.`, "unsupported_claims");
        }
        await recordAiPlanGeneration({
          businessId: id,
          actorId: String(user._id),
          plan: parsed.data,
          brief: [body.businessSummary, body.targetAudience, body.specialRequirements, body.designPreferences.notes, ...body.pages.flatMap((page) => [page.title, page.purpose, page.requiredContent])].join("\n"),
        });
        // A plan only adds new draft pages, and its products are the ones the owner chose.
        return {
          ...parsed.data,
          productIds: body.productIds,
          pages: parsed.data.pages.map(({ existingPageId: _existingPageId, expectedVersion: _expectedVersion, ...page }) => page),
        };
      },
    });

    return ok({
      plan,
      ai: {
        available: true,
        reason: null,
      },
      review: {
        validated: false,
        saved: false,
        applied: false,
        message: "AI-generated plan is ready for review. Validate and approve before applying.",
      },
    });
  });
}
