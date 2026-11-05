import mongoose from "mongoose";
import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { getEntitlements } from "@/lib/billing";
import { PRESET_LABELS, presetForBusinessType } from "@/lib/storefront-presets";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { runAiRequest } from "@/lib/ai-builder/request";
import { PRODUCT_COPY_MODES, productCopySchema, productFactsText, productPrompt, type ProductCopyMode, type ProductPromptInput } from "@/lib/ai-builder/prompts";
import { explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { knownContactOf } from "@/lib/ai-builder/sanitize";
import { Business } from "@/models/Business";
import { Product } from "@/models/Product";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    productId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid product"),
    instruction: z.string().trim().max(500).prefault(""),
    /** What to write (description, short, highlights, SEO, ...); omitted = improve. */
    mode: z.enum(Object.keys(PRODUCT_COPY_MODES) as [ProductCopyMode, ...ProductCopyMode[]]).optional(),
  })
  .strict();

/**
 * `POST /api/businesses/[id]/ai/product-copy { productId, instruction? }` —
 * asks Google Gemini for a product description (and a clearer name when
 * needed) from the product's OWN title, description, category and options
 * (never its price, stock or SKU). Nothing is saved: the owner reviews the
 * suggestion in the product form and saves it through the normal product
 * update. Text that states facts the product data does not contain is
 * refused; missing details come back as questions for the owner.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await guardAiRequest(request, id, "product");
    const body = bodySchema.parse(await readJson(request));

    const [business, product, entitlements] = await Promise.all([
      Business.findById(id).select("name category contactEmail phone address").lean<{ name: string; category: string; contactEmail?: string; phone?: string; address?: string }>(),
      // Business-scoped: another store's product is "not found".
      Product.findOne({ _id: new mongoose.Types.ObjectId(body.productId), business: new mongoose.Types.ObjectId(id), status: { $ne: "archived" } }).lean(),
      getEntitlements(id),
    ]);
    if (!business || !product) throw new HttpError(404, "Product not found", "not_found");

    const input: ProductPromptInput = {
      instruction: body.instruction,
      mode: body.mode,
      business: { name: business.name, type: PRESET_LABELS[presetForBusinessType(business.category)] },
      product: {
        name: product.name,
        category: product.category ?? "",
        description: product.description ?? "",
        options: (product.options ?? []).map((o) => ({ name: o.name, values: o.values })),
      },
      knownContact: knownContactOf(business),
    };
    const { system, prompt } = productPrompt(input);
    // Price facts stay server-side (claims check only).
    const extraFacts = [`${product.price} ${typeof product.compareAtPrice === "number" ? product.compareAtPrice : ""} ${product.currency ?? ""}`];

    const suggestion = await runAiRequest({
      businessId: id,
      task: "product",
      limit: entitlements.aiRequestsPerMonth,
      system,
      prompt,
      maxOutputTokens: 1536,
      accept: (value) => {
        const parsed = productCopySchema.safeParse(value);
        if (!parsed.success) throw new HttpError(422, "The AI suggestion could not be used. Please try again.", "invalid_suggestion");
        const flagged = findUnsupportedClaims(
          [parsed.data.name ?? "", parsed.data.description, ...parsed.data.highlights, parsed.data.seoTitle ?? "", parsed.data.seoDescription ?? ""],
          productFactsText(input, extraFacts),
        );
        if (flagged.length > 0) {
          const examples = flagged.slice(0, 3).map((f) => `“${f}”`).join(", ");
          throw new HttpError(
            422,
            `The suggestion stated details this product's information does not include (${examples}). ${explainClaims(flagged)} Or ask again.`,
            "unsupported_claims",
          );
        }
        return parsed.data;
      },
    });
    return ok({
      suggestion: {
        name: suggestion.name ?? null,
        description: suggestion.description,
        summary: suggestion.summary,
        highlights: suggestion.highlights,
        seoTitle: suggestion.seoTitle ?? null,
        seoDescription: suggestion.seoDescription ?? null,
      },
      mode: body.mode ?? "improve",
      missing: suggestion.missing,
      applied: false,
    });
  });
}
