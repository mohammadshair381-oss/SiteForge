"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, SectionIcon } from "@/components/ui/Icon";
import { focusRing } from "@/components/ui/Button";
import {
  BUSINESS_NAV_GROUPS,
  BUSINESS_NAV_GROUP_LABELS,
  businessNavHref,
  orderedBusinessTabs,
  type BusinessMembershipRole,
  type BusinessNavGroup,
} from "./BusinessTabs";

export interface NavBusiness {
  id: string;
  name: string;
  role: BusinessMembershipRole;
}

const ROLE_LABELS: Record<BusinessMembershipRole, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
};

const CLOSED_KEY = "siteforge.nav.closed";

function NavItem({ href, label, active, collapsed, icon, emphasis, onNavigate }: { href: string; label: string; active: boolean; collapsed: boolean; icon: React.ReactNode; emphasis?: boolean; onNavigate?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={`group flex items-center rounded-lg text-sm transition-colors ${collapsed ? "h-10 w-10 justify-center" : "min-h-9 gap-2.5 px-2.5 py-1.5"} ${focusRing} ${
        active ? "bg-slate-900 font-medium text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      <span className={active ? "text-ember-soft" : emphasis ? "text-ember" : "text-slate-400 group-hover:text-slate-600"}>{icon}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

/**
 * The workspace navigation, shared by the desktop sidebar and the mobile
 * drawer. Which sections a person sees comes only from the tab model in
 * BusinessTabs (their membership role); groups can be folded, and the group
 * holding the current page always stays open.
 */
export default function DashboardNav({
  businesses,
  isSuperAdmin,
  onNavigate,
  collapsed = false,
}: {
  businesses: NavBusiness[];
  isSuperAdmin: boolean;
  onNavigate?: () => void;
  /** Icon rail (desktop focus mode). */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [closed, setClosed] = useState<string[]>([]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CLOSED_KEY) ?? "[]");
      if (Array.isArray(saved)) setClosed(saved.filter((v) => typeof v === "string"));
    } catch {
      // Storage unavailable: every group stays open.
    }
  }, []);

  function toggleGroup(group: BusinessNavGroup) {
    setClosed((current) => {
      const next = current.includes(group) ? current.filter((g) => g !== group) : [...current, group];
      try {
        window.localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        // A convenience only.
      }
      return next;
    });
  }

  const activeBusiness = businesses.find((business) => {
    const base = `/dashboard/businesses/${business.id}`;
    return pathname === base || pathname.startsWith(`${base}/`);
  });

  const overviewActive = pathname === "/dashboard";
  const adminActive = pathname === "/admin" || pathname.startsWith("/admin/");
  const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

  return (
    <nav aria-label="Dashboard" className={`mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden pb-1 ${collapsed ? "items-center gap-1" : "gap-4"}`}>
      {activeBusiness ? (
        <>
          {collapsed ? (
            <Link href={businessNavHref(activeBusiness.id, "")} title={activeBusiness.name} aria-label={activeBusiness.name} className={`mb-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 font-heading text-sm font-semibold text-[#b23a12] ${focusRing}`}>
              {initial(activeBusiness.name)}
            </Link>
          ) : (
            <div className="shrink-0 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-center gap-2.5">
                <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 font-heading text-sm font-semibold text-[#b23a12]">
                  {initial(activeBusiness.name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900" title={activeBusiness.name}>
                    {activeBusiness.name}
                  </p>
                  <p className="text-[11px] font-medium text-slate-500">{ROLE_LABELS[activeBusiness.role]}</p>
                </div>
              </div>
              {businesses.length > 1 && (
                <label className="mt-2 block">
                  <span className="sr-only">Switch business</span>
                  <select
                    value={activeBusiness.id}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (!next || next === activeBusiness.id) return;
                      onNavigate?.();
                      router.push(`/dashboard/businesses/${next}`);
                    }}
                    className={`w-full rounded-lg border px-2 py-1.5 text-xs font-medium text-slate-700 ${focusRing}`}
                  >
                    {businesses.map((business) => (
                      <option key={business.id} value={business.id}>
                        {business.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Link href="/dashboard" onClick={onNavigate} className={`mt-2 inline-flex items-center gap-1 rounded text-[11px] font-semibold text-slate-500 transition hover:text-slate-900 ${focusRing}`}>
                <Icon name="arrow-left" size={12} /> All businesses
              </Link>
            </div>
          )}

          {BUSINESS_NAV_GROUPS.map((group) => {
            const items = orderedBusinessTabs(activeBusiness.role, group);
            if (items.length === 0) return null;
            const isActive = (segment: string) => {
              const href = businessNavHref(activeBusiness.id, segment);
              return segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === href;
            };
            const label = BUSINESS_NAV_GROUP_LABELS[group];
            const open = collapsed || !label || items.some((item) => isActive(item.segment)) || !closed.includes(group);
            return (
              <div key={group} className={`shrink-0 ${collapsed ? "flex flex-col items-center gap-1 border-t border-slate-200 pt-2 first-of-type:border-0" : ""}`}>
                {label && !collapsed && (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group)}
                    aria-expanded={open}
                    className={`group flex w-full items-center justify-between rounded px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-700 ${focusRing}`}
                  >
                    {label}
                    <Icon name="chevron-down" size={13} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
                  </button>
                )}
                {open && (
                  <ul className={collapsed ? "contents" : "space-y-0.5"}>
                    {items.map((item) => (
                      <li key={item.segment || "overview"}>
                        <NavItem
                          href={businessNavHref(activeBusiness.id, item.segment)}
                          label={item.label}
                          active={isActive(item.segment)}
                          collapsed={collapsed}
                          emphasis={item.segment === "ai-builder"}
                          icon={<SectionIcon segment={item.segment} />}
                          onNavigate={onNavigate}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </>
      ) : (
        <>
          <NavItem href="/dashboard" label="All businesses" active={overviewActive} collapsed={collapsed} icon={<Icon name="overview" />} onNavigate={onNavigate} />
          <div className={collapsed ? "flex flex-col items-center gap-1" : ""}>
            {!collapsed && <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Your businesses</p>}
            {businesses.length === 0 ? (
              !collapsed && <p className="px-2.5 py-1 text-xs text-slate-500">None yet</p>
            ) : (
              <ul className={collapsed ? "contents" : "space-y-0.5"}>
                {businesses.map((business) => (
                  <li key={business.id}>
                    <NavItem href={`/dashboard/businesses/${business.id}`} label={business.name} active={false} collapsed={collapsed} icon={<Icon name="business" />} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {isSuperAdmin && (
        <div className={`mt-auto shrink-0 border-t border-slate-200 pt-2 ${collapsed ? "flex justify-center" : ""}`}>
          <NavItem href="/admin" label="Admin panel" active={adminActive} collapsed={collapsed} icon={<Icon name="shield" />} onNavigate={onNavigate} />
        </div>
      )}
    </nav>
  );
}
