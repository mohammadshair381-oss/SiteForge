import { z } from "zod";

/**
 * AI SEO suggestions (pure; no I/O). Suggestions are NEVER saved by the
 * server: the owner sees the current and suggested text side by side, edits
 * it, and saves it through the normal page, product or category update
 * (an explicit action). Lengths follow common search-result limits; text
 * with HTML or [[placeholders]] is refused (it would go live as written).
 */

const noHtml = (value: string) => !/<\/?[a-z][^>]*>/i.test(value);
const noPlaceholder = (value: string) => !/\[\[|\]\]/.test(value);
const text = (max: number) =>
  z.string().trim().max(max).refine(noHtml, "HTML is not supported").refine(noPlaceholder, "Placeholders are not allowed in SEO text");

/** Recommended lengths shown to the owner (search results cut longer text). */
export const SEO_LIMITS = { title: 60, titleMax: 70, description: 155, descriptionMax: 170, alt: 125, altMax: 160, pageDescriptionMax: 300 } as const;

export const SEO_TARGET_KINDS = ["page", "product", "category"] as const;
export type SeoTargetKind = (typeof SEO_TARGET_KINDS)[number];

export const seoSuggestionSchema = z
  .object({
    summary: text(240).prefault(""),
    seoTitle: text(SEO_LIMITS.titleMax).pipe(z.string().min(3, "A title is required")),
    seoDescription: text(SEO_LIMITS.descriptionMax).pipe(z.string().min(20, "A description is required")),
    /** Page description (pages) or category description (categories). */
    description: text(SEO_LIMITS.pageDescriptionMax).optional(),
    /** Main image alt text (products with an image). */
    imageAlt: text(SEO_LIMITS.altMax).optional(),
    notes: z.array(text(200)).max(5).prefault([]),
  })
  .strict();
export type SeoSuggestion = z.infer<typeof seoSuggestionSchema>;

/** Only the fields that apply to the target kind (others are dropped, never saved). */
export function seoFieldsFor(kind: SeoTargetKind, suggestion: SeoSuggestion, options: { hasImage: boolean }) {
  return {
    seoTitle: suggestion.seoTitle,
    seoDescription: suggestion.seoDescription,
    ...(kind !== "product" && suggestion.description ? { description: suggestion.description } : {}),
    ...(kind === "product" && options.hasImage && suggestion.imageAlt ? { imageAlt: suggestion.imageAlt } : {}),
  };
}

export function seoTexts(suggestion: SeoSuggestion): string[] {
  return [suggestion.seoTitle, suggestion.seoDescription, suggestion.description ?? "", suggestion.imageAlt ?? ""].filter(Boolean);
}
