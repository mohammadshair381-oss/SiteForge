import ThemeRenderer from "@/components/storefront/ThemeRenderer";
import type { ThemeId } from "@/lib/constants";
import { sampleCommerceData, sampleStoreView } from "./sample-store";

/**
 * A real theme rendered by the real storefront renderer with sample content,
 * zoomed out inside a browser window. Decorative: it cannot be focused or
 * clicked, and the page says that it is a sample.
 */
export default function StorefrontPreview({ themeId = "atelier", className = "" }: { themeId?: ThemeId; className?: string }) {
  const view = sampleStoreView(themeId);
  const commerce = sampleCommerceData(themeId);
  return (
    <div className={`overflow-hidden rounded-2xl border border-white/10 bg-white shadow-[0_40px_80px_-24px_rgba(0,0,0,0.7)] ${className}`}>
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-100 px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        </div>
        <span aria-hidden="true" className="min-w-0 flex-1 truncate rounded-md bg-white px-3 py-1 text-center text-[11px] text-slate-500">
          {view.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.siteforge.app
        </span>
      </div>
      <div aria-hidden="true" inert className="pointer-events-none relative h-[440px] select-none overflow-hidden xl:h-[500px]">
        <div className="absolute left-0 top-0 w-[1200px] origin-top-left [transform:scale(0.5)] xl:[transform:scale(0.56)]">
          <ThemeRenderer view={view} productHrefBase="#" preview commerce={commerce} />
        </div>
      </div>
    </div>
  );
}
