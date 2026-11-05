"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionIcon } from "@/components/ui/Icon";
import { focusRing } from "@/components/ui/Button";
import { businessNavHref, orderedBusinessTabs, type BusinessMembershipRole } from "./BusinessTabs";

/**
 * Website building is spread over several screens that belong together. This
 * strip joins them into one place while the person is working on the website.
 * The editor keeps its own full-height layout, so it does not show the strip.
 */
export default function WebsiteNav({ businessId, role }: { businessId: string; role: BusinessMembershipRole }) {
  const pathname = usePathname();
  const base = businessNavHref(businessId, "");
  const segment = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split("/")[0] : "";
  const tabs = orderedBusinessTabs(role, "Website");
  if (segment === "editor" || !tabs.some((tab) => tab.segment === segment)) return null;

  return (
    <nav aria-label="Website" className="ui-scroll-x flex gap-1 overflow-x-auto px-3 pb-2 sm:px-5">
      {tabs.map((tab) => {
        const active = tab.segment === segment;
        return (
          <Link
            key={tab.segment}
            href={businessNavHref(businessId, tab.segment)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${focusRing} ${
              active ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <SectionIcon segment={tab.segment} size={14} className={active ? "text-ember" : "text-slate-400"} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
