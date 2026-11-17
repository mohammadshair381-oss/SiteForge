"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { Logo, LogoMark } from "@/components/ui/Logo";
import AdminNav from "./AdminNav";

const RAIL_KEY = "siteforge.admin.sidebar.rail";
const onDarkFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft";

/**
 * Desktop frame of the Super Admin area: the dark sidebar, which folds to an icon rail
 * and back like the dashboard's (the choice is remembered on this device), and the page
 * beside it. Screens below `lg` use the header menu (AdminMobileMenu) instead.
 */
export default function AdminShell({ children }: { children: ReactNode }) {
  const [rail, setRail] = useState(false);

  useEffect(() => {
    try {
      setRail(window.localStorage.getItem(RAIL_KEY) === "1");
    } catch {
      // Storage unavailable: full sidebar.
    }
  }, []);

  function toggle() {
    const next = !rail;
    setRail(next);
    try {
      window.localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    } catch {
      // A convenience only.
    }
  }

  return (
    <>
      <aside className={`fixed inset-y-0 left-0 z-40 hidden flex-col bg-ink transition-[width] duration-200 motion-reduce:transition-none lg:flex ${rail ? "w-[68px]" : "w-60"}`}>
        <div className={`flex h-14 shrink-0 items-center border-b border-white/10 ${rail ? "justify-center px-2" : "gap-2 px-4"}`}>
          <Link href="/admin" aria-label="SiteForge Admin, overview" className={`rounded-lg ${onDarkFocus}`}>
            {rail ? <LogoMark tone="light" /> : <Logo tone="light" size="sm" />}
          </Link>
          {!rail && (
            <>
              <span className="rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/70">Admin</span>
              <button type="button" onClick={toggle} aria-label="Collapse sidebar" title="Collapse sidebar" className={`ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-white/50 transition-colors hover:bg-white/10 hover:text-white ${onDarkFocus}`}>
                <Icon name="panel-left" size={17} />
              </button>
            </>
          )}
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto py-4 ${rail ? "px-2" : "px-3"}`}>
          <AdminNav collapsed={rail} />
        </div>
        {rail ? (
          <div className="flex shrink-0 justify-center border-t border-white/10 py-3">
            <button type="button" onClick={toggle} aria-label="Expand sidebar" title="Expand sidebar" className={`flex h-10 w-10 items-center justify-center rounded-lg text-white/60 transition-colors hover:bg-white/10 hover:text-white ${onDarkFocus}`}>
              <Icon name="panel-left" />
            </button>
          </div>
        ) : (
          <p className="shrink-0 border-t border-white/10 px-4 py-3 text-xs leading-5 text-white/50">Sensitive actions are recorded in the audit log.</p>
        )}
      </aside>

      <div className={`min-w-0 transition-[padding] duration-200 motion-reduce:transition-none ${rail ? "lg:pl-[68px]" : "lg:pl-60"}`}>{children}</div>
    </>
  );
}
