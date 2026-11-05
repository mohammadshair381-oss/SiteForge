import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { Pill, type Tone } from "@/components/ui/Surface";

/** The AI Builder's shared look: mark, promises, allowance, statuses and the change review. */

export const AI_STATUS: Record<string, { text: string; tone: Tone }> = {
  pending: { text: "Waiting for review", tone: "warning" },
  approved: { text: "Approved", tone: "info" },
  applied: { text: "Applied to draft", tone: "success" },
  rejected: { text: "Rejected", tone: "neutral" },
  failed: { text: "Not applied", tone: "danger" },
};

/** The ember mark that says "this is AI" everywhere in the product. */
export function AiMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-lg bg-brand-50 text-ember ${size === "sm" ? "h-7 w-7" : "h-9 w-9"}`}>
      <Icon name="ai-builder" size={size === "sm" ? 15 : 18} />
    </span>
  );
}

/** The three promises, always in the same words. */
export function AiPromises({ className = "" }: { className?: string }) {
  const items = ["Nothing changes until you approve", "Approved changes go to a draft", "Publishing is a separate step"];
  return (
    <ul aria-label="How AI changes work" className={`flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 ${className}`}>
      {items.map((item) => (
        <li key={item} className="inline-flex items-center gap-1.5">
          <Icon name="check" size={13} className="text-emerald-700" />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** Monthly allowance: used, remaining and a thin meter. Quiet by design. */
export function AiUsageMeter({ used, limit, remaining, planName, action, className = "" }: { used: number; limit: number; remaining: number; planName?: string; action?: ReactNode; className?: string }) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div className={`min-w-0 ${className}`} data-ai-usage="">
      <p className="text-xs text-slate-600">
        {planName && <span className="font-semibold text-slate-800">{planName} plan: </span>}
        {used} of {limit} AI requests used this month, {remaining} left
        {action && <span className="ml-2">{action}</span>}
      </p>
      <div
        role="progressbar"
        aria-label="AI requests used this month"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200"
      >
        <div className={`h-full rounded-full transition-[width] ${remaining <= 0 ? "bg-amber-500" : "bg-slate-800"}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/** A readable before/after review: stacked on phones, side by side from `sm`. */
export function ChangeDiff({ rows, caption, afterLabel = "Suggested" }: { rows: Array<{ label: string; before: string; after: string; live?: boolean }>; caption: string; afterLabel?: string }) {
  return (
    <ul aria-label={caption} className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
      {rows.map((row, index) => (
        <li key={index} className="p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
            {row.label}
            {row.live && <Pill tone="warning">Applies right away</Pill>}
          </p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0 rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-xs font-medium text-slate-500">Now</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-600">{row.before || "(empty)"}</dd>
            </div>
            <div className="min-w-0 rounded-lg border-l-2 border-ember bg-white px-3 py-2 ring-1 ring-inset ring-slate-200">
              <dt className="text-xs font-medium text-slate-500">{afterLabel}</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-900">{row.after || "(empty)"}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** Questions the AI could not answer from the store's own data. */
export function AiNotes({ notes, title = "The assistant asks:" }: { notes: string[]; title?: string }) {
  if (notes.length === 0) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-700">
      <p className="font-semibold text-slate-900">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {notes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
