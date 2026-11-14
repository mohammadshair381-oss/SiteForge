"use client";

import { useMemo, useState } from "react";
import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import DeviceSwitch from "@/components/dashboard/editor/DeviceSwitch";
import PreviewFrame, { previewLayoutLabel, type PreviewLayout } from "@/components/dashboard/editor/PreviewFrame";
import type { EditorDevice } from "@/components/dashboard/editor/EditorToolbar";
import type { StorefrontView } from "@/lib/storefront";
import type { StorefrontConfig } from "@/lib/storefront-config";
import { buildCommerceData, type CommerceExtras } from "@/lib/storefront-home";

/**
 * Store preview for the setup wizard: the storefront renderer with the
 * draft homepage (the same components and data as the editor and the public
 * store), in a device-width frame with Desktop / Tablet / Mobile sizes.
 */
export default function SetupPreview({
  view,
  config,
  extras,
  label = "Store preview",
  className = "h-[28rem] sm:h-[34rem]",
}: {
  view: StorefrontView;
  config: StorefrontConfig;
  extras: CommerceExtras;
  label?: string;
  className?: string;
}) {
  const [device, setDevice] = useState<EditorDevice>("desktop");
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  const commerce = useMemo(() => buildCommerceData(view, config, extras), [view, config, extras]);
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <p className="text-xs font-medium text-slate-700">
          {label}
          {layout && <span className="ml-2 font-normal text-slate-500">{previewLayoutLabel(layout)}</span>}
        </p>
        <DeviceSwitch device={device} onChange={setDevice} />
      </div>
      <div className={`ui-dots-ink p-2 sm:p-3 ${className}`}>
        <PreviewFrame
          device={device}
          title={label}
          onLayout={(next) => setLayout((prev) => (prev && prev.device === next.device && prev.viewport === next.viewport && prev.scale === next.scale ? prev : next))}
        >
          {/* `preview` without `editable`: links and forms do nothing here. */}
          <ThemeRenderer view={view} productHrefBase="#" preview commerce={commerce} />
        </PreviewFrame>
      </div>
    </div>
  );
}
