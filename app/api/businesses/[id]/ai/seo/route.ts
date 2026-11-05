import mongoose from "mongoose";
import { z } from "zod";
import { handle, ok, readJson, HttpError } from "@/lib/api";
import { guardAiRequest } from "@/lib/ai-builder/guard";
import { runAiRequest } from "@/lib/ai-builder/request";
import { explainClaims, findUnsupportedClaims } from "@/lib/ai-builder/claims";
import { seoPrompt, type SeoPromptInput } from "@/lib/ai-builder/prompts";
import { SEO_TARGET_KINDS, seoFieldsFor, seoSuggestionSchema, seoTexts } from "@/lib/ai-builder/seo";
import { loadAiStoreContext } from "@/lib/ai-builder/store-context";
import { ProductCategory, type ProductCategoryDoc } from "@/models/ProductCategory";
import { Product, type ProductDoc } from "@/models/Product";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    kind: z.enum(SEO_TARGET_KINDS),
    targetId: z.string().regex(/^[a-f0-9]{24}$/i, "Invalid target"),
    instruction: z.string().trim().max(500).prefault(""),
  })
  .strict();

/**
 * `POST /api/businesses/[id]/ai/seo { kind, targetId, instruction? }` — asks
 * Google Gemini for search-result text for one page, product or category of
 * THIS business. Nothing is saved: the response holds the current and the
 * suggested text, and the owner edits and saves it through the normal page,
 * product or category update. Canonical URLs and the sitemap do not change.
 */
export async function POST(request: Request, context: RouteContext) {
  return handle(async () => {
    const { id } = await context.params;
    await guardAiRequest(request, id, "seo");
    const body = bodySchema.parse(await readJson(request));
    const store = await loadAiStoreContext(id);
    const business = new mongoose.Types.ObjectId(id);
    const targetId = new mongoose.Types.ObjectId(body.targetId);
    const notFound = () => new HttpError(404, "Not found", "not_found");

    let target: SeoPromptInput["target"];
    let current: { seoTitle: string; seoDescription: string; description?: string; imageAlt?: string };
    let hasImage = false;
    let extraFacts: string[] = [];
    if (body.kind === "page") {
      const page = store.pages.find((p) => String(p._id) === targetId.toHexString());
      if (!page) throw notFound();
      const seo = page as { seoTitle?: string; seoDescription?: string; description?: string };
      target = { kind: "page", title: page.title, slug: page.slug, sections: Array.isArray(page.sections) ? page.sections : [], seoTitle: seo.seoTitle ?? "", seoDescription: seo.seoDescription ?? "", description: seo.description ?? "" };
      current = { seoTitle: seo.seoTitle ?? "", seoDescription: seo.seoDescription ?? "", description: seo.description ?? "" };
    } else if (body.kind === "product") {
      const product = await Product.findOne({ _id: targetId, business, status: { $ne: "archived" } }).lean<ProductDoc>();
      if (!product) throw notFound();
      hasImage = Boolean(product.imageUrl || product.images?.[0]);
      target = {
        kind: "product",
        product: { name: product.name, category: product.category ?? "", description: product.description ?? "", options: (product.options ?? []).map((o) => ({ name: o.name, values: o.values })) },
        seoTitle: product.seoTitle ?? "",
        seoDescription: product.seoDescription ?? "",
        hasImage,
      };
      current = { seoTitle: product.seoTitle ?? "", seoDescription: product.seoDescription ?? "", imageAlt: product.imageAlt ?? "" };
      extraFacts = [product.name, product.description ?? "", JSON.stringify(product.options ?? []), String(product.price), String(product.compareAtPrice ?? "")];
    } else {
      const category = await ProductCategory.findOne({ _id: targetId, business }).lean<ProductCategoryDoc>();
      if (!category) throw notFound();
      const lower = category.name.trim().toLowerCase();
      target = {
        kind: "category",
        name: category.name,
        description: category.description ?? "",
        productNames: store.products.filter((p) => (p.category ?? "").trim().toLowerCase() === lower).map((p) => p.name),
        seoTitle: category.seoTitle ?? "",
        seoDescription: category.seoDescription ?? "",
      };
      current = { seoTitle: category.seoTitle ?? "", seoDescription: category.seoDescription ?? "", description: category.description ?? "" };
      extraFacts = [category.name, category.description ?? ""];
    }

    const { system, prompt } = seoPrompt({ instruction: body.instruction, business: store.prompt.business, target, knownContact: store.knownContact });
    const facts = [store.factsWith(body.instruction), ...extraFacts].join("\n");

    const result = await runAiRequest({
      businessId: id,
      task: "seo",
      limit: store.limit,
      system,
      prompt,
      maxOutputTokens: 1024,
      accept: (value) => {
        const parsed = seoSuggestionSchema.safeParse(value);
        if (!parsed.success) throw new HttpError(422, "The AI suggestion did not meet the length and format rules. Please try again.", "invalid_suggestion");
        const flagged = findUnsupportedClaims(seoTexts(parsed.data), facts);
        if (flagged.length > 0) {
          const examples = flagged.slice(0, 3).map((f) => `“${f}”`).join(", ");
          throw new HttpError(422, `The suggestion stated facts your store has not provided (${examples}). ${explainClaims(flagged)} Or ask again.`, "unsupported_claims");
        }
        return { suggestion: seoFieldsFor(body.kind, parsed.data, { hasImage }), summary: parsed.data.summary, notes: parsed.data.notes };
      },
    });
    return ok({ ...result, kind: body.kind, targetId: body.targetId, current, applied: false });
  });
}
