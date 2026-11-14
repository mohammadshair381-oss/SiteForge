"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo, LogoMark } from "@/components/ui/Logo";
import { Icon } from "@/components/ui/Icon";
import { focusRing } from "@/components/ui/Button";
import SupportContact from "@/components/ui/SupportContact";
import DashboardNav, { type NavBusiness } from "./DashboardNav";
import LogoutButton from "./LogoutButton";
import CommandPalette, { openCommandPalette } from "./CommandPalette";

const RAIL_KEY = "siteforge.sidebar.rail";

/** Screens that need the width: the sidebar folds to an icon rail by itself. */
function isFocusRoute(pathname: string): boolean {
  return /^\/dashboard\/businesses\/[^/]+\/(editor|preview)(\/|$)/.test(pathname);
}

/**
 * Desktop frame of the dashboard: a sidebar that can fold to an icon rail
 * (always folded on the website editor unless the person opens it), and the
 * global command palette. Mobile navigation lives in the header (MobileNav).
 */
export default function DashboardShell({
  businesses,
  isSuperAdmin,
  user,
  mobileHeader,
  children,
}: {
  businesses: NavBusiness[];
  isSuperAdmin: boolean;
  user: { name: string; email: string };
  mobileHeader: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [savedRail, setSavedRail] = useState(false);
  // A manual choice on a focus route lasts until the person leaves that route.
  const [override, setOverride] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setSavedRail(window.localStorage.getItem(RAIL_KEY) === "1");
    } catch {
      // Storage unavailable: full sidebar.
    }
  }, []);
  useEffect(() => setOverride(null), [pathname]);

  const focus = isFocusRoute(pathname);
  const rail = override ?? (focus || savedRail);

  function toggle() {
    const next = !rail;
    if (focus) {
      setOverride(next);
      return;
    }
    setSavedRail(next);
    try {
      window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    } catch {
      // A convenience only.
    }
  }

  const initial = user.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <>
      <CommandPalette businesses={businesses} isSuperAdmin={isSuperAdmin} />
      <aside className={`fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-slate-200 bg-white py-3 transition-[width] duration-200 lg:flex ${rail ? "w-[68px] items-center px-2" : "w-64 px-3"}`}>
        <div className={`flex h-10 w-full shrink-0 items-center ${rail ? "justify-center" : "justify-between px-1"}`}>
          <Link href="/dashboard" aria-label="SiteForge, all businesses" className={`rounded-lg ${focusRing}`}>
            {rail ? <LogoMark /> : <Logo />}
          </Link>
          {!rail && (
            <button type="button" onClick={toggle} aria-label="Collapse sidebar" title="Collapse sidebar" className={`flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 ${focusRing}`}>
              <Icon name="panel-left" size={17} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Search pages and actions"
          title="Search (Ctrl K)"
          className={`mt-3 flex shrink-0 items-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800 ${focusRing} ${rail ? "h-10 w-10 justify-center" : "min-h-9 w-full gap-2 px-2.5"}`}
        >
          <Icon name="search" size={16} />
          {!rail && (
            <>
              <span className="flex-1 text-left">Search</span>
              <kbd className="rounded border border-slate-200 bg-white px-1.5 text-[10px] font-medium text-slate-400">Ctrl K</kbd>
            </>
          )}
        </button>

        <DashboardNav businesses={businesses} isSuperAdmin={isSuperAdmin} collapsed={rail} />

        {rail ? (
          <button type="button" onClick={toggle} aria-label="Expand sidebar" title="Expand sidebar" className={`mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 ${focusRing}`}>
            <Icon name="panel-left" />
          </button>
        ) : (
          <>
          <SupportContact className="mt-2 w-full shrink-0 border-t border-slate-200 px-1 pt-2 text-xs leading-5 text-slate-500" />
          <div className="mt-2 flex w-full shrink-0 items-center gap-2.5 border-t border-slate-200 px-1 pt-3">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
              {initial}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-800">{user.name}</p>
              <p className="truncate text-xs text-slate-500">{user.email}</p>
              <LogoutButton />
            </div>
          </div>
          </>
        )}
      </aside>

      <div className={`min-w-0 transition-[padding] duration-200 ${rail ? "lg:pl-[68px]" : "lg:pl-64"}`}>
        {mobileHeader}
        {children}
      </div>
    </>
  );
}

/** Search button of the mobile header. */
export function CommandTrigger() {
  return (
    <button type="button" onClick={openCommandPalette} aria-label="Search pages and actions" className={`flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 ${focusRing}`}>
      <Icon name="search" />
    </button>
  );
}
