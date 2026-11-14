"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import DashboardNav, { type NavBusiness } from "./DashboardNav";
import LogoutButton from "./LogoutButton";
import { Logo } from "@/components/ui/Logo";
import { Icon } from "@/components/ui/Icon";

export default function MobileNav({
  businesses,
  isSuperAdmin,
  userName,
  userEmail,
}: {
  businesses: NavBusiness[];
  isSuperAdmin: boolean;
  userName: string;
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open || !mounted) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const triggerElement = triggerButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      triggerElement?.focus();
      if (!triggerElement?.isConnected) previousFocus?.focus();
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, mounted]);

  return (
    <div className="lg:hidden">
      <button
        ref={triggerButtonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mobile-nav"
        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        <Icon name="menu" size={20} />
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            id="mobile-nav"
            className="ui-fade fixed inset-0 z-[60] flex min-h-[100dvh] overflow-hidden bg-slate-950/45"
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard navigation"
          >
            <button
              type="button"
              className="absolute inset-0 cursor-default"
              onClick={() => setOpen(false)}
              aria-label="Close navigation menu"
            />
            <div
              className="relative z-10 flex h-[100dvh] w-72 max-w-[calc(100vw-1.5rem)] isolate flex-col overflow-hidden border-r border-slate-200 bg-white shadow-2xl"
              style={{
                paddingTop: "max(1rem, env(safe-area-inset-top))",
                paddingRight: "max(1rem, env(safe-area-inset-right))",
                paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
                paddingLeft: "max(1rem, env(safe-area-inset-left))",
              }}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-slate-100 pb-3">
                <Link
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  aria-label="SiteForge, all businesses"
                  className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  <Logo size="sm" />
                </Link>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation menu"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  <Icon name="x" size={20} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
                <DashboardNav
                  businesses={businesses}
                  isSuperAdmin={isSuperAdmin}
                  onNavigate={() => setOpen(false)}
                />
              </div>

              <div className="mt-2 shrink-0 border-t border-slate-200 pt-3">
                <p className="truncate text-sm font-medium text-slate-900">{userName}</p>
                <p className="truncate text-xs text-slate-500">{userEmail}</p>
                <div className="mt-2 min-h-11 content-center">
                  <LogoutButton />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
