"use client";

import { useState } from "react";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Eyebrow, Notice } from "@/components/ui/Surface";
import { AiNotes } from "./AiShared";

export interface ProductResult {
  productId: string;
  productName: string;
  currentDescription: string;
  suggestion: { name: string | null; description: string; summary: string; highlights?: string[]; seoTitle?: string | null; seoDescription?: string | null };
  missing: string[];
}

/**
 * A product text suggestion. Everything stays editable, and nothing is saved
 * until the owner selects Save (the normal product update). Highlights are
 * added to the description only if the owner adds them: there is no separate
 * storefront field for them.
 */
export default function AiProductResult({ businessId, result }: { businessId: string; result: ProductResult }) {
  const { suggestion } = result;
  const [description, setDescription] = useState(suggestion.description);
  const [seoTitle, setSeoTitle] = useState(suggestion.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(suggestion.seoDescription ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const highlights = suggestion.highlights ?? [];
  const hasSeo = Boolean(suggestion.seoTitle || suggestion.seoDescription);

  async function save() {
    if (result.currentDescription.trim() && !(await confirmDialog({ title: "Replace the current description?", message: `The description of ${result.productName} is replaced with this text straight away.`, confirmLabel: "Replace description" }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/products/${result.productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: description.trim(), ...(hasSeo ? { seoTitle: seoTitle.trim(), seoDescription: seoDescription.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "It could not be saved.");
      setMessage({ ok: true, text: "Saved to the product." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing was saved." });
    } finally {
      setBusy(false);
    }
  }

  const field = `mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal ${focus}`;
  return (
    <div className="space-y-4" data-ai-product="">
      <div>
        <Eyebrow>Product text</Eyebrow>
        <p className="mt-1 text-base font-semibold text-slate-900">{result.productName}</p>
        {suggestion.summary && <p className="mt-1 text-sm text-slate-600">{suggestion.summary}</p>}
        <p className="mt-1 text-xs text-slate-500">Suggested by the AI assistant from this product&apos;s own details. Edit it before saving.</p>
      </div>
      {suggestion.name && (
        <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-700">
          A clearer name could be: <span className="font-medium text-slate-900">{suggestion.name}</span> (change it in the product form).
        </p>
      )}
      <div className="rounded-xl bg-slate-50 px-3 py-2.5">
        <p className="text-xs font-medium text-slate-500">Now</p>
        <p className="mt-0.5 whitespace-pre-line break-words text-sm text-slate-600">{result.currentDescription.trim() || "(no description)"}</p>
      </div>
      <label className="block text-sm font-medium text-slate-900">
        Suggested description
        <textarea rows={6} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} className={field} />
      </label>
      {highlights.length > 0 && (
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="text-sm font-medium text-slate-900">Highlights</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-slate-800">
            {highlights.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <Button
            variant="secondary"
            className="mt-2"
            onClick={() => setDescription((d) => `${d.trim()}\n\n${highlights.map((h) => `- ${h}`).join("\n")}`)}
          >
            Add highlights to the description
          </Button>
        </div>
      )}
      {hasSeo && (
        <div className="grid gap-3">
          <label className="block text-sm font-medium text-slate-900">
            Search title
            <input value={seoTitle} maxLength={70} onChange={(e) => setSeoTitle(e.target.value)} className={`min-h-10 ${field}`} />
          </label>
          <label className="block text-sm font-medium text-slate-900">
            Search description
            <textarea rows={2} maxLength={170} value={seoDescription} onChange={(e) => setSeoDescription(e.target.value)} className={field} />
          </label>
        </div>
      )}
      <AiNotes notes={result.missing} title="Details to add for a better description:" />
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || !description.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save to product"}
        </Button>
        <span className="text-xs text-slate-500">Nothing is saved until you select this.</span>
      </div>
    </div>
  );
}
