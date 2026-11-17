"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Notice, Pill } from "@/components/ui/Surface";

const MODES: Array<{ value: string; label: string }> = [
  { value: "improve", label: "Improve the description" },
  { value: "long", label: "Longer description" },
  { value: "short", label: "Shorter description" },
  { value: "premium", label: "More premium tone" },
  { value: "professional", label: "More professional tone" },
  { value: "highlights", label: "Highlights and features" },
  { value: "seo", label: "SEO title and description" },
  { value: "grammar", label: "Fix grammar and spelling" },
];

/**
 * AI help for one product's description, shown in the product edit form.
 * The suggestion is built from the product's OWN details; nothing is saved
 * until the owner uses it and saves the form (the normal product update).
 * When no AI provider is enabled, it only says so.
 */
export default function ProductCopyAssistant({
  businessId,
  productId,
  aiState,
  disabled,
  onUse,
}: {
  businessId: string;
  productId: string;
  /** Platform AI and this store's consent (server-decided). */
  aiState: "off" | "needs_consent" | "on";
  disabled?: boolean;
  onUse: (copy: { description: string; name: string | null; seoTitle: string | null; seoDescription: string | null }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState("improve");
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<{ description: string; name: string | null; summary: string; highlights: string[]; seoTitle: string | null; seoDescription: string | null; missing: string[] } | null>(null);

  if (aiState === "off") {
    return <p className="mt-2 text-xs text-slate-500">AI writing help is not available for this store right now.</p>;
  }
  if (aiState === "needs_consent") {
    return <p className="mt-2 text-xs text-slate-500">AI writing help is available once the store owner turns on AI suggestions in Business settings.</p>;
  }

  async function suggest() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/ai/product-copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, mode, instruction: instruction.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No suggestion this time. Please try again.");
      setResult({ highlights: [], seoTitle: null, seoDescription: null, ...data.suggestion, missing: data.missing ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Nothing was sent.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          AI writing help
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={busy || disabled} className={`mt-1 ${inputClass}`}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-700">
          Anything specific? (optional)
          <input value={instruction} maxLength={500} onChange={(e) => setInstruction(e.target.value)} disabled={busy || disabled} placeholder="For example: mention it comes in three sizes" className={`mt-1 ${inputClass}`} />
        </label>
      </div>
      <Button variant="secondary" onClick={() => void suggest()} disabled={busy || disabled}>
        <Icon name="ai-builder" size={16} className="text-ember-deep" />
        {busy ? "Writing a suggestion…" : "Suggest a description"}
      </Button>
      {error && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      {result && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm sm:p-4" role="region" aria-label="AI suggestion">
          <Pill tone="ember">AI suggestion: review before using it</Pill>
          {result.name && (
            <p className="mt-3 text-xs text-slate-600">
              Suggested name: <span className="font-medium text-slate-900">{result.name}</span>
            </p>
          )}
          <p className="mt-3 whitespace-pre-line leading-6 text-slate-800">{result.description}</p>
          {result.highlights.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-slate-700">Highlights (added to the description if you use this):</p>
              <ul className="mt-1 list-disc pl-5 text-slate-800">
                {result.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </div>
          )}
          {(result.seoTitle || result.seoDescription) && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
              {result.seoTitle && (
                <p>
                  <span className="font-semibold">Search title:</span> {result.seoTitle}
                </p>
              )}
              {result.seoDescription && (
                <p className="mt-1">
                  <span className="font-semibold">Search description:</span> {result.seoDescription}
                </p>
              )}
            </div>
          )}
          {result.missing.length > 0 && (
            <Notice tone="warning" className="mt-3" title="Details to add for a better description:">
              <ul className="mt-1 list-disc pl-4 text-xs">
                {result.missing.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                onUse({
                  description: result.highlights.length > 0 ? `${result.description}\n\n${result.highlights.map((h) => `- ${h}`).join("\n")}` : result.description,
                  name: result.name,
                  seoTitle: result.seoTitle,
                  seoDescription: result.seoDescription,
                });
                setResult(null);
              }}
            >
              Use this{result.name ? " name and description" : " description"}
            </Button>
            <Button variant="secondary" onClick={() => setResult(null)}>
              Discard
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">Written by AI from this product&apos;s details. Using it fills the form; nothing is saved until you select Save.</p>
        </div>
      )}
    </div>
  );
}
