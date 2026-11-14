"use client";

import { useState } from "react";
import type { ThemeRecommendation } from "@/lib/ai-builder/theme-advisor";
import { Button, buttonClass } from "@/components/ui/Button";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow, Notice, Pill } from "@/components/ui/Surface";
import { AiNotes } from "./AiShared";

/**
 * Theme recommendations with what THIS plan allows (decided on the server).
 * A theme the plan includes can be applied, through the normal theme change,
 * which checks the plan again. A locked theme names the plan that unlocks it.
 * Nothing here changes a subscription.
 */
export default function AiThemeResult({
  businessId,
  isOwner,
  summary,
  notes,
  recommendations,
  source,
}: {
  businessId: string;
  isOwner: boolean;
  summary: string | null;
  notes: string[];
  recommendations: ThemeRecommendation[];
  source: "ai" | "catalog";
}) {
  const [applied, setApplied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const marketplace = `/dashboard/businesses/${businessId}/theme`;

  async function apply(theme: ThemeRecommendation) {
    if (!(await confirmDialog({ title: `Use ${theme.name} in your draft?`, message: "It goes to your design draft. Your live store does not change until you publish it from Publish or Design. Pages, content, products and settings stay exactly as they are.", confirmLabel: `Use ${theme.name}` }))) return;
    setBusy(theme.themeId);
    setMessage(null);
    try {
      const res = await fetch(`/api/businesses/${businessId}/design`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ themeId: theme.themeId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The theme could not be added to your draft.");
      setApplied(theme.themeId);
      setMessage({ ok: true, text: `${theme.name} is in your draft. Your live store has not changed.` });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Network error. Nothing changed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-ai-theme={source}>
      <div>
        <Eyebrow>{source === "ai" ? "Theme advice" : "Designed for your type of business"}</Eyebrow>
        {summary && <p className="mt-1 text-base font-semibold leading-6 text-slate-900">{summary}</p>}
        <p className="mt-1 text-xs text-slate-500">{source === "ai" ? "Suggested by the AI assistant." : "From the theme catalogue, without AI: nothing was sent anywhere."}</p>
      </div>
      {message && (
        <Notice tone={message.ok ? "success" : "danger"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </Notice>
      )}
      <ul className="space-y-2" aria-label="Recommended themes">
        {recommendations.map((theme) => {
          const current = applied ? applied === theme.themeId : theme.current;
          return (
            <li key={theme.themeId} data-theme-recommendation={theme.themeId} className="rounded-xl border border-slate-200 p-3 sm:p-4">
              <p className="text-sm font-semibold text-slate-900">{theme.name}</p>
              <p className="mt-1 text-sm leading-6 text-slate-700">{theme.reason}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {current ? (
                  <Pill tone={applied === theme.themeId ? "warning" : "success"} dot>{applied === theme.themeId ? "In your draft" : "Current theme"}</Pill>
                ) : theme.selectable ? (
                  <Button disabled={busy !== null} onClick={() => void apply(theme)}>
                    {busy === theme.themeId ? "Saving…" : `Use ${theme.name} in draft`}
                  </Button>
                ) : theme.requiredPlan ? (
                  isOwner ? (
                    <a href={`/dashboard/businesses/${businessId}/billing`} className={buttonClass({ variant: "secondary" })}>
                      <Icon name="lock" size={14} /> Upgrade to {theme.requiredPlan.name}
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                      <Icon name="lock" size={13} /> On the {theme.requiredPlan.name} plan. Ask the store owner to upgrade.
                    </span>
                  )
                ) : (
                  <span className="text-xs text-slate-600">Not available on any current plan</span>
                )}
                <a href={marketplace} className={buttonClass({ variant: "ghost" })}>
                  Preview in the marketplace<span className="sr-only"> ({theme.name})</span>
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      <AiNotes notes={notes} title="Worth knowing:" />
    </div>
  );
}
