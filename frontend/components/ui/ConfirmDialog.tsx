"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buttonClass } from "./Button";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get a red confirm button. */
  tone?: "default" | "danger";
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };
/** Mounted hosts; the most recent one shows the dialog. */
const hosts: Array<(request: Request) => void> = [];

/**
 * Asks the person to confirm an action; resolves true only on an explicit
 * confirm. Needs <ConfirmHost /> on the page (dashboard and admin layouts, and
 * the shopper order pages); without one it falls back to the browser's own
 * dialog, so an action is never carried out unconfirmed.
 */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const request = typeof options === "string" ? { message: options } : options;
  const host = hosts[hosts.length - 1];
  if (!host) return Promise.resolve(window.confirm(request.message));
  return new Promise((resolve) => host({ ...request, resolve }));
}

/**
 * `inline` renders in place instead of on the document body: on a shopper's
 * store the dialog then inherits the theme's font. It carries no platform
 * branding there (.app-surface is absent, so the neutral tokens apply).
 */
export function ConfirmHost({ inline = false }: { inline?: boolean }) {
  const [request, setRequest] = useState<Request | null>(null);
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hosts.push(setRequest);
    return () => {
      hosts.splice(hosts.indexOf(setRequest), 1);
    };
  }, []);

  const open = request !== null;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  function finish(ok: boolean) {
    request?.resolve(ok);
    setRequest(null);
  }

  if (!request) return null;
  const danger = request.tone === "danger";
  const title = request.title ?? "Are you sure?";

  const dialog = (
    <div className="ui-fade fixed inset-0 z-[2000] flex items-center justify-center overflow-y-auto bg-slate-950/50 p-4 backdrop-blur-[2px]">
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default" onClick={() => finish(false)} />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={(event) => {
          // Stops here: a dialog underneath (editor drawer, theme preview) must not also close.
          event.stopPropagation();
          if (event.key === "Escape") finish(false);
          if (event.key === "Tab") {
            const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
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
        }}
        className="ui-pop relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-lg"
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          {title}
        </h2>
        <p id={messageId} className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">
          {request.message}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={() => finish(false)} className={buttonClass({ variant: "secondary" })}>
            {request.cancelLabel ?? "Cancel"}
          </button>
          <button type="button" onClick={() => finish(true)} className={buttonClass({ variant: danger ? "danger" : "primary" })}>
            {request.confirmLabel ?? "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
  return inline ? dialog : createPortal(dialog, document.body);
}
