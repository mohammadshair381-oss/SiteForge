"use client";

import { Icon } from "@/components/ui/Icon";
import type { EditorDevice } from "./EditorToolbar";

const DEVICES: Array<{ id: EditorDevice; label: string; icon: string }> = [
  { id: "desktop", label: "Desktop", icon: "monitor" },
  { id: "tablet", label: "Tablet", icon: "tablet" },
  { id: "mobile", label: "Mobile", icon: "phone" },
];

/**
 * The device segmented control shared by every preview (editor, theme preview,
 * setup, AI review). Icon-only when space is tight; the name stays available
 * to screen readers and as a tooltip.
 */
export default function DeviceSwitch({
  device,
  onChange,
  labels = "wide",
  className = "",
}: {
  device: EditorDevice;
  onChange: (device: EditorDevice) => void;
  /** "wide": names appear on wide screens only. "always": names are always visible. */
  labels?: "wide" | "always";
  className?: string;
}) {
  return (
    <div role="group" aria-label="Preview size" className={`inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 ${className}`}>
      {DEVICES.map((d) => {
        const active = device === d.id;
        return (
          <button
            key={d.id}
            type="button"
            onClick={() => onChange(d.id)}
            aria-pressed={active}
            title={d.label}
            className={`inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:min-h-8 ${
              active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
            }`}
          >
            <Icon name={d.icon} size={15} />
            <span className={labels === "always" ? "" : "sr-only xl:not-sr-only"}>{d.label}</span>
          </button>
        );
      })}
    </div>
  );
}
