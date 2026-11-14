"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { publishVariantImage } from "@/lib/variant-image-event";
import type { StorefrontVariant } from "@/lib/storefront";
import { formatPrice } from "@/lib/format";
import AddToCartButton from "@/components/storefront/AddToCartButton";

/**
 * Option selection for a variant product: one radio group per option. Values
 * with no purchasable variant for the current choice are marked unavailable.
 * The server validates the chosen variant again when it is added and at
 * checkout; this component only helps the shopper pick.
 */
export default function VariantPicker({
  businessId,
  productId,
  options,
  variants,
  currency,
  color,
  priceClass,
  mutedClass,
  badgeStyle,
  buttonClass,
  inputClass,
}: {
  businessId: string;
  productId: string;
  options: Array<{ name: string; values: string[] }>;
  variants: StorefrontVariant[];
  currency: string;
  color: string;
  priceClass: string;
  mutedClass: string;
  badgeStyle: React.CSSProperties;
  /** The theme's add-to-cart button style (styling only). */
  buttonClass?: string;
  inputClass?: string;
}) {
  // Start with the first variant that can be bought (or the first variant).
  const initial = variants.find((v) => v.availability !== "out_of_stock") ?? variants[0];
  const [selected, setSelected] = useState<Record<string, string>>(
    () => Object.fromEntries((initial?.options ?? []).map((o) => [o.name, o.value])),
  );

  const match = useMemo(
    () => variants.find((v) => v.options.every((o) => selected[o.name] === o.value)) ?? null,
    [variants, selected],
  );

  /** Is there any variant with this value, given the other current choices? */
  function exists(optionName: string, value: string): { any: boolean; buyable: boolean } {
    const candidates = variants.filter((v) =>
      v.options.every((o) => (o.name === optionName ? o.value === value : selected[o.name] === undefined || selected[o.name] === o.value)),
    );
    return { any: candidates.length > 0, buyable: candidates.some((v) => v.availability !== "out_of_stock") };
  }

  // The theme's images follow the choice, when this variant has a picture of its own.
  const rootRef = useRef<HTMLDivElement>(null);
  const matchedImage = match?.imageUrl ?? "";
  useEffect(() => {
    const target = rootRef.current?.ownerDocument;
    if (target) publishVariantImage(target, productId, matchedImage);
  }, [productId, matchedImage]);

  const discount =
    match && typeof match.compareAtPrice === "number" && match.compareAtPrice > match.price
      ? Math.round(((match.compareAtPrice - match.price) / match.compareAtPrice) * 100)
      : null;

  return (
    <div ref={rootRef}>
      <p className="flex flex-wrap items-baseline gap-3" aria-live="polite">
        <span className={`text-3xl ${priceClass}`}>{match ? formatPrice(match.price, currency) : "—"}</span>
        {match && discount !== null && (
          <>
            <span className={`text-lg line-through ${mutedClass}`}>
              <span className="sr-only">Original price </span>
              {formatPrice(match.compareAtPrice as number, currency)}
            </span>
            <span className="rounded-full px-2 py-0.5 text-sm font-bold" style={badgeStyle}>Save {discount}%</span>
          </>
        )}
      </p>

      <div className="mt-6 space-y-5">
        {options.map((option) => (
          <fieldset key={option.name}>
            <legend className="text-sm font-semibold">
              {option.name}
              {selected[option.name] && <span className={`font-normal ${mutedClass}`}>: {selected[option.name]}</span>}
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {option.values.map((value) => {
                const state = exists(option.name, value);
                if (!state.any && !variants.some((v) => v.options.some((o) => o.name === option.name && o.value === value))) return null;
                const checked = selected[option.name] === value;
                const id = `opt-${option.name}-${value}`.replace(/[^A-Za-z0-9-]/g, "_");
                return (
                  <label
                    key={value}
                    htmlFor={id}
                    className={`relative inline-flex min-h-11 cursor-pointer items-center rounded-lg border px-3.5 py-2 text-sm font-medium transition focus-within:ring-2 focus-within:ring-offset-2 ${
                      checked ? "border-current" : "border-current/30 opacity-90"
                    } ${!state.buyable ? "line-through opacity-50" : ""}`}
                    style={checked ? { borderColor: color, boxShadow: `inset 0 0 0 1px ${color}` } : undefined}
                  >
                    <input
                      id={id}
                      type="radio"
                      name={`option-${option.name}`}
                      value={value}
                      checked={checked}
                      onChange={() => setSelected((current) => ({ ...current, [option.name]: value }))}
                      className="sr-only"
                    />
                    {value}
                    {!state.buyable && <span className="sr-only"> (unavailable)</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <p className={`mt-4 text-sm font-medium ${mutedClass}`} aria-live="polite">
        {!match
          ? "This combination is not available. Try a different choice."
          : match.availability === "out_of_stock"
            ? `${match.label} is out of stock`
            : match.availability === "low_stock"
              ? `${match.label}: in stock — only a few left`
              : `${match.label}: in stock`}
      </p>
      {match?.sku && <p className={`mt-1 text-xs ${mutedClass}`}>SKU {match.sku}</p>}

      <div className="mt-6">
        {match ? (
          <AddToCartButton
            key={match.id}
            businessId={businessId}
            productId={productId}
            variantId={match.id}
            inStock={match.availability !== "out_of_stock"}
            color={color}
            buttonClass={buttonClass}
            inputClass={inputClass}
          />
        ) : (
          <p className="rounded-xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-600">Choose another combination</p>
        )}
      </div>
    </div>
  );
}
