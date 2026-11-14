"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  logoutDialogReducer,
  runLogoutOnce,
} from "@/lib/logout-confirmation";

export default function LogoutButton() {
  const router = useRouter();
  const titleId = useId();
  const messageId = useId();
  const [dialogState, dispatch] = useReducer(logoutDialogReducer, "closed");
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const isOpen = dialogState !== "closed";
  const isSubmitting = dialogState === "submitting";

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen || !mounted) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const triggerElement = triggerButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !inFlightRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dispatch("ESCAPE");
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      triggerElement?.focus();
      if (!triggerElement?.isConnected) previousFocus?.focus();
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, mounted]);

  function trapTab(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function confirmLogout() {
    if (inFlightRef.current || dialogState !== "open") return;
    setError(null);
    dispatch("CONFIRM");
    try {
      await runLogoutOnce(
        inFlightRef,
        async () => {
          await fetch("/api/auth/logout", { method: "POST" });
        },
        () => {
          router.push("/login");
          router.refresh();
        },
      );
      dispatch("COMPLETE");
    } catch {
      setError("Unable to sign out. Please try again.");
      dispatch("FAILURE");
    }
  }

  return (
    <>
      <button
        ref={triggerButtonRef}
        type="button"
        onClick={() => {
          setError(null);
          dispatch("OPEN");
        }}
        aria-haspopup="dialog"
        className="rounded text-xs font-medium text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        Sign Out
      </button>
      {isOpen &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-slate-950/60 px-4 py-4 backdrop-blur-sm"
            style={{
              paddingTop: "max(1rem, env(safe-area-inset-top))",
              paddingRight: "max(1rem, env(safe-area-inset-right))",
              paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
            }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !inFlightRef.current) {
                dispatch("BACKDROP");
              }
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={messageId}
              onKeyDown={trapTab}
              className="ui-pop max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-lg sm:p-6"
            >
              <h2 id={titleId} className="text-lg font-bold text-slate-900">
                Sign out?
              </h2>
              <p id={messageId} className="mt-2 text-sm leading-6 text-slate-600">
                Are you sure you want to sign out of your account?
              </p>
              {error && (
                <p role="alert" className="mt-3 text-sm text-red-700">
                  {error}
                </p>
              )}
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  ref={cancelButtonRef}
                  type="button"
                  onClick={() => dispatch("CANCEL")}
                  disabled={isSubmitting}
                  className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmLogout}
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  className="min-h-11 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSubmitting ? "Signing out…" : "Sign Out"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
