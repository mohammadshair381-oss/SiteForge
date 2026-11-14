"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Storefront customer account entry (only rendered when customer accounts
 * are enabled for the platform). Uses the EXISTING store-specific account
 * routes (/account, /account/orders, /account/profile, /account/login) and logout API; it never
 * links to the platform (dashboard) login.
 *
 * - Guest: a "Sign in" link.
 * - Signed in (verified or not): a disclosure menu with My account, Order
 *   history, Profile and Sign out. Session state comes from the server on every page
 *   load, so an expired or revoked session simply shows the guest state.
 */
export default function AccountMenu({
  signedInName,
  signedIn,
  preview = false,
  className,
  panelClassName,
  linkClassName,
}: {
  signedInName: string | null;
  signedIn: boolean;
  preview?: boolean;
  className: string;
  panelClassName: string;
  linkClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    // The menu's own document (the editor renders the store inside a frame).
    const doc = rootRef.current?.ownerDocument ?? document;
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("mousedown", onPointer);
    return () => {
      doc.removeEventListener("keydown", onKey);
      doc.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const icon = (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );

  if (!signedIn) {
    return (
      <a href="/account/login" className={`inline-flex h-10 items-center gap-2 rounded-md px-2 ${className}`}>
        {icon}
        <span className="hidden text-sm font-medium lg:inline">Sign in</span>
        <span className="sr-only lg:hidden">Sign in to your account</span>
      </a>
    );
  }

  async function signOut() {
    if (preview || signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/storefront/account/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    } finally {
      // The server cleared the cookie (or the session was already gone).
      window.location.assign("/");
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-10 items-center gap-2 rounded-md px-2 ${className}`}
      >
        {icon}
        <span className="hidden text-sm font-medium lg:inline">{signedInName ? `Hi, ${signedInName}` : "Account"}</span>
        <span className="sr-only lg:hidden">Your account</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="hidden lg:block">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={menuId} className={`absolute right-0 top-full z-50 mt-2 w-56 rounded-xl p-1.5 shadow-xl ring-1 ring-black/10 ${panelClassName}`}>
          <a href="/account" className={`block rounded-lg px-3 py-2 text-sm ${linkClassName}`}>My account</a>
          <a href="/account/orders" className={`block rounded-lg px-3 py-2 text-sm ${linkClassName}`}>Order history</a>
          <a href="/account/profile" className={`block rounded-lg px-3 py-2 text-sm ${linkClassName}`}>Profile</a>
          <button type="button" onClick={() => void signOut()} disabled={signingOut} className={`block w-full rounded-lg px-3 py-2 text-left text-sm disabled:opacity-60 ${linkClassName}`}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
