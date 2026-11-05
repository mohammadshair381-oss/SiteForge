"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface MenuLink {
  label: string;
  href: string;
}

/**
 * Mobile navigation drawer: a disclosure button that opens a modal panel with
 * search, shop, categories, pages and account links. Escape and the close
 * button dismiss it, focus moves into the panel and returns to the button.
 */
export default function MobileMenu({
  storeName,
  shopHeading,
  shopLinks,
  categoryLinks,
  pageLinks,
  account,
  buttonClass,
  panelClass,
  linkClass,
  inputClass,
  dark,
}: {
  storeName: string;
  shopHeading: string;
  shopLinks: MenuLink[];
  categoryLinks: MenuLink[];
  pageLinks: MenuLink[];
  /** Present only when customer accounts are enabled. */
  account: { signedIn: boolean; name: string | null } | null;
  buttonClass: string;
  panelClass: string;
  linkClass: string;
  inputClass: string;
  dark: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const searchId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const trigger = buttonRef.current;
    // The menu's own document (the editor renders the store inside a frame).
    const doc = trigger?.ownerDocument ?? document;
    const previous = doc.body.style.overflow;
    doc.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("input, a, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab" && panelRef.current) {
        // Keep focus inside the open drawer.
        const focusable = [...panelRef.current.querySelectorAll<HTMLElement>("a, button, input")];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    doc.addEventListener("keydown", onKey);
    return () => {
      doc.body.style.overflow = previous;
      doc.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, [open]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/storefront/account/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      window.location.assign("/");
    }
  }

  const group = (title: string, links: MenuLink[]) =>
    links.length > 0 ? (
      <div className="border-t py-3" style={{ borderColor: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)" }}>
        <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wider opacity-60">{title}</p>
        <ul>
          {links.map((link) => (
            <li key={`${title}-${link.href}`}>
              <a href={link.href} className={`block rounded-md px-1 py-2.5 text-base ${linkClass}`} onClick={() => setOpen(false)}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(true)}
        className={`inline-flex h-10 w-10 items-center justify-center rounded-md lg:hidden ${buttonClass}`}
      >
        <span className="sr-only">Open menu</span>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {/* Portalled to <body>: a sticky header with backdrop-filter would
          otherwise become the containing block and clip the fixed drawer. */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <button type="button" tabIndex={-1} aria-hidden="true" className="sf-fade absolute inset-0 h-full w-full cursor-default bg-black/50" onClick={() => setOpen(false)} />
          <div id={panelId} ref={panelRef} className={`sf-drawer absolute inset-y-0 left-0 flex w-[min(22rem,88vw)] flex-col overflow-y-auto p-5 shadow-xl ${panelClass}`}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p id={titleId} className="truncate text-lg font-semibold">{storeName}</p>
              <button type="button" onClick={() => setOpen(false)} className={`inline-flex h-10 w-10 items-center justify-center rounded-md ${buttonClass}`}>
                <span className="sr-only">Close menu</span>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <form action="/products" method="get" role="search" className="mb-3">
              <label htmlFor={searchId} className="sr-only">Search products</label>
              <input id={searchId} type="search" name="q" placeholder="Search products" className={`w-full rounded-lg px-3 py-2.5 text-base ${inputClass}`} />
            </form>
            {group(shopHeading, shopLinks)}
            {group("Categories", categoryLinks)}
            {group("Pages", pageLinks)}
            {account &&
              group(
                account.signedIn ? `Account${account.name ? ` (${account.name})` : ""}` : "Account",
                account.signedIn
                  ? [{ label: "My account", href: "/account" }, { label: "Order history", href: "/account/orders" }, { label: "Profile", href: "/account/profile" }]
                  : [{ label: "Sign in", href: "/account/login" }, { label: "Create account", href: "/account/register" }],
              )}
            {account?.signedIn && (
              <button type="button" disabled={signingOut} aria-busy={signingOut} onClick={() => void signOut()} className={`mt-1 block w-full rounded-md px-1 py-2.5 text-left text-base ${linkClass}`}>
                Sign out
              </button>
            )}
          </div>
        </div>,
        buttonRef.current?.ownerDocument.body ?? document.body,
      )}
    </>
  );
}
