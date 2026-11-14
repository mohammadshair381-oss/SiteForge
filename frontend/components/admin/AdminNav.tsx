"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Logo } from "@/components/ui/Logo";

const GROUPS: Array<{ label: string; items: Array<{ href: string; label: string; icon: string; exact?: boolean }> }> = [
  {
    label: "Platform",
    items: [
      { href: "/admin", label: "Overview", icon: "overview", exact: true },
      { href: "/admin/businesses", label: "Businesses", icon: "business" },
      { href: "/admin/users", label: "Users", icon: "users" },
      { href: "/admin/payments", label: "Payments", icon: "billing" },
      { href: "/admin/billing", label: "Subscription billing", icon: "activity" },
      { href: "/admin/domains", label: "Custom domains", icon: "globe" },
      { href: "/admin/plans", label: "Plans", icon: "layers" },
      { href: "/admin/settings", label: "Settings", icon: "settings" },
    ],
  },
  {
    label: "Oversight",
    items: [
      { href: "/admin/ai-usage", label: "AI usage", icon: "ai-builder" },
      { href: "/admin/security", label: "Security", icon: "shield" },
      { href: "/admin/audit", label: "Audit log", icon: "activity" },
    ],
  },
];

const onDarkFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft";

/** The admin sections on a dark panel: the desktop sidebar and the mobile menu show this same list. */
export default function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin sections" className="space-y-5">
      {GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-white/50">{group.label}</p>
          <ul className="mt-1.5 space-y-0.5">
            {group.items.map((item) => {
              const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors motion-reduce:transition-none ${onDarkFocus} ${
                      active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {active && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-ember" />}
                    <Icon name={item.icon} size={17} className={active ? "text-ember-soft" : "text-white/50"} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Menu button and drawer for screens below `lg`: same links, plus the way back to the dashboard. */
export function AdminMobileMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      trigger?.focus();
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("a[href], button") ?? []);
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open admin menu"
        aria-expanded={open}
        aria-controls="admin-mobile-nav"
        className={`flex h-10 w-10 items-center justify-center rounded-lg text-white hover:bg-white/10 ${onDarkFocus}`}
      >
        <Icon name="menu" size={20} />
      </button>

      {open &&
        createPortal(
          <div id="admin-mobile-nav" role="dialog" aria-modal="true" aria-label="Admin navigation" onKeyDown={onKeyDown} className="app-surface ui-fade fixed inset-0 z-[60] flex bg-slate-950/50">
            <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
            <div ref={panelRef} className="relative flex h-[100dvh] w-72 max-w-[calc(100vw-1.5rem)] flex-col bg-ink shadow-lg">
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4">
                <Logo tone="light" size="sm" />
                <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close admin menu" className={`flex h-10 w-10 items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white ${onDarkFocus}`}>
                  <Icon name="x" size={20} />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
                <AdminNav onNavigate={() => setOpen(false)} />
              </div>
              <div className="shrink-0 border-t border-white/10 p-3">
                <Link href="/dashboard" onClick={() => setOpen(false)} className={`flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-white/70 hover:bg-white/5 hover:text-white ${onDarkFocus}`}>
                  <Icon name="arrow-left" size={17} className="text-white/50" />
                  Back to dashboard
                </Link>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
