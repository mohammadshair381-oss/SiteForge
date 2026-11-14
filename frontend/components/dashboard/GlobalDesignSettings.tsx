"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useToastHelpers } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { inputClass, labelClass } from "@/components/ui/Field";
import { Card, Notice } from "@/components/ui/Surface";
import ManagementPageHeader from "./ManagementPageHeader";

interface DesignTokens {
  spacing?: { xs?: string; sm?: string; md?: string; lg?: string; xl?: string };
  radius?: { sm?: string; md?: string; lg?: string; xl?: string };
  shadows?: { sm?: string; md?: string; lg?: string };
  button?: { radius?: string; paddingX?: string; paddingY?: string };
  contentWidth?: string;
  fontScale?: string;
}

interface GlobalDesignSettingsProps {
  businessId: string;
  initialDesignTokens?: DesignTokens;
  canManage: boolean;
}

const radiusOptions = [
  { value: "0.25rem", label: "Small" },
  { value: "0.375rem", label: "Medium" },
  { value: "0.5rem", label: "Large" },
  { value: "0.75rem", label: "Extra Large" },
  { value: "1rem", label: "Rounded" },
];

const spacingOptions = [
  { value: "0.5rem", label: "Compact" },
  { value: "1rem", label: "Normal" },
  { value: "1.5rem", label: "Spacious" },
  { value: "2rem", label: "Extra Spacious" },
];

const contentWidthOptions = [
  { value: "640px", label: "Narrow" },
  { value: "768px", label: "Medium" },
  { value: "1024px", label: "Wide" },
  { value: "1280px", label: "Full" },
];

/** Rough share of the sample box each content width fills: only for the small sample. */
const WIDTH_SAMPLE: Record<string, string> = { "640px": "40%", "768px": "55%", "1024px": "75%", "1280px": "95%" };

const fontScaleOptions = [
  { value: "0.875", label: "Small" },
  { value: "1", label: "Normal" },
  { value: "1.125", label: "Large" },
  { value: "1.25", label: "Extra Large" },
];

function SettingCard({
  title,
  description,
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  sample,
}: {
  title: string;
  description: string;
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled: boolean;
  sample: ReactNode;
}) {
  return (
    <Card as="section" className="flex flex-col p-5 sm:p-6">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>
      <div className="mt-4 flex h-20 items-center justify-center overflow-hidden rounded-xl bg-slate-50 px-4" aria-hidden="true">
        {sample}
      </div>
      <div className="mt-4">
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={inputClass}>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}

export default function GlobalDesignSettings({
  businessId,
  initialDesignTokens,
  canManage,
}: GlobalDesignSettingsProps) {
  const router = useRouter();
  const { success, error } = useToastHelpers();
  const [tokens, setTokens] = useState<DesignTokens>(initialDesignTokens ?? {});
  const [loading, setLoading] = useState(false);

  async function save() {
    if (!canManage) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/businesses/${businessId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeSettings: { designTokens: tokens } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Unable to save design settings");
      success("Design settings saved", "Your global design changes have been saved as a draft.");
      router.refresh();
    } catch (err) {
      error("Unable to save design settings", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function updateToken<K extends keyof DesignTokens>(key: K, value: DesignTokens[K]) {
    setTokens((prev) => ({ ...prev, [key]: value }));
  }

  const radius = tokens.button?.radius ?? "0.5rem";
  const gap = tokens.spacing?.md ?? "1.5rem";
  const width = tokens.contentWidth ?? "1280px";
  const scale = tokens.fontScale ?? "1";
  const widthPercent = WIDTH_SAMPLE[width] ?? "95%";

  return (
    <div className="space-y-6">
      <ManagementPageHeader
        title="Site-wide design"
        description="Set shared sizing and spacing for your storefront. These settings are saved as a draft and only appear publicly after you publish."
        actions={
          <Button onClick={save} disabled={loading || !canManage} className="shrink-0">
            {loading ? "Saving…" : "Save settings"}
          </Button>
        }
      />

      {!canManage && <Notice tone="info">Only business owners and managers can edit design settings.</Notice>}

      <div className="grid gap-5 lg:grid-cols-2">
        <SettingCard
          title="Buttons and corners"
          description="Choose how rounded your shared buttons appear."
          id="radius"
          label="Button radius"
          value={radius}
          options={radiusOptions}
          disabled={!canManage}
          onChange={(value) => updateToken("button", { ...tokens.button, radius: value })}
          sample={
            <span className="bg-slate-900 px-4 py-2 text-xs font-semibold text-white" style={{ borderRadius: radius }}>
              Shop now
            </span>
          }
        />
        <SettingCard
          title="Section spacing"
          description="Set the breathing room between website sections."
          id="spacing"
          label="Section gap"
          value={gap}
          options={spacingOptions}
          disabled={!canManage}
          onChange={(value) => updateToken("spacing", { ...tokens.spacing, md: value })}
          sample={
            <span className="flex w-full max-w-[12rem] flex-col" style={{ gap }}>
              <span className="h-4 rounded bg-slate-300" />
              <span className="h-4 rounded bg-slate-300" />
            </span>
          }
        />
        <SettingCard
          title="Page content width"
          description="Limit how wide text and other content can stretch."
          id="contentWidth"
          label="Max content width"
          value={width}
          options={contentWidthOptions}
          disabled={!canManage}
          onChange={(value) => updateToken("contentWidth", value)}
          sample={
            <span className="flex h-10 w-full items-center justify-center rounded border border-dashed border-slate-300">
              <span className="h-6 rounded bg-slate-300" style={{ width: widthPercent }} />
            </span>
          }
        />
        <SettingCard
          title="Text size"
          description="Adjust the overall text scale across your site."
          id="fontScale"
          label="Font scale"
          value={scale}
          options={fontScaleOptions}
          disabled={!canManage}
          onChange={(value) => updateToken("fontScale", value)}
          sample={
            <span className="font-semibold text-slate-800" style={{ fontSize: `${Number(scale) * 1}rem` }}>
              The quick brown fox
            </span>
          }
        />
      </div>
    </div>
  );
}
