"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Icon } from "@/components/ui/Icon";
import { buttonClass } from "@/components/ui/Button";

const NAV_LINKS = [
  { href: "/#build", label: "Product" },
  { href: "/themes", label: "Themes" },
  { href: "/pricing", label: "Pricing" },
] as const;

const focusLight = "rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-soft focus-visible:ring-offset-2 focus-visible:ring-offset-ink";

export default function SiteHeader({ authed = false }: { authed?: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-ink text-white">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6">
        <Link href="/" aria-label="SiteForge home" className={focusLight}>
          <Logo tone="light" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-7 text-sm font-medium text-white/70 md:flex">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={`transition-colors hover:text-white ${focusLight}`}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-5 text-sm md:flex">
          {authed ? (
            <Link href="/dashboard" className={buttonClass({ variant: "invert" })}>
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className={`font-medium text-white/70 transition-colors hover:text-white ${focusLight}`}>
                Log in
              </Link>
              <Link href="/register" className={buttonClass({ variant: "invert" })}>
                Start free
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={open}
          aria-controls="mobile-menu"
          className={`flex h-11 w-11 items-center justify-center rounded-lg text-white hover:bg-white/10 md:hidden ${focusLight}`}
        >
          <Icon name={open ? "x" : "menu"} size={20} />
        </button>
      </div>

      {open && (
        <div id="mobile-menu" className="ui-fade border-t border-white/10 px-4 pb-5 pt-2 md:hidden">
          <nav aria-label="Mobile" className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className={`rounded-lg px-3 py-2.5 text-sm font-medium text-white/80 hover:bg-white/10 ${focusLight}`}>
                {link.label}
              </Link>
            ))}
            {authed ? (
              <Link href="/dashboard" onClick={() => setOpen(false)} className={buttonClass({ variant: "invert", block: true, className: "mt-3" })}>
                Dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" onClick={() => setOpen(false)} className={`rounded-lg px-3 py-2.5 text-sm font-medium text-white/80 hover:bg-white/10 ${focusLight}`}>
                  Log in
                </Link>
                <Link href="/register" onClick={() => setOpen(false)} className={buttonClass({ variant: "invert", block: true, className: "mt-2" })}>
                  Start free
                </Link>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}
