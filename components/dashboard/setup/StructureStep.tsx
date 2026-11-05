"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import type { StorefrontView } from "@/lib/storefront";
import { HOME_SECTION_LABELS, presetSections, type StorefrontConfig } from "@/lib/storefront-config";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";
import type { PresetKey } from "@/lib/storefront-presets";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice, Pill, type Tone } from "@/components/ui/Surface";
import { SetupFooter, useSetup } from "./SetupWizard";
import SetupPreview from "./SetupPreview";

/**
 * Step 3: the homepage layout. The business type's preset (lib/storefront-
 * presets.ts) is the suggestion; sections fill from the store's real data
 * and stay hidden until they have something real to show. Applying the
 * layout saves the DRAFT homepage (PUT /storefront); nothing is published.
 */
export default function StructureStep({
  view,
  draft,
  extras,
  presetKey,
  presetLabel,
}: {
  view: StorefrontView;
  draft: StorefrontConfig;
  extras: CommerceExtras;
  presetKey: PresetKey;
  presetLabel: string;
}) {
  const { businessId } = useSetup();
  const name = useId();
  const suggested = useMemo(() => presetSections(presetKey), [presetKey]);
  const alreadyPreset = JSON.stringify(draft.sections) === JSON.stringify(suggested);
  // An untouched layout of ANOTHER business type (the type changed) suggests
  // the new one; a customised homepage is kept unless the owner chooses.
  const untouchedOtherPreset =
    !alreadyPreset && draft.preset !== null && draft.preset !== presetKey && JSON.stringify(draft.sections) === JSON.stringify(presetSections(draft.preset));
  const [choice, setChoice] = useState<"keep" | "preset">(untouchedOtherPreset ? "preset" : "keep");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidate = useMemo<StorefrontConfig>(
    () => (choice === "preset" ? { ...draft, preset: presetKey, sections: suggested } : draft),
    [choice, draft, presetKey, suggested],
  );
  const commerce = useMemo(() => buildCommerceData(view, candidate, extras), [view, candidate, extras]);
  const shown = new Set(commerce.sections.map((s) => s.id));
  const hidden = new Map(commerce.hiddenSections.map((h) => [h.id, h.reason]));

  async function save(): Promise<boolean> {
    if (choice !== "preset" || alreadyPreset) return true;
    if (!(await confirmDialog({ title: `Use the ${presetLabel} layout?`, message: "This replaces your homepage sections in the draft. Your hero, announcement, policies and footer stay as they are.", confirmLabel: "Replace sections", tone: "danger" }))) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/storefront`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(candidate),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The homepage layout could not be saved.");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. The homepage layout was not saved.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          {alreadyPreset ? (
            <Notice tone="success">Your homepage uses the {presetLabel} layout.</Notice>
          ) : (
            <fieldset>
              <legend className="text-sm font-semibold text-slate-900">Homepage layout</legend>
              <div className="mt-2 space-y-2">
                {(
                  [
                    ["keep", "Keep my current homepage", "Your sections stay exactly as they are."],
                    ["preset", `Use the ${presetLabel} layout`, "Replaces the homepage sections in your draft. Nothing changes on your live store until you publish."],
                  ] as const
                ).map(([value, title, detail]) => (
                  <label key={value} htmlFor={`${name}-${value}`} className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${choice === value ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-400"}`}>
                    <input id={`${name}-${value}`} type="radio" name={`${name}-layout`} checked={choice === value} onChange={() => setChoice(value)} className="mt-1" />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">{title}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-slate-600">{detail}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div>
            <h3 className="text-sm font-semibold text-slate-900">{choice === "preset" ? `${presetLabel} layout` : "Your homepage sections"}</h3>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">Sections use your real products, categories and orders. Empty sections stay hidden until they have something to show.</p>
            <ol className="mt-2 space-y-1.5" aria-label="Homepage sections">
              {candidate.sections.map((s) => {
                const status: { text: string; tone: Tone } = !s.enabled ? { text: "Turned off", tone: "neutral" } : shown.has(s.id) ? { text: "Shows now", tone: "success" } : { text: "Hidden for now", tone: "warning" };
                return (
                  <li key={s.id} className="rounded-xl border border-slate-200 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-slate-900">{s.title || HOME_SECTION_LABELS[s.type]}</span>
                      <Pill tone={status.tone} className="shrink-0">{status.text}</Pill>
                    </div>
                    {s.enabled && hidden.has(s.id) && <p className="mt-0.5 text-xs text-slate-500">{hidden.get(s.id)}</p>}
                  </li>
                );
              })}
            </ol>
          </div>
          <p className="text-xs leading-5 text-slate-500">
            Want to add, reorder or restyle sections?{" "}
            <Link href={`/dashboard/businesses/${businessId}/editor`} className="rounded font-medium text-slate-800 underline underline-offset-2">
              Open the website editor
            </Link>{" "}
            any time.
          </p>
        </div>
        <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SetupPreview view={view} config={candidate} extras={extras} label="Homepage preview" />
        </div>
      </div>
      {error && (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      )}
      <SetupFooter onContinue={save} saving={saving} />
    </div>
  );
}
