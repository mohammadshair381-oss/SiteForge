"use client";

import { useId } from "react";
import { withResponsiveValue, type ResponsiveDevice, type ResponsiveRule, type ResponsiveSettings } from "@/lib/section-responsive";
import { editorFocus } from "./EditorWorkspace";

const DEVICE_NAMES: Record<ResponsiveDevice, string> = { desktop: "computers", tablet: "tablets", mobile: "phones" };
const select = `mt-1 block min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 ${editorFocus}`;

const OPTIONS: Array<{ key: Exclude<keyof ResponsiveRule, "hidden">; label: string; values: Array<[string, string]> }> = [
  { key: "spacing", label: "Space above and below", values: [["none", "None"], ["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
  { key: "textAlign", label: "Text alignment", values: [["left", "Left"], ["center", "Centre"], ["right", "Right"]] },
  { key: "columns", label: "Columns", values: [["1", "1 column"], ["2", "2 columns"], ["3", "3 columns"], ["4", "4 columns"]] },
  { key: "contentWidth", label: "Content width", values: [["narrow", "Narrow"], ["normal", "Normal"], ["wide", "Wide"], ["full", "Full width"]] },
  { key: "imageAlign", label: "Picture alignment", values: [["left", "Left"], ["center", "Centre"], ["right", "Right"]] },
];

/**
 * How one section behaves on the screen size chosen in the toolbar. Saved in the draft, and shown
 * by the same renderer as the store. Sizes left alone keep what the theme does.
 */
export default function ResponsiveControls({ device, value, onChange, disabled }: { device: ResponsiveDevice; value: ResponsiveSettings | undefined; onChange: (next: ResponsiveSettings | undefined) => void; disabled?: boolean }) {
  const id = useId();
  const rule = value?.[device] ?? {};
  const customised = Object.keys(rule).length > 0;
  return (
    <details className="rounded-lg border border-slate-200 bg-white" open={customised || undefined}>
      <summary className={`flex min-h-10 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium text-slate-800 ${editorFocus}`}>
        Screen size settings
        <span className="text-xs font-normal text-slate-500">For {DEVICE_NAMES[device]}</span>
      </summary>
      <div className="space-y-3 border-t border-slate-200 p-3">
        <p className="text-xs leading-5 text-slate-500">These apply to {DEVICE_NAMES[device]} only. Use the screen buttons at the top to choose another size.</p>
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" className="h-4 w-4 rounded" disabled={disabled} checked={rule.hidden === true} onChange={(event) => onChange(withResponsiveValue(value, device, "hidden", event.target.checked))} />
          Hide this section on {DEVICE_NAMES[device]}
        </label>
        {OPTIONS.map((option) => (
          <div key={option.key}>
            <label htmlFor={`${id}-${option.key}`} className="block text-xs font-medium text-slate-700">{option.label}</label>
            <select id={`${id}-${option.key}`} disabled={disabled} value={rule[option.key] ?? ""} onChange={(event) => onChange(withResponsiveValue(value, device, option.key, event.target.value))} className={select}>
              <option value="">The theme&apos;s own</option>
              {option.values.map(([optionValue, name]) => <option key={optionValue} value={optionValue}>{name}</option>)}
            </select>
          </div>
        ))}
        <p className="text-xs leading-5 text-slate-500">Some settings only change sections that have that part: columns need a grid, and picture alignment needs a picture.</p>
      </div>
    </details>
  );
}
