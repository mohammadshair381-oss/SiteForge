import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { getThemeMeta } from "@/lib/themes";
import { readShippingSettings } from "@/lib/checkout-pricing";
import { HOME_SECTION_ID_PATTERN } from "@/lib/storefront-config";
import { PRESET_LABELS, presetForBusinessType } from "@/lib/storefront-presets";
import { loadStorefrontPreviewData } from "@/lib/storefront-preview-data";
import { knownContactOf } from "@/lib/ai-builder/sanitize";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { runAiRequest } from "@/lib/ai-builder/request";
import { instructionSchema, storefrontFactsText, storefrontPrompt, type StorefrontPromptInput } from "@/lib/ai-builder/prompts";
import { storefrontChangeSetSchema } from "@/lib/ai-builder/storefront-changes";
import { createStorefrontProposal, currentStorefrontState } from "@/lib/ai-builder/storefront-proposals";
import { proposalView } from "@/lib/ai-planning/proposal-service";
import type { ThemeId } from "@/lib/constants";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    instruction: instructionSchema,
    /** The section selected in the editor (context only). */
    selectedSectionId: z.string().regex(HOME_SECTION_ID_PATTERN).nullable().optional(),
  })
  .strict();

/**
 * `POST /api/businesses/[id]/ai/storefront { instruction, selectedSectionId? }`
 * — asks Google Gemini for homepage changes and stores them as a PENDING
 * change proposal (target "storefront"). Nothing on the store changes: the
 * owner previews, approves and applies it to the draft through the proposal
 * routes, and publishes separately.
 *
 * Guards: lib/ai-builder/guard.ts (same-origin, owner/manager, verified email,
 * kill switch, consent, rate limits); then lib/ai-builder/request.ts (consent
 * again, data check, monthly allowance, outcome record). Only sanitized,
 * approved data is sent (lib/ai-builder/sanitize.ts).
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    const { user } = await guardAiRequest(request, id, "storefront");
    const body = bodySchema.parse(await readJson(request));

    const data = await loadStorefrontPreviewData(id);
    if (!data) throw new HttpError(404, "Business not found", "not_found");
    const base = await currentStorefrontState(id);
    const business = data.business;
    const input: StorefrontPromptInput = {
      instruction: body.instruction,
      business: { name: business.name, type: PRESET_LABELS[presetForBusinessType(business.category)], description: business.description ?? "" },
      theme: { id: business.themeId, name: getThemeMeta(business.themeId as ThemeId).name },
      brand: base.brand,
      homepage: base.config,
      selectedSectionId: body.selectedSectionId ?? null,
      products: data.products.map((p) => ({ name: p.name, category: p.category ?? "" })),
      links: data.linkOptions.map((o) => o.href),
      knownContact: knownContactOf(business),
    };
    // Facts the generated text may restate. Server-side only (claims check):
    // none of this is sent to the provider.
    const shipping = business.shippingSettings ? readShippingSettings(business.shippingSettings) : null;
    const extraFacts = [
      ...data.products.slice(0, 200).map((p) => `${p.name} ${p.category ?? ""} ${p.price} ${p.compareAtPrice ?? ""} ${(p.description ?? "").slice(0, 400)}`),
      base.config.policies.shipping,
      base.config.policies.returns,
      business.address ?? "",
      ...(shipping?.enabled && shipping.freeOver !== null ? [`free delivery free shipping on orders over ${shipping.freeOver}`] : []),
      ...(shipping?.enabled && shipping.flatRate === 0 ? ["free delivery free shipping"] : []),
    ];

    const { system, prompt } = storefrontPrompt(input);
    const result = await runAiRequest({
      businessId: id,
      task: "storefront",
      limit: data.entitlements.aiRequestsPerMonth,
      system,
      prompt,
      maxOutputTokens: 4096,
      accept: async (value) => {
        const parsed = storefrontChangeSetSchema.safeParse(value);
        if (!parsed.success) {
          throw new HttpError(422, "The AI suggestion did not match what your homepage supports. Try rephrasing your request.", "invalid_suggestion");
        }
        if (parsed.data.changes.length === 0) {
          // A valid answer that changes nothing: the assistant explains why.
          return { proposal: null, message: parsed.data.summary, notes: parsed.data.notes };
        }
        const doc = await createStorefrontProposal({
          businessId: id,
          actorId: String(user._id),
          source: "ai",
          request: body.instruction,
          changeSet: parsed.data,
          facts: storefrontFactsText(input, extraFacts),
          base,
        });
        return { proposal: proposalView(doc), message: null, notes: parsed.data.notes };
      },
    });
    return ok(result, { status: result.proposal ? 201 : 200 });
  });
}
