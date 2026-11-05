"use client";

import Link from "next/link";
import { useState } from "react";
import ManagementPageHeader from "./ManagementPageHeader";
import { apiErrorFrom, fieldErrorId, invalidProps } from "@/lib/api-errors";
import { formatPrice } from "@/lib/format";
import { MAX_OPTIONS, variantLabel } from "@/lib/product-variants";
import { LOW_STOCK_DEFAULT } from "@/lib/inventory-rules";
import { Button } from "@/components/ui/Button";
import { Card, Pill } from "@/components/ui/Surface";
import { FieldError, inputClass, labelClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import MediaPicker from "./MediaPicker";

const removeButtonClass =
  "inline-flex min-h-10 items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2";

interface OptionDraft {
  name: string;
  /** Comma-separated while editing. */
  values: string;
}

interface VariantDraft {
  id?: string;
  options: Record<string, string>;
  sku: string;
  price: string;
  compareAtPrice: string;
  /** Existing variants: current stock (read-only here). New: initial stock. */
  stock: string;
  archived: boolean;
  isNew: boolean;
  imageUrl: string;
}

export interface VariantEditorProduct {
  id: string;
  name: string;
  price: number;
  currency: string;
  lowStockThreshold: number | null;
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{ id: string; options: Array<{ name: string; value: string }>; sku: string; price: number | null; compareAtPrice: number | null; stock: number; archived: boolean; imageUrl?: string }>;
}

function parseValues(text: string): string[] {
  return [...new Set(text.split(",").map((v) => v.trim()).filter(Boolean))];
}

/**
 * Options (Size, Color, Material, Storage, …) and variants of one product,
 * plus its low-stock alert level. Saves through the product API, which
 * validates everything again. Stock of existing variants is changed on the
 * Inventory page (recorded adjustments), never here.
 */
export default function VariantEditor({ businessId, product }: { businessId: string; product: VariantEditorProduct }) {
  const [options, setOptions] = useState<OptionDraft[]>(product.options.map((o) => ({ name: o.name, values: o.values.join(", ") })));
  const [variants, setVariants] = useState<VariantDraft[]>(
    product.variants.map((v) => ({
      id: v.id,
      options: Object.fromEntries(v.options.map((o) => [o.name, o.value])),
      sku: v.sku,
      price: v.price === null ? "" : String(v.price),
      compareAtPrice: v.compareAtPrice === null ? "" : String(v.compareAtPrice),
      stock: String(v.stock),
      archived: v.archived,
      isNew: false,
      imageUrl: v.imageUrl ?? "",
    })),
  );
  const [threshold, setThreshold] = useState(product.lowStockThreshold === null ? "" : String(product.lowStockThreshold));
  const [status, setStatus] = useState<{ kind: "idle" | "busy" | "ok" | "error"; text: string }>({ kind: "idle", text: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const check = (name: string) => invalidProps(fieldErrors, name, "variant");
  const errorFor = (name: string) => <FieldError id={fieldErrorId("variant", name)} message={fieldErrors[name]} />;
  const hadVariants = product.options.length > 0;
  const parsedOptions = options.map((o) => ({ name: o.name.trim(), values: parseValues(o.values) })).filter((o) => o.name);

  function generate() {
    if (parsedOptions.length === 0) return;
    const combos = parsedOptions.reduce<Array<Record<string, string>>>(
      (acc, option) => acc.flatMap((combo) => option.values.map((value) => ({ ...combo, [option.name]: value }))),
      [{}],
    );
    const key = (o: Record<string, string>) => parsedOptions.map((p) => (o[p.name] ?? "").toLowerCase()).join("|");
    const existing = new Set(variants.map((v) => key(v.options)));
    const fresh = combos.filter((c) => !existing.has(key(c))).map((c) => ({ options: c, sku: "", price: "", compareAtPrice: "", stock: "0", archived: false, isNew: true, imageUrl: "" }));
    setVariants((current) => [...current, ...fresh].slice(0, 100));
  }

  async function save() {
    setStatus({ kind: "busy", text: "Saving…" });
    setFieldErrors({});
    const body: Record<string, unknown> = {
      lowStockThreshold: threshold === "" ? null : Number(threshold),
    };
    if (parsedOptions.length > 0 || hadVariants) {
      body.options = parsedOptions;
      body.variants = variants.map((v) => ({
        ...(v.id ? { id: v.id } : {}),
        options: Object.fromEntries(parsedOptions.map((o) => [o.name, v.options[o.name] ?? ""])),
        sku: v.sku,
        price: v.price === "" ? null : Number(v.price),
        compareAtPrice: v.compareAtPrice === "" ? null : Number(v.compareAtPrice),
        ...(v.isNew ? { stock: Number(v.stock || 0) } : {}),
        archived: v.archived,
        imageUrl: v.imageUrl,
      }));
    }
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const info = apiErrorFrom(data, "Could not save.");
        setFieldErrors(info.fields);
        setStatus({ kind: "error", text: info.message });
        return;
      }
      const saved = data.product as { variants?: Array<{ _id: string; options: Array<{ name: string; value: string }>; sku: string; price: number | null; compareAtPrice: number | null; stock: number; archived: boolean; imageUrl?: string }> };
      setVariants(
        (saved.variants ?? []).map((v) => ({
          id: String(v._id),
          options: Object.fromEntries(v.options.map((o) => [o.name, o.value])),
          sku: v.sku ?? "",
          price: v.price === null ? "" : String(v.price),
          compareAtPrice: v.compareAtPrice === null ? "" : String(v.compareAtPrice),
          stock: String(v.stock),
          archived: Boolean(v.archived),
          isNew: false,
          imageUrl: v.imageUrl ?? "",
        })),
      );
      setStatus({ kind: "ok", text: "Saved." });
    } catch {
      setStatus({ kind: "error", text: "Network error. Nothing was saved." });
    }
  }

  const base = `/dashboard/businesses/${businessId}`;
  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title={`Options and variants: ${product.name}`}
        description="Offer sizes, colours, materials or other choices. Each variant has its own SKU, optional price and its own stock. Variants that were sold are archived, never deleted."
        action={{ href: `${base}/products`, label: "Back to products" }}
      />

      <Card as="section" className="p-5 sm:p-6" aria-labelledby="ve-options">
        <h2 id="ve-options" className="text-lg font-semibold text-slate-900">Options</h2>
        <p className="mt-1 text-sm text-slate-600">Up to {MAX_OPTIONS} options. Separate values with commas.</p>
        {options.length === 0 && (
          <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
            This product is sold as one item for now. Add an option such as Size or Colour to offer choices.
          </p>
        )}
        <div className="mt-4 space-y-4">
          {options.map((option, index) => {
            // The server's list leaves out options with no name yet.
            const sent = options.slice(0, index).filter((o) => o.name.trim()).length;
            return (
            <div key={index} className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end sm:border-0 sm:p-0">
              <label className="block text-sm font-medium text-slate-800">
                Option name
                <input value={option.name} maxLength={40} placeholder="Size" onChange={(e) => setOptions((o) => o.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)))} className={`mt-1.5 ${inputClass}`} {...check(`options.${sent}.name`)} />
                {errorFor(`options.${sent}.name`)}
              </label>
              <label className="block text-sm font-medium text-slate-800">
                Values
                <input value={option.values} placeholder="S, M, L" onChange={(e) => setOptions((o) => o.map((x, i) => (i === index ? { ...x, values: e.target.value } : x)))} className={`mt-1.5 ${inputClass}`} {...check(`options.${sent}.values`)} />
                {errorFor(`options.${sent}.values`)}
              </label>
              <button type="button" onClick={() => setOptions((o) => o.filter((_, i) => i !== index))} className={removeButtonClass}>
                Remove
              </button>
            </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={options.length >= MAX_OPTIONS} onClick={() => setOptions((o) => [...o, { name: "", values: "" }])}>
            <Icon name="plus" size={16} />
            Add option
          </Button>
          <Button variant="secondary" disabled={parsedOptions.length === 0} onClick={generate}>
            Create missing variants
          </Button>
        </div>
      </Card>

      {variants.length > 0 && (
        <Card as="section" aria-labelledby="ve-variants">
          <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
            <h2 id="ve-variants" className="text-lg font-semibold text-slate-900">Variants</h2>
            <p className="mt-1 text-sm text-slate-600">Leave the price empty to use the product price, and the image empty to use the product&apos;s images. Change the stock of an existing variant on the Inventory page, so the change is recorded.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium sm:pl-6">Variant</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Image</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">SKU</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Price ({product.currency})</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Original price</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Stock</th>
                  <th scope="col" className="px-4 py-2.5 font-medium sm:pr-6">For sale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {variants.map((v, index) => {
                  const label = variantLabel(parsedOptions.map((o) => ({ name: o.name, value: v.options[o.name] ?? "?" })));
                  const update = (patch: Partial<VariantDraft>) => setVariants((all) => all.map((x, i) => (i === index ? { ...x, ...patch } : x)));
                  return (
                    <tr key={v.id ?? `new-${index}`} className={v.archived ? "bg-slate-50 text-slate-500" : ""}>
                      <th scope="row" className="px-4 py-2.5 text-left font-medium sm:pl-6">
                        {label}
                        {v.isNew && <Pill tone="ember" className="ml-2">new</Pill>}
                      </th>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {v.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={v.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg border border-slate-200 object-cover" />
                          )}
                          <MediaPicker businessId={businessId} selectedUrl={v.imageUrl} allowClear contextLabel={`image for ${label}`} onSelect={(media) => update({ imageUrl: media?.url ?? "" })} />
                        </div>
                        {errorFor(`variants.${index}.imageUrl`)}
                      </td>
                      <td className="px-4 py-2.5"><input aria-label={`SKU for ${label}`} value={v.sku} maxLength={80} onChange={(e) => update({ sku: e.target.value })} className={inputClass} {...check(`variants.${index}.sku`)} />{errorFor(`variants.${index}.sku`)}</td>
                      <td className="px-4 py-2.5"><input aria-label={`Price for ${label}`} type="number" min={0} step="0.01" value={v.price} placeholder={formatPrice(product.price, product.currency)} onChange={(e) => update({ price: e.target.value })} className={inputClass} {...check(`variants.${index}.price`)} />{errorFor(`variants.${index}.price`)}</td>
                      <td className="px-4 py-2.5"><input aria-label={`Original price for ${label}`} type="number" min={0} step="0.01" value={v.compareAtPrice} onChange={(e) => update({ compareAtPrice: e.target.value })} className={inputClass} {...check(`variants.${index}.compareAtPrice`)} />{errorFor(`variants.${index}.compareAtPrice`)}</td>
                      <td className="px-4 py-2.5">
                        {v.isNew ? (
                          <>
                            <input aria-label={`Initial stock for ${label}`} type="number" min={0} step={1} value={v.stock} onChange={(e) => update({ stock: e.target.value })} className={inputClass} {...check(`variants.${index}.stock`)} />
                            {errorFor(`variants.${index}.stock`)}
                          </>
                        ) : (
                          <span className="whitespace-nowrap tabular-nums">
                            {v.stock}{" "}
                            <Link href={`${base}/inventory`} className="ml-1 text-xs font-semibold text-brand-700 underline">Adjust</Link>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 sm:pr-6">
                        {v.isNew ? (
                          <button type="button" onClick={() => setVariants((all) => all.filter((_, i) => i !== index))} className={removeButtonClass}>Remove</button>
                        ) : (
                          <label className="inline-flex min-h-10 items-center gap-2">
                            <input type="checkbox" checked={!v.archived} onChange={(e) => update({ archived: !e.target.checked })} className="h-4 w-4" /> Selling
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card as="section" className="p-5 sm:p-6" aria-labelledby="ve-alert">
        <h2 id="ve-alert" className="text-lg font-semibold text-slate-900">Low-stock alert</h2>
        <label className={`mt-3 max-w-xs ${labelClass}`}>
          Warn at or below
          <input type="number" min={0} step={1} value={threshold} placeholder={String(LOW_STOCK_DEFAULT)} onChange={(e) => setThreshold(e.target.value)} className={`mt-1.5 ${inputClass}`} {...check("lowStockThreshold")} />
          {errorFor("lowStockThreshold")}
        </label>
        <p className="mt-1 text-xs text-slate-500">Shoppers only ever see “Only a few left”, never the number.</p>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={status.kind === "busy"}>
          Save
        </Button>
        <p role="status" aria-live="polite" className={`text-sm ${status.kind === "error" ? "text-red-700" : status.kind === "ok" ? "text-emerald-700" : "text-slate-600"}`}>{status.text}</p>
      </div>
    </div>
  );
}
