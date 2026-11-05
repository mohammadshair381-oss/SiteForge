import { z } from "zod";

/**
 * Product variant rules shared by the API, the dashboard and the storefront
 * (pure; no I/O). A product either has no options (a simple product, the
 * existing behaviour) or 1-3 options, e.g. Size / Color / Material / Storage,
 * and one variant per offered combination. Each variant may override the
 * price and has its own SKU and stock. Variants are archived, never removed.
 */

export const MAX_OPTIONS = 3;
export const MAX_OPTION_VALUES = 30;
export const MAX_VARIANTS = 100;

const noHtml = (value: string) => !/[<>]/.test(value);
const optionText = (max: number) =>
  z.string().trim().min(1).max(max).refine(noHtml, "Use plain text");

export const productOptionsSchema = z
  .array(
    z.object({
      name: optionText(40),
      values: z.array(optionText(60)).min(1).max(MAX_OPTION_VALUES),
    }),
  )
  .max(MAX_OPTIONS)
  .superRefine((options, ctx) => {
    const names = new Set<string>();
    options.forEach((option, index) => {
      const key = option.name.toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: "custom", message: "Each option name can be used once", path: [index, "name"] });
      names.add(key);
      const values = new Set<string>();
      option.values.forEach((value, valueIndex) => {
        const v = value.toLowerCase();
        if (values.has(v)) ctx.addIssue({ code: "custom", message: "Each value can be used once", path: [index, "values", valueIndex] });
        values.add(v);
      });
    });
  });

const moneySchema = z.preprocess(
  (value) => (value === "" || value === undefined ? null : typeof value === "string" ? Number(value) : value),
  z.number().min(0).max(1_000_000).nullable(),
);

export const productVariantInputSchema = z.object({
  /** Existing variant id; absent for a new variant. */
  id: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  /** Option name -> value. */
  options: z.record(z.string().max(40), z.string().max(60)),
  sku: z.string().trim().max(80).prefault(""),
  price: moneySchema.prefault(null),
  compareAtPrice: moneySchema.prefault(null),
  /** Initial stock for a NEW variant only; existing stock changes use stock adjustments. */
  stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  archived: z.boolean().prefault(false),
  /** Its own picture, from the store's media. Empty = the product's images. */
  imageUrl: z.string().trim().max(2048).refine((v) => v === "" || /^(https:\/\/|\/)/.test(v), "Use an image from your media library").prefault(""),
});
export type ProductVariantInput = z.infer<typeof productVariantInputSchema>;

export const productVariantsInputSchema = z.array(productVariantInputSchema).max(MAX_VARIANTS);

export interface VariantLike {
  _id?: unknown;
  id?: string;
  options: Array<{ name: string; value: string }>;
  price?: number | null;
  compareAtPrice?: number | null;
  archived?: boolean;
}

export function variantId(variant: { _id?: unknown; id?: string }): string {
  return String(variant.id ?? variant._id ?? "");
}

/** "Size: M / Color: Red" — the label stored on cart and order lines. */
export function variantLabel(options: Array<{ name: string; value: string }>): string {
  return options.map((o) => `${o.name}: ${o.value}`).join(" / ");
}

/** The price a variant sells at (its own price, else the product price). */
export function effectivePrice(productPrice: number, variant?: { price?: number | null } | null): number {
  return variant && typeof variant.price === "number" ? variant.price : productPrice;
}

/** A valid compare-at price for a variant (falls back to the product's). */
export function effectiveCompareAt(
  product: { price: number; compareAtPrice?: number | null },
  variant?: { price?: number | null; compareAtPrice?: number | null } | null,
): number | null {
  const price = effectivePrice(product.price, variant);
  const compare = variant && typeof variant.compareAtPrice === "number" ? variant.compareAtPrice : variant && typeof variant.price === "number" ? null : product.compareAtPrice ?? null;
  return typeof compare === "number" && compare > price ? compare : null;
}

/**
 * Normalises variant inputs against the options: every variant must have
 * exactly one listed value per option, combinations must be unique, and a
 * compare-at price must be higher than the selling price. Returns the
 * options in canonical order per variant, or a list of problems.
 */
export function normalizeVariants(
  options: Array<{ name: string; values: string[] }>,
  variants: ProductVariantInput[],
  productPrice: number,
): { ok: true; variants: Array<ProductVariantInput & { optionList: Array<{ name: string; value: string }> }> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (options.length === 0 && variants.length > 0) errors.push("Add at least one option before adding variants");
  if (options.length > 0 && variants.filter((v) => !v.archived).length === 0) errors.push("Add at least one variant for the options");
  const seen = new Set<string>();
  const out: Array<ProductVariantInput & { optionList: Array<{ name: string; value: string }> }> = [];
  variants.forEach((variant, index) => {
    const keys = Object.keys(variant.options);
    const optionList: Array<{ name: string; value: string }> = [];
    for (const option of options) {
      const key = keys.find((k) => k.toLowerCase() === option.name.toLowerCase());
      const raw = key ? variant.options[key] : undefined;
      const value = option.values.find((v) => v.toLowerCase() === String(raw ?? "").trim().toLowerCase());
      if (!value) {
        errors.push(`Variant ${index + 1}: choose a ${option.name}`);
        continue;
      }
      optionList.push({ name: option.name, value });
    }
    if (keys.length !== options.length) errors.push(`Variant ${index + 1}: use exactly the product options`);
    const combo = optionList.map((o) => o.value.toLowerCase()).join("\u0000");
    if (seen.has(combo)) errors.push(`Variant ${index + 1}: this combination already exists`);
    seen.add(combo);
    const price = effectivePrice(productPrice, variant);
    if (typeof variant.compareAtPrice === "number" && !(variant.compareAtPrice > price)) {
      errors.push(`Variant ${index + 1}: the original price must be higher than the price`);
    }
    out.push({ ...variant, optionList });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, variants: out };
}

/** Lowest and highest selling price across purchasable variants. */
export function priceRange(productPrice: number, variants: VariantLike[]): { min: number; max: number } {
  const prices = variants.filter((v) => !v.archived).map((v) => effectivePrice(productPrice, v));
  if (prices.length === 0) return { min: productPrice, max: productPrice };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
