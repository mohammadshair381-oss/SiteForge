"use client";

import { useState } from "react";
import { SEO_LIMITS, type SeoTargetKind } from "@/lib/ai-builder/seo";
import { Button, focusRing as focus } from "@/components/ui/Button";
import { Eyebrow, Notice } from "@/components/ui/Surface";
import type { AiBuilderCategory } from "./AiBuilder";
import { AiNotes } from "./AiShared";

export interface SeoResult {
  kind: SeoTargetKind;
  targetId: string;
  targetName: string;
  current: { seoTitle?: string; seoDescription?: string; description?: string; imageAlt?: string };
  suggestion: { seoTitle: string; seoDescription: string; description?: string; imageAlt?: string };
  summary: string;
  notes: string[];
}

type Field = "seoTitle" | "seoDescription" | "description" | "imageAlt";
const FIELDS: Array<{ key: Field; label: string; max: number; good: number; rows: number }> = [
  { key: "seoTitle", label: "Search title", max: SEO_LIMITS.titleMax, good: SEO_LIMITS.title, rows: 1 },
  { key: "seoDescription", label: "Search description", max: SEO_LIMITS.descriptionMax, good: SEO_LIMITS.description, rows: 3 },
  { key: "description", label: "Short description", max: SEO_LIMITS.pageDescriptionMax, good: SEO_LIMITS.pageDescriptionMax, rows: 3 },
  { key: "imageAlt", label: "Main image alt text", max: SEO_LIMITS.altMax, good: SEO_LIMITS.alt, rows: 2 },
];

/**
 * SEO suggestions beside the current text. Every field stays editable. A field
 * that already has text is replaced only if the owner ticks it, and nothing is
 * saved until they select Save (the normal page, product or category update).
 */
export default function AiSeoResult({ businessId, result, category }: { businessId: string; result: SeoResult; category: AiBuilderCategory | null }) {
  const present = FIELDS.filter((f) => result.suggestion[f.key] !== undefined);
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(present.map((f) => [f.key, result.suggestion[f.key] ?? ""])));
  const [use, setUse] = useState<Record<string, boolean>>(Object.fromEntries(present.map((f) => [f.key, !(result.current[f.key] ?? "").trim()])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const chosen = present.filter((f) => use[f.key]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const fields = Object.fromEntries(chosen.map((f) => [f.key, values[f.key].trim()]));
      let res: Response;
      const json = { "Content-Type": "application/json" };
      if (result.kind === "page") {
        res = await fetch(`/api/businesses/${businessId}/pages/${result.targetId}`, { method: "PATCH", headers: json, body: JSON.stringify(fields) });
      } else if (result.kind === "product") {
        res = await fetch(`/api/businesses/${businessId}/products/${result.targetId}`, { method: "PATCH", headers: json, body: JSON.stringify(fields) });
      } else {
        if (!category) throw new Error("This category is no longer available.");
        // The category form replaces the whole record: keep everything else.
        const { name, slug, description, imageUrl, active } = category;
        res = await fetch(`/api/businesses/${businessId}/categories/${result.targetId}`, { method: "PUT", headers: json, body: JSON.stringify({ name, slug, description, imageUrl, active, ...fields }) });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "It could not be saved.");
      setMessage({ ok: true, text: result.kind === "page" ? "Saved to the page's draft. It goes live when you publish the page." : "Saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing was saved." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-ai-seo="">
      <div>
        <Eyebrow>Search text</Eyebrow>
        <p className="mt-1 text-base font-semibold text-slate-900">Search text for {result.targetName}</p>
        {result.summary && <p className="mt-1 text-sm text-slate-600">{result.summary}</p>}
        <p className="mt-1 text-xs text-slate-500">Suggested by the AI assistant. Edit it before saving; URLs and the sitemap do not change.</p>
      </div>
      {present.map((f) => {
        const current = (result.current[f.key] ?? "").trim();
        const value = values[f.key];
        const id = `ai-seo-${f.key}`;
        return (
          <div key={f.key} className={`rounded-xl border p-3 transition-colors ${use[f.key] ? "border-slate-400" : "border-slate-200"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={id} className="text-sm font-medium text-slate-900">{f.label}</label>
              <span className={`text-xs ${value.length > f.good ? "text-amber-800" : "text-slate-500"}`}>
                {value.length} characters{value.length > f.good ? `: may be cut off after ${f.good}` : ""}
              </span>
            </div>
            <p className="mt-1 break-words text-xs text-slate-500">Now: {current || "(empty)"}</p>
            <textarea id={id} rows={f.rows} maxLength={f.max} value={value} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} className={`mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm ${focus}`} />
            <label className="mt-1.5 flex min-h-10 items-center gap-2 text-xs font-medium text-slate-700">
              <input type="checkbox" checked={Boolean(use[f.key])} onChange={(e) => setUse((u) => ({ ...u, [f.key]: e.target.checked }))} className="h-4 w-4" />
              {current ? "Replace the current text" : "Use this text"}
            </label>
          </div>
        );
      })}
      <AiNotes notes={result.notes} title="Worth knowing:" />
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy || chosen.length === 0} onClick={() => void save()}>
          {busy ? "Saving…" : `Save ${chosen.length} ${chosen.length === 1 ? "field" : "fields"}`}
        </Button>
        <span className="text-xs text-slate-500">Nothing is saved until you select this.</span>
      </div>
    </div>
  );
}
