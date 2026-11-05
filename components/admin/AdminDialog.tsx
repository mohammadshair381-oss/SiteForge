"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])";

/**
 * A modal for admin actions that need more than a yes (a reason, a password).
 * Render it only while open: it portals to the body so it never sits inside a
 * table cell, traps focus and restores it on close. Escape closes it unless a
 * request is running.
 */
export default function AdminDialog({
  title,
  busy = false,
  onClose,
  footer,
  children,
}: {
  title: string;
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("textarea, input, select, button")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      if (!busy) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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

  return createPortal(
    <div className="app-surface ui-fade fixed inset-0 z-[1000] flex overflow-y-auto bg-slate-950/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="ui-pop m-auto w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-left text-sm shadow-lg"
      >
        <h2 id={titleId} className="break-words text-lg font-semibold text-slate-900">
          {title}
        </h2>
        {children}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}
